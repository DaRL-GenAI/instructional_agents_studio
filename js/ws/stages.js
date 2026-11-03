// ws/stages.js — which stage a project file belongs to, and back: the Workspace and the module pages share the
// folder layout of fs/serialize.js, so the same file opens from either side.
import { serialize, fileOwner, stageFile, stageAt } from '../fs/serialize.js';
import { FOUNDATION, CHAPTER_STAGES, EXAMS } from '../prompts.js';

/** The serialize key of a stage page's options object (o.key: 'f:<id>' | 'c:<chapter>:<stage>' | 'exam:<kind>'). */
export function keyOfStage(o) {
  const [a, b, c] = String(o.key || '').split(':');
  if (a === 'f') return `foundation.${b}`;
  if (a === 'c') return `chapters.${b}.${c}`;
  if (a === 'exam') return `exams.${b}`;
  return null;
}

/** The project's managed files: { meta, files, decks } (see serialize). Cached per project version. */
const cache = new WeakMap();
export function layout(project) {
  const hit = cache.get(project); const stamp = `${project.updatedAt}|${project.audit?.length}|${project.chapters?.length}`;
  if (hit && hit.stamp === stamp) return hit.value;
  const value = serialize(project); cache.set(project, { stamp, value }); return value;
}
export const fileOfKey = (project, key) => key ? stageFile(layout(project).meta, key) : null;
export const ownerOf = (project, path) => fileOwner(layout(project).meta, path);

/** Everything about the stage behind a key: { stage, label, where, chapter, stageId, inputs, page } (page: its module route). */
export function stageInfo(ctx, key) {
  const { store, pipe } = ctx; const p = store.project; const [a, b, c] = key.split('.');
  const stage = stageAt(p, key); if (!stage || typeof stage !== 'object') return null;
  if (a === 'foundation') { const f = FOUNDATION.find(x => x.id === b); return { stage, label: f?.name || b, where: 'course', stageId: b, inputs: f ? pipe.foundationInputs(b) : null, page: ['design', b] }; }
  if (a === 'chaptersStage') return { stage, label: 'Chapter extraction', where: 'course', stageId: 'chapters', inputs: [{ label: 'Syllabus', text: p.foundation.syllabus?.output || '' }], page: ['design', 'chapters'] };
  if (a === 'exams') { const e = EXAMS.find(x => x.id === b); return { stage, label: e?.name || b, where: 'course', stageId: b, inputs: pipe.examInputs(b), page: ['assessments', 'exams', b] }; }
  if (a === 'chapters') {
    const ch = store.chapter(b); const st = CHAPTER_STAGES.find(x => x.id === c); if (!ch) return null;
    return { stage, label: `${ch.title} / ${st?.name || c}`, where: ch.title, chapter: ch, stageId: c, inputs: st ? pipe.chapterInputs(b, c) : null, page: [st?.module || 'slides', b, c] };
  }
  return null;
}
