// fs/merge.js — three-way merge of a project, unit by unit (each stage, each top-level field, the chapter list, the
// audit trail). Used when the folder changed on disk (another editor, an agent) while the browser held its own edits:
// a unit the browser did not touch takes the disk version; a unit both changed keeps the browser's.
const STAGE_GROUPS = ['foundation', 'exams'];
const SKIP = new Set(['foundation', 'exams', 'chaptersStage', 'chapters', 'audit', 'updatedAt']);
const J = v => v === undefined ? undefined : JSON.stringify(v);

/** key → value for every unit of a project. */
export function units(p) {
  const u = new Map();
  for (const [k, v] of Object.entries(p || {})) if (!SKIP.has(k)) u.set(`top.${k}`, v);
  for (const g of STAGE_GROUPS) for (const [id, st] of Object.entries(p?.[g] || {})) u.set(`${g}.${id}`, st);
  if (p && 'chaptersStage' in p) u.set('chaptersStage', p.chaptersStage);
  u.set('chapterList', (p?.chapters || []).map(({ stages, ...c }) => c));
  for (const ch of p?.chapters || []) for (const [id, st] of Object.entries(ch.stages || {})) u.set(`chapters.${ch.id}.${id}`, st);
  return u;
}

function setUnit(p, key, v) {
  const [a, b, c] = key.split('.');
  if (a === 'top') { if (v === undefined) delete p[b]; else p[b] = v; return; }
  if (a === 'chaptersStage') { if (v === undefined) delete p.chaptersStage; else p.chaptersStage = v; return; }
  if (STAGE_GROUPS.includes(a)) { p[a] ||= {}; if (v === undefined) delete p[a][b]; else p[a][b] = v; return; }
  if (a === 'chapters') { const ch = p.chapters?.find(x => x.id === b); if (!ch) return; ch.stages ||= {}; if (v === undefined) delete ch.stages[c]; else ch.stages[c] = v; }
}

/** The chapter list in `list` order, reusing the chapter objects (and their stages) already in p. */
function setChapterList(p, list, stagesFrom) {
  const byId = new Map((p.chapters || []).map(c => [c.id, c]));
  const next = list.map(c => {
    const ch = byId.get(c.id) || { stages: JSON.parse(JSON.stringify(stagesFrom.get(c.id) || {})) };
    for (const k of Object.keys(ch)) if (k !== 'stages' && !(k in c)) delete ch[k];
    return Object.assign(ch, c);
  });
  p.chapters ||= []; p.chapters.splice(0, p.chapters.length, ...next);
}

/** base, theirs (disk), ours (browser) → merged project (a new object). */
export function merge3(base, theirs, ours) {
  const out = JSON.parse(JSON.stringify(ours));
  const ub = units(base), ut = units(theirs), uo = units(ours);
  const theirStages = new Map((theirs.chapters || []).map(c => [c.id, c.stages]));
  if (J(uo.get('chapterList')) === J(ub.get('chapterList')) && J(ut.get('chapterList')) !== J(ub.get('chapterList'))) setChapterList(out, ut.get('chapterList'), theirStages);
  for (const key of new Set([...ub.keys(), ...ut.keys(), ...uo.keys()])) {
    if (key === 'chapterList') continue;
    const b = J(ub.get(key)), t = J(ut.get(key)), o = J(uo.get(key));
    if (o === b && t !== b) setUnit(out, key, t === undefined ? undefined : JSON.parse(t));
  }
  // audit: ours, plus the entries the disk added since base, renumbered after ours
  const nb = (base.audit || []).length, extra = (theirs.audit || []).slice(nb);
  if (extra.length) { out.audit ||= []; let id = out.audit.at(-1)?.id || 0; for (const e of extra) out.audit.push({ ...e, id: ++id }); }
  if ((theirs.updatedAt || '') > (out.updatedAt || '')) out.updatedAt = theirs.updatedAt;
  return out;
}

/** Make `target` (the live project the views hold) equal to `source`, in place: stage objects and chapters keep their
 *  identity so a running pipeline still writes into the right stage. `only`: limit to these unit keys ('chapterList' and
 *  'audit' included). Returns the number of units changed. */
export function adoptInPlace(target, source, only = null) {
  const ut = units(target), us = units(source); let n = 0;
  const want = k => !only || only.has(k);
  const srcStages = new Map((source.chapters || []).map(c => [c.id, c.stages]));
  if (want('chapterList') && J(ut.get('chapterList')) !== J(us.get('chapterList'))) { setChapterList(target, us.get('chapterList'), srcStages); n++; }
  for (const key of new Set([...ut.keys(), ...us.keys()])) {
    if (key === 'chapterList' || !want(key)) continue;
    const a = ut.get(key), b = us.get(key); if (J(a) === J(b)) continue; n++;
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!key.startsWith('top.') && isObj(a) && isObj(b)) { for (const k of Object.keys(a)) if (!(k in b)) delete a[k]; Object.assign(a, JSON.parse(J(b))); }
    else setUnit(target, key, b === undefined ? undefined : JSON.parse(J(b)));
  }
  if (want('audit') && J(target.audit) !== J(source.audit)) { target.audit ||= []; target.audit.splice(0, target.audit.length, ...JSON.parse(J(source.audit || []))); n++; }
  if (source.updatedAt && source.updatedAt !== target.updatedAt) target.updatedAt = source.updatedAt;
  return n;
}

/** Unit keys whose value differs between two projects ('chapterList' and 'audit' included). */
export function changedUnits(a, b) {
  const ua = units(a), ub = units(b), out = new Set();
  for (const k of new Set([...ua.keys(), ...ub.keys()])) if (J(ua.get(k)) !== J(ub.get(k))) out.add(k);
  if (J(a.audit) !== J(b.audit)) out.add('audit');
  return out;
}
