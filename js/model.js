// model.js — the project object: its shape, a fresh project and the migration of older saves. No browser APIs,
// so the local server (serialize, import) shares it.
export const SCHEMA = 2;

export function emptyStage() {
  return { status: 'idle', output: '', prompt: null, transcript: [], usage: null, durationMs: 0, ranAt: null, inputHash: null, version: 0, history: [], edited: false, error: null, reviewed: false };
}
export const uid = () => Math.random().toString(36).slice(2, 10);

export function newProject(fields = {}) {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA, id: 'prj_' + uid(), name: fields.name || fields.course?.name || 'Untitled course', createdAt: now, updatedAt: now,
    course: { name: '', subject: '', level: 'Undergraduate', audience: '', weeks: 14, language: 'English', notes: '', ...(fields.course || {}) },
    textbook: { name: '', chars: 0, chunks: [] },
    overrides: {},                // per-project overrides of account settings (model, deliberation, slidesPerChapter)
    deck: { template: 'auto' },  // 'auto' | 'builtin:<palette>' | 'custom' (+ palette, fonts, background from an uploaded .pptx)
    foundation: {}, chaptersStage: emptyStage(), chapters: [],
    exams: { midterm: emptyStage(), final: emptyStage() },
    audit: [],
  };
}

export function migrate(p) {
  if (!p) return p;
  if (!p.schema || p.schema < 2) {
    p.schema = SCHEMA; p.id ||= 'prj_' + uid(); p.name ||= p.course?.name || 'Imported course';
    p.createdAt ||= new Date().toISOString(); p.updatedAt ||= p.createdAt;
    p.exams ||= { midterm: emptyStage(), final: emptyStage() }; p.overrides ||= {};
    for (const ch of p.chapters || []) ch.stages ||= {};
    delete p.settings;
  }
  p.exams.midterm ||= emptyStage(); p.exams.final ||= emptyStage();
  p.deck ||= { template: 'auto' };
  if (p.overrides) delete p.overrides.slideFormat;
  return p;
}

