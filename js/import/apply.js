// import/apply.js — confirmed import rows → stages, through the project store so every stage keeps its version,
// history and audit trail: a .pptx becomes the chapter's slides (commitDeck), a .docx homework or lab stays a Word
// document (commitDoc), everything else becomes the stage's text (Markdown; a PDF's extracted text). Each stage
// remembers where it came from (origin 'import', sourcePath). Missing chapters are created first, and the chapter
// list (design/chapters.json) follows. The caller holds the store, so all of it is written as one commit.
import { commitDeck, deckManifest } from '../pptxdeck.js';
import { commitDoc, docManifest, outputText, CONVERTIBLE } from '../docstage.js';
import { stageAt } from '../fs/serialize.js';
import { emptyStage } from '../model.js';
import { CHAPTER_KINDS, KIND_LABEL } from './classify.js';
import { pdfText, deckText } from './extract.js';

const COURSE_KEY = { syllabus: 'foundation.syllabus', objectives: 'foundation.objectives', exam_midterm: 'exams.midterm', exam_final: 'exams.final' };
const STAGE_NAME = { outline: 'Slides outline', slides: 'Slides', script: 'Lecture script', homework: 'Homework', lab: 'Lab', quiz: 'Quiz', syllabus: 'Syllabus', objectives: 'Instructional Goals Definition', midterm: 'Midterm exam', final: 'Final exam' };

/** The stage key a row goes to (chapter: an id; new chapters are resolved by the caller), or null (reference, ignore). */
export function targetKey(row, chapterId = row.chapter) {
  if (row.action === 'version' && row.version?.key) return row.version.key;
  if (COURSE_KEY[row.kind]) return COURSE_KEY[row.kind];
  if (CHAPTER_KINDS.has(row.kind) && chapterId && !String(chapterId).startsWith('new:')) return `chapters.${chapterId}.${row.kind}`;
  return null;
}

/** The text a stage shows (also for decks and Word stages), used to compare a new file against it. */
export function stageText(st) {
  const d = deckManifest(st?.output); if (d) return deckText(d.slides);
  return outputText(st?.output || '') || '';
}

/** Stages that came from a file: [{ key, label, sourcePath, text }] (the candidates for "new version of X"). */
export function importedStages(project) {
  const out = []; const add = (key, label, st) => { if (st && typeof st === 'object' && st.sourcePath && st.output) out.push({ key, label, sourcePath: st.sourcePath, text: stageText(st) }); };
  for (const [id, st] of Object.entries(project.foundation || {})) add(`foundation.${id}`, STAGE_NAME[id] || id, st);
  for (const [id, st] of Object.entries(project.exams || {})) add(`exams.${id}`, STAGE_NAME[id] || id, st);
  for (const ch of project.chapters || []) for (const [id, st] of Object.entries(ch.stages || {})) add(`chapters.${ch.id}.${id}`, `${ch.title} / ${STAGE_NAME[id] || id}`, st);
  return out;
}

const quizText = t => { const s = String(t || '').trim(); if (/^\[/.test(s)) { try { if (Array.isArray(JSON.parse(s))) return JSON.stringify(JSON.parse(s), null, 2); } catch { /* not JSON: keep the text */ } } return t; };

/**
 * rows: [{ path (the file under sources/), name, ext, kind, chapter ('' | id | 'new:<title>'), action ('new'|'version'),
 *   version?: { key }, text, blob }] (only the rows to apply). newChapters: ['new:<title>', …] in order.
 * Returns { stages: [{ key, label, path }], chapters: [ids created], skipped: [{ path, why }] }.
 */
export async function applyImport(store, rows, { newChapters = [] } = {}) {
  const p = store.project; const now = new Date().toISOString();
  const created = new Map(); const madeIds = [];
  // 1. chapters the rows need, in the proposed order
  const wanted = new Set(rows.filter(r => r.action !== 'version' && CHAPTER_KINDS.has(r.kind) && String(r.chapter).startsWith('new:')).map(r => r.chapter));
  for (const ref of [...newChapters.filter(r => wanted.has(r)), ...[...wanted].filter(r => !newChapters.includes(r))]) {
    const id = store.addChapter({ title: ref.slice(4).trim() || 'Untitled chapter', description: '' }); created.set(ref, id); madeIds.push(id);
  }
  if (madeIds.length) {
    const st = p.chaptersStage || (p.chaptersStage = emptyStage());
    const list = JSON.stringify(p.chapters.map(c => ({ title: c.title, description: c.description || '' })), null, 2);
    const fresh = !st.output;
    store.userEdit(st, 'Chapter extraction', list, 'course');
    if (fresh) { st.origin = 'import'; st.ranAt = now; if (st.history.at(-1)?.output === '') st.history.pop(); }
    store.log({ type: 'import', stage: 'Chapter extraction', where: 'course', note: `${madeIds.length} chapter${madeIds.length > 1 ? 's' : ''} added by import` });
  }
  // 2. each file into its stage
  const stages = [], skipped = [];
  for (const row of rows) {
    const key = targetKey(row, created.get(row.chapter) || row.chapter);
    if (!key) { if (row.kind !== 'reference' && row.kind !== 'ignore') skipped.push({ path: row.path, why: 'no chapter' }); continue; }
    try { const label = await put(store, key, row); stages.push({ key, label, path: row.path }); }
    catch (e) { skipped.push({ path: row.path, why: e.message }); }
  }
  return { stages, chapters: madeIds, skipped };
}

async function put(store, key, row) {
  const [a, b, c] = key.split('.'); const p = store.project;
  let stage, label, where = 'course';
  if (a === 'chapters') { const ch = store.chapter(b); if (!ch) throw new Error('the chapter is gone'); stage = store.chapterStage(b, c); label = `${ch.title} / ${STAGE_NAME[c] || c}`; where = ch.title; }
  else if (a === 'foundation') { stage = store.foundationStage(b); label = STAGE_NAME[b] || b; }
  else if (a === 'exams') { stage = store.examStage(b); label = STAGE_NAME[b] || b; }
  else throw new Error(`unknown stage ${key}`);
  const id = a === 'chapters' ? c : b;
  const wasEmpty = !stage.output;
  if (id === 'slides') {
    if (row.ext !== 'pptx') throw new Error('slides must be a .pptx');
    await commitDeck(store, b, row.blob, { name: row.name, label, where, reason: 'import' });
  } else if (a === 'chapters' && CONVERTIBLE.has(id) && row.ext === 'docx') {
    await commitDoc(store, b, id, row.blob, { name: row.name, label, where, reason: 'import' });
  } else {
    let text = row.ext === 'pdf' && row.blob ? await pdfText(new Uint8Array(await row.blob.arrayBuffer()), { pages: 300 }).catch(() => row.text) : row.text;
    if (id === 'quiz') text = quizText(text);
    if (!String(text || '').trim()) throw new Error('no text could be read from this file');
    if (!text.endsWith('\n')) text += '\n';
    store.userEdit(stage, label, text, where);
    store.log({ type: 'import', stage: label, where, file: row.path, chars: text.length });
  }
  stage = stageAt(p, key);
  if (wasEmpty && stage.history?.at(-1)?.output === '') stage.history.pop(); // nothing worth keeping before the import
  Object.assign(stage, { origin: 'import', sourcePath: row.path, status: 'done', error: null });
  stage.ranAt ||= new Date().toISOString();
  return label;
}

/** The commit message for an import: "import: 8 files → syllabus, 01 slides+script, 02 slides+homework". */
export function importMessage(project, stages, nFiles) {
  const parts = []; const byCh = new Map();
  for (const s of stages) {
    const [a, b, c] = s.key.split('.');
    if (a === 'chapters') { const i = project.chapters.findIndex(ch => ch.id === b); const k = String(i + 1).padStart(2, '0'); if (!byCh.has(k)) byCh.set(k, new Set()); byCh.get(k).add(c); }
    else parts.push(a === 'exams' ? `${b} exam` : b);
  }
  for (const [k, set] of [...byCh].sort()) parts.push(`${k} ${[...set].join('+')}`);
  const list = [...new Set(parts)].join(', ');
  return `import: ${nFiles} file${nFiles === 1 ? '' : 's'} → ${list || 'sources'}`.slice(0, 280);
}
export { KIND_LABEL, docManifest };
