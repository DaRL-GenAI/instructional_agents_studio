// fs/serialize.js — project ⇄ folder. Every stage output becomes a readable file (design/*.md, chapters/NN-slug/*.md|json,
// exams/*.md, the deck as chapters/NN-slug/slides.pptx); everything else a stage carries goes to .studio/meta.json
// (status, versions, hashes) and .studio/stages/<key>.json (prompt, transcript, history). The audit trail is
// .studio/audit.jsonl. No browser or Node APIs: the local server runs it, tests run it.
//
// Round trip: deserialize(serialize(p)) deep-equals JSON.parse(JSON.stringify(p)) (undefined fields drop, as on the wire).

export const FORMAT = 'instructional-agents';
export const META = '.studio/meta.json';
const AUDIT = '.studio/audit.jsonl', TEXTBOOK = '.studio/textbook.json', COURSE = 'course.json';
const FOUNDATION_FILES = { objectives: 'learning_objectives', learners: 'learner_analysis', resources: 'resource_assessment', syllabus: 'syllabus', assessment_plan: 'assessment_plan', final_project: 'final_project' };
const EXAM_FILES = { midterm: 'midterm_exam', final: 'final_exam' };
const INLINE = new Set(['slides', 'video']); // outputs that are manifests of a binary, kept in the sidecar
const SIDE = ['prompt', 'transcript', 'history'];
const OWN = new Set(['course', 'textbook', 'audit', 'foundation', 'chaptersStage', 'chapters', 'exams']);

/** Same fingerprint as llm.js sha1Short (FNV-1a), so hashes written here match the app's. */
export function fnv(text) { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

export function slugify(s, max = 40) { return String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, ''); }
export const chapterDir = (ch, i) => `chapters/${String(i + 1).padStart(2, '0')}-${slugify(ch.title) || ch.id}`;
const isJsonText = t => { const s = t.trim(); if (!/^[[{]/.test(s)) return false; try { JSON.parse(s); return true; } catch { return false; } };
const json = v => JSON.stringify(v, null, 2) + '\n';
const deckSha = output => { try { const m = JSON.parse(output); return m && m.format === 'pptx' && m.sha ? m.sha : null; } catch { return null; } };

/** The stages of a project with their key, output file base and where they live. */
function* stagesOf(p) {
  for (const [id, st] of Object.entries(p.foundation || {})) yield { key: `foundation.${id}`, st, base: `design/${FOUNDATION_FILES[id] || slugify(id) || id}`, set: v => { p.foundation[id] = v; } };
  if ('chaptersStage' in p) yield { key: 'chaptersStage', st: p.chaptersStage, base: 'design/chapters', set: v => { p.chaptersStage = v; } };
  for (const [id, st] of Object.entries(p.exams || {})) yield { key: `exams.${id}`, st, base: `exams/${EXAM_FILES[id] || slugify(id) || id}`, set: v => { p.exams[id] = v; } };
  for (const [i, ch] of (p.chapters || []).entries()) for (const [id, st] of Object.entries(ch.stages || {})) yield { key: `chapters.${ch.id}.${id}`, st, base: `${chapterDir(ch, i)}/${id}`, inline: INLINE.has(id), chapter: ch, stageId: id };
}

/** project → { files: {path: text}, decks: {path: {chapterId, sha}} } — the managed files of the folder. */
export function serialize(project) {
  const p = JSON.parse(JSON.stringify(project));
  const files = {}, decks = {}, stages = {};
  for (const { key, st, base, inline, chapter, stageId } of stagesOf(p)) {
    if (!st || typeof st !== 'object' || Array.isArray(st)) { stages[key] = { raw: st === undefined ? null : st }; continue; }
    const m = {}, side = {};
    for (const [k, v] of Object.entries(st)) if (k !== 'output' && !SIDE.includes(k)) m[k] = v;
    for (const k of SIDE) if (k in st) side[k] = st[k];
    if ('output' in st) {
      const out = st.output;
      if (typeof out !== 'string' || inline) side.output = out;
      else if (out === '') m.$empty = true;
      else { const f = base + (isJsonText(out) ? '.json' : '.md'); files[f] = out; m.$file = f; m.$hash = fnv(out); }
    }
    if (stageId === 'slides') { const sha = deckSha(st.output); if (sha) { const f = `${base}.pptx`; decks[f] = { chapterId: chapter.id, sha }; m.$deck = f; } }
    if (Object.keys(side).length) { const f = `.studio/stages/${key}.json`; files[f] = json(side); m.$side = f; }
    stages[key] = m;
  }
  const rest = {}; for (const [k, v] of Object.entries(p)) if (!OWN.has(k)) rest[k] = v;
  const meta = {
    format: FORMAT, version: 1, project: rest,
    has: [...OWN].filter(k => k in p),
    foundation: Object.keys(p.foundation || {}), exams: Object.keys(p.exams || {}),
    chapters: (p.chapters || []).map((ch, i) => { const { stages: s, ...c } = ch; return { ...c, $dir: chapterDir(ch, i), $stages: Object.keys(s || {}), ...(s ? {} : { $noStages: true }) }; }),
    stages,
  };
  if ('course' in p) files[COURSE] = json(p.course);
  if ('textbook' in p) files[TEXTBOOK] = json(p.textbook);
  if ('audit' in p) files[AUDIT] = (p.audit || []).map(e => JSON.stringify(e) + '\n').join('');
  meta.files = Object.keys(files).concat(Object.keys(decks)).sort();
  files[META] = json(meta);
  return { files, decks, meta };
}

/** read(path) → text or null. Returns the project; `light` skips the sidecars (prompt, transcript, history). */
export function deserialize(read, { light = false } = {}) {
  const metaText = read(META); if (metaText == null) throw new Error('Not an Instructional Agents project (no .studio/meta.json)');
  const meta = JSON.parse(metaText); if (meta.format !== FORMAT) throw new Error('Unknown project format');
  const p = { ...meta.project };
  const has = new Set(meta.has || []);
  const readJson = (f, fallback) => { const t = read(f); return t == null ? fallback : JSON.parse(t); };
  if (has.has('course')) p.course = readJson(COURSE, {});
  if (has.has('textbook')) p.textbook = readJson(TEXTBOOK, { name: '', chars: 0, chunks: [] });
  if (has.has('audit')) p.audit = (read(AUDIT) || '').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const stage = key => {
    const m = meta.stages?.[key]; if (!m) return undefined;
    if ('raw' in m) return m.raw;
    const st = {}; let side = {};
    if (m.$side && !light) side = readJson(m.$side, {});
    for (const [k, v] of Object.entries(m)) if (!k.startsWith('$')) st[k] = v;
    for (const k of SIDE) if (k in side) st[k] = side[k];
    if ('output' in side) st.output = side.output;
    else if (m.$empty) st.output = '';
    else if (m.$file) st.output = read(m.$file) ?? '';
    else if (light && m.$side && INLINE.has(key.split('.').pop())) st.output = '';
    return st;
  };
  if (has.has('foundation')) { p.foundation = {}; for (const id of meta.foundation || []) p.foundation[id] = stage(`foundation.${id}`); }
  if (has.has('chaptersStage')) p.chaptersStage = stage('chaptersStage');
  if (has.has('exams')) { p.exams = {}; for (const id of meta.exams || []) p.exams[id] = stage(`exams.${id}`); }
  if (has.has('chapters')) p.chapters = (meta.chapters || []).map(c => {
    const { $dir, $stages, $noStages, ...ch } = c;
    if (!$noStages) { ch.stages = {}; for (const id of $stages || []) ch.stages[id] = stage(`chapters.${ch.id}.${id}`); }
    return ch;
  });
  // key order as in a fresh project, so a deep-equal against the original also matches when printed
  const order = ['schema', 'id', 'name', 'createdAt', 'updatedAt', 'course', 'textbook', 'overrides', 'deck', 'foundation', 'chaptersStage', 'chapters', 'exams', 'audit'];
  const out = {}; for (const k of order) if (k in p) out[k] = p[k]; for (const k of Object.keys(p)) if (!(k in out)) out[k] = p[k];
  return out;
}

/** Which stage a managed output file belongs to: { key, chapterId?, stageId, kind: 'text'|'deck' } or null. */
export function fileOwner(meta, path) {
  for (const [key, m] of Object.entries(meta.stages || {})) {
    if (m.$file === path) return { key, kind: 'text' };
    if (m.$deck === path) return { key, kind: 'deck', chapterId: key.split('.')[1] };
  }
  return null;
}

/** A stage by its serialize key. */
export function stageAt(p, key) {
  const [a, b, c] = key.split('.');
  if (a === 'foundation') return p.foundation?.[b];
  if (a === 'exams') return p.exams?.[b];
  if (a === 'chaptersStage') return p.chaptersStage;
  if (a === 'chapters') return p.chapters?.find(ch => ch.id === b)?.stages?.[c];
  return null;
}
