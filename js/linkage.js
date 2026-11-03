// linkage.js — which stages feed which (the same inputs the pipeline sends to the model), and which stages are out of
// date because something upstream changed since they were last made or edited. Every write of a stage records the
// versions of its upstream stages (`stage.basis`); a generated stage without one falls back to its provenance (the
// input versions of its last run). Nothing is rewritten automatically: the Workspace lists the stages and drafts a
// targeted update on request. No browser or Node APIs (the tests use it).
import { diffLines, hunkRows } from './diff.js';

const F_ORDER = ['objectives', 'learners', 'resources', 'syllabus', 'assessment_plan', 'final_project'];
const F_NAME = { objectives: 'Instructional Goals Definition', learners: 'Learner Analysis', resources: 'Resource & Constraints Assessment', syllabus: 'Syllabus & Learning Objectives Design', assessment_plan: 'Assessment & Evaluation Planning', final_project: 'Final Project Assessment Design' };
const C_NAME = { outline: 'Slides outline', slides: 'Slides', script: 'Lecture script', homework: 'Homework', lab: 'Lab', quiz: 'Quiz', storyboard: 'Storyboard', video: 'Lecture video' };
const C_DEPS = { outline: ['f:objectives', 'f:syllabus'], slides: ['f:objectives', 'c:outline'], script: ['c:slides'], homework: ['f:assessment_plan', 'c:slides'], quiz: ['f:assessment_plan', 'c:slides'], lab: ['f:resources', 'c:slides'], storyboard: ['c:slides', 'c:script'], video: ['c:slides', 'c:script', 'c:storyboard'] };

/** The stage object behind a key ('foundation.x', 'chaptersStage', 'chapters.<id>.<stage>', 'exams.x'). */
export function stageOf(p, key) {
  const [a, b, c] = String(key).split('.');
  if (a === 'foundation') return p.foundation?.[b];
  if (a === 'chaptersStage') return p.chaptersStage;
  if (a === 'exams') return p.exams?.[b];
  if (a === 'chapters') return p.chapters?.find(x => x.id === b)?.stages?.[c];
  return undefined;
}
/** Every stage key of the project. */
export function stageKeys(p) {
  const out = [];
  for (const id of Object.keys(p.foundation || {})) out.push(`foundation.${id}`);
  if (p.chaptersStage) out.push('chaptersStage');
  for (const ch of p.chapters || []) for (const id of Object.keys(ch.stages || {})) out.push(`chapters.${ch.id}.${id}`);
  for (const id of Object.keys(p.exams || {})) out.push(`exams.${id}`);
  return out;
}
/** The key of a stage object (it is found by identity). */
export function keyOfStage(p, stage) { return stageKeys(p).find(k => stageOf(p, k) === stage) || null; }

/** The stages a stage is made from: [{ key, label }] (label: the pipeline's input label, as in provenance). */
export function upstreamOf(p, key) {
  const [a, b, c] = String(key).split('.');
  const f = id => ({ key: `foundation.${id}`, label: F_NAME[id] });
  if (a === 'foundation') { const i = F_ORDER.indexOf(b); return i > 0 ? F_ORDER.slice(0, i).map(f) : []; }
  if (a === 'chaptersStage') return [{ key: 'foundation.syllabus', label: 'Syllabus' }];
  if (a === 'exams') return ['syllabus', 'assessment_plan', ...(b === 'final' ? ['final_project'] : [])].map(f);
  if (a === 'chapters') return (C_DEPS[c] || []).map(d => d.startsWith('f:') ? f(d.slice(2)) : { key: `chapters.${b}.${d.slice(2)}`, label: C_NAME[d.slice(2)] });
  return [];
}
/** The stages made from this one. */
export function downstreamOf(p, key) { return stageKeys(p).filter(k => upstreamOf(p, k).some(u => u.key === key)); }

const made = st => st && typeof st === 'object' && st.status === 'done' && !!st.output;
/** Upstream versions now: { key: version } (stages with content only). */
export function basisFor(p, key) {
  const out = {};
  for (const u of upstreamOf(p, key)) { const st = stageOf(p, u.key); if (made(st)) out[u.key] = st.version || 0; }
  return out;
}
/** Record what a stage was made or edited from (called on every write of a stage). */
export function stamp(p, stage) {
  const key = keyOfStage(p, stage); if (!key) return;
  const b = basisFor(p, key); if (Object.keys(b).length) stage.basis = b; else delete stage.basis;
}

/** What changed upstream since the stage was last made or edited: [{ key, label, from, to }] (from: the version it was
 *  made from, null when unknown). Empty when up to date, or when nothing says what it was made from. */
export function changedUpstream(p, key) {
  const st = stageOf(p, key); if (!made(st)) return [];
  const prov = new Map((st.provenance || []).filter(x => x && x.label).map(x => [x.label, x]));
  const out = [];
  for (const u of upstreamOf(p, key)) {
    const up = stageOf(p, u.key); if (!made(up)) continue;
    const now = up.version || 0;
    if (st.basis && u.key in st.basis) { if (now > st.basis[u.key]) out.push({ ...u, from: st.basis[u.key], to: now }); continue; }
    if (st.basis) continue; // made or edited before this input existed: not a change of it
    const pv = prov.get(u.label) || (u.key === 'foundation.syllabus' && key === 'chaptersStage' ? prov.get('Syllabus') : null);
    if (pv && Number.isInteger(pv.version) && now > pv.version) out.push({ ...u, from: pv.version, to: now });
  }
  return out;
}
/** Every out-of-date stage: [{ key, changes }]. stale(key): the pipeline's own input check (inputs hash). */
export function outOfDate(p, stale = () => false) {
  const out = [];
  for (const key of stageKeys(p)) {
    const changes = changedUpstream(p, key);
    if (changes.length || stale(key)) out.push({ key, changes });
  }
  return out;
}

/** A stage output as reviewable text: decks as their slide text, Word stages as their Markdown. */
export function textOf(output) {
  if (typeof output !== 'string') return '';
  if (output.startsWith('{')) {
    let m = null; try { m = JSON.parse(output); } catch { /* text */ }
    if (m?.format === 'pptx' && Array.isArray(m.slides)) return slidesText(m.slides);
    if (m?.format === 'docx') return String(m.text || '');
  }
  return output;
}
export const slidesText = slides => slides.map(s => `Slide ${s.slide_id}: ${s.title}${(s.bullets || []).map(b => `\n- ${b}`).join('')}${s.notes ? `\nNotes: ${s.notes}` : ''}`).join('\n\n');

/** A unified diff of two texts (hunks with two lines of context), capped. */
export function unifiedDiff(a, b, max = 8000) {
  const hunks = diffLines(a, b); if (!hunks.length) return '';
  let out = '';
  for (const h of hunks) { out += `@@ line ${h.a + 1}\n${hunkRows(a, h).map(r => `${r.kind}${r.text}`).join('\n')}\n`; if (out.length > max) return `${out.slice(0, max)}\n… (diff truncated)`; }
  return out;
}

/** What changed upstream of `key`, as text for the agent: one section per changed stage (its diff since the version
 *  the stage was made from when that version is still in the history, else its current text). */
export function upstreamChanges(p, key, { label = k => k } = {}) {
  return changedUpstream(p, key).map(c => {
    const up = stageOf(p, c.key); const now = textOf(up.output);
    const old = c.from == null ? null : (up.history || []).find(h => h.version === c.from);
    const body = old ? unifiedDiff(textOf(old.output), now) || '(no text change)' : `(version ${c.from ?? '?'} is no longer kept; current text)\n${now.slice(0, 6000)}`;
    return { ...c, name: label(c.key), text: body };
  });
}
