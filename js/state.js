// state.js — account settings, project registry and the per-project store (with audit trail).
import { db, mediaKey } from './db.js';
import { sha1Short } from './llm.js';

export const SCHEMA = 2;
const KEY_LOCAL = 'ia-studio.apiKey';
const KEY_SESSION = 'ia-studio.apiKey.session';
const LEGACY_KEY = 'ia-studio.project.v1';

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'alloy',
  temperature: '',
  seed: '',
  deliberation: 'full',
  slidesPerChapter: 10,
  quizQuestions: 8,
  theme: 'system',
  rememberKey: false,
  language: 'en',
};

export const MODULES = [
  { id: 'overview', name: 'Overview', icon: 'home' },
  { id: 'basics', name: 'Course basics', icon: 'info' },
  { id: 'design', name: 'Course design', icon: 'compass' },
  { id: 'slides', name: 'Slides', icon: 'presentation' },
  { id: 'assessments', name: 'Assessments', icon: 'clipboard' },
  { id: 'videos', name: 'Lecture videos', icon: 'video' },
  { id: 'audit', name: 'Audit trail', icon: 'shield' },
];

export function emptyStage() {
  return { status: 'idle', output: '', prompt: null, transcript: [], usage: null, durationMs: 0, ranAt: null, inputHash: null, version: 0, history: [], edited: false, error: null, reviewed: false };
}
const uid = () => Math.random().toString(36).slice(2, 10);

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

// ---------------------------------------------------------------- account
export const account = { settings: { ...DEFAULT_SETTINGS }, apiKey: '' , loaded: false };

export async function loadAccount() {
  const saved = await db.get('settings', 'account');
  if (saved) account.settings = { ...DEFAULT_SETTINGS, ...saved };
  else { // migrate legacy single-project settings
    try { const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); if (legacy?.settings) account.settings = { ...DEFAULT_SETTINGS, ...legacy.settings }; } catch { /* ignore */ }
  }
  try { account.apiKey = localStorage.getItem(KEY_LOCAL) || sessionStorage.getItem(KEY_SESSION) || ''; } catch { account.apiKey = ''; }
  account.loaded = true;
  applyTheme();
  return account;
}
export async function saveAccount() { await db.put('settings', 'account', account.settings); applyTheme(); }
export function setApiKey(key, remember) {
  account.apiKey = key || '';
  try {
    if (remember && key) { localStorage.setItem(KEY_LOCAL, key); sessionStorage.removeItem(KEY_SESSION); }
    else { localStorage.removeItem(KEY_LOCAL); if (key) sessionStorage.setItem(KEY_SESSION, key); else sessionStorage.removeItem(KEY_SESSION); }
  } catch { /* storage blocked */ }
  account.settings.rememberKey = !!remember;
}
export function applyTheme() {
  const t = account.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- registry
export async function listProjects() {
  const all = (await db.all('projects')).map(migrate);
  if (!all.length) { // one-time import of the legacy single project
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      if (legacy?.course) { const p = migrate(legacy); await db.put('projects', p.id, p); if (!db.usingMemory) localStorage.removeItem(LEGACY_KEY); all.push(p); }
    } catch { /* ignore */ }
  }
  return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
export async function createProject(fields) { const p = newProject(fields); await db.put('projects', p.id, p); return p; }
export async function getProject(id) { const p = await db.get('projects', id); return p ? migrate(p) : null; }
export async function deleteProject(id) { await db.del('projects', id); await db.clearPrefix('media', `${id}:`); }
export async function duplicateProject(id) {
  const src = await getProject(id); if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src)); copy.id = 'prj_' + uid(); copy.name = `${src.name} (copy)`; copy.createdAt = copy.updatedAt = new Date().toISOString();
  copy.audit = [{ id: 1, ts: copy.createdAt, type: 'project', note: `duplicated from ${src.name}` }];
  await db.put('projects', copy.id, copy); return copy;
}
export async function importProject(json) {
  const p = migrate(JSON.parse(json)); if (!p.course) throw new Error('Not a Studio project file');
  p.id = 'prj_' + uid(); p.updatedAt = new Date().toISOString(); await db.put('projects', p.id, p); return p;
}

// ---------------------------------------------------------------- per-project store
export class ProjectStore {
  constructor(project) { this.project = project; this.listeners = new Set(); this._t = null; this.dirty = false; }
  get id() { return this.project.id; }
  /** Effective settings: account defaults overridden per project. */
  get settings() { return { ...account.settings, ...(this.project.overrides || {}) }; }
  get apiKey() { return account.apiKey; }

  save() {
    this.project.updatedAt = new Date().toISOString();
    if (this.project.course?.name) this.project.name = this.project.course.name;
    this.dirty = true;
    clearTimeout(this._t);
    this._t = setTimeout(() => this.flush(), 150);
    this.emit();
  }
  /** Write to IndexedDB only when something changed, so a stale tab never overwrites newer data. */
  flush() {
    clearTimeout(this._t);
    if (!this.dirty) return Promise.resolve();
    this.dirty = false;
    return db.put('projects', this.project.id, this.project).catch(e => { this.dirty = true; console.warn('save failed', e); });
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.project); }

  log(entry) {
    const e = { id: (this.project.audit.at(-1)?.id || 0) + 1, ts: new Date().toISOString(), ...entry };
    this.project.audit.push(e);
    if (this.project.audit.length > 3000) this.project.audit.splice(0, this.project.audit.length - 3000);
    return e;
  }

  foundationStage(id) { return this.project.foundation[id] || (this.project.foundation[id] = emptyStage()); }
  examStage(kind) { return this.project.exams[kind] || (this.project.exams[kind] = emptyStage()); }
  chapter(id) { return this.project.chapters.find(c => c.id === id); }
  chapterStage(chapterId, stageId) { const ch = this.chapter(chapterId); if (!ch) return null; return ch.stages[stageId] || (ch.stages[stageId] = emptyStage()); }
  addChapter(ch) { const id = 'ch' + uid(); this.project.chapters.push({ id, title: ch.title || 'Untitled chapter', description: ch.description || '', stages: {} }); return id; }

  userEdit(stage, label, newOutput, where) {
    if (newOutput === stage.output) return false;
    stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.edited ? 'user edit' : 'model output' });
    if (stage.history.length > 10) stage.history.shift();
    Object.assign(stage, { output: newOutput, version: stage.version + 1, edited: true, status: 'done', error: null, outputHash: sha1Short(newOutput) });
    this.log({ type: 'edit', stage: label, where, chars: newOutput.length, version: stage.version, hash: stage.outputHash });
    this.save(); return true;
  }
  applyResult(stage, label, result, where, extra = {}) {
    if (stage.output) stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.edited ? 'user edit' : 'model output' });
    if (stage.history.length > 10) stage.history.shift();
    Object.assign(stage, { status: 'done', edited: false, error: null, ranAt: new Date().toISOString(), version: stage.version + 1, reviewed: false, ...extra });
    stage.output = result.output; stage.outputHash = sha1Short(result.output || ''); stage.usage = result.usage; stage.durationMs = result.durationMs;
    stage.transcript = result.transcript || []; stage.prompt = result.prompt || stage.prompt; stage.inputHash = result.inputHash || null; stage.provenance = result.provenance || null;
    this.log({ type: 'stage_done', stage: label, where, version: stage.version, hash: stage.outputHash, tokens: result.usage?.total_tokens, ms: result.durationMs, calls: (result.transcript || []).length });
    this.save();
  }

  // media (narration buffers, recorded video) live in the media store, keyed by project+chapter
  async putMedia(chapterId, kind, value) { await db.put('media', mediaKey(this.id, chapterId, kind), value); }
  async getMedia(chapterId, kind) { return db.get('media', mediaKey(this.id, chapterId, kind)); }
  async delMedia(chapterId, kind) { await db.del('media', mediaKey(this.id, chapterId, kind)); }
}

export const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

/** Progress per module for a project (used by nav, overview and the project list). */
export function moduleProgress(p) {
  const ch = p.chapters || [];
  const stCount = (ids, scope) => { let done = 0, total = 0; for (const c of scope) for (const id of ids) { total++; if (c.stages?.[id]?.status === 'done') done++; } return { done, total }; };
  const foundationIds = ['objectives', 'learners', 'resources', 'syllabus', 'assessment_plan', 'final_project'];
  const fDone = foundationIds.filter(id => p.foundation?.[id]?.status === 'done').length;
  const basics = { done: (p.course?.name ? 1 : 0) + (p.course?.audience ? 1 : 0), total: 2 };
  const design = { done: fDone + (p.chapters?.length ? 1 : 0), total: foundationIds.length + 1 };
  const slides = stCount(['outline', 'slides', 'script'], ch);
  const asm = stCount(['homework', 'lab', 'quiz'], ch);
  const examsDone = ['midterm', 'final'].filter(k => p.exams?.[k]?.status === 'done').length;
  const assessments = { done: asm.done + examsDone, total: asm.total + 2 };
  const videos = stCount(['video'], ch);
  return { basics, design, slides, assessments, videos };
}
export function projectTotals(p) {
  const audit = p.audit || [];
  return { calls: audit.filter(a => a.type === 'llm_call').length, tokens: sum(audit.filter(a => a.type === 'llm_call'), a => a.tokens), ttsChars: sum(audit.filter(a => a.type === 'tts_call'), a => a.chars), edits: audit.filter(a => a.type === 'edit').length };
}
