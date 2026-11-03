// state.js — account settings, project registry and the per-project store (with audit trail).
import { db } from './db.js';
import { backend } from './fs/backend.js';
import { sha1Short } from './llm.js';
import { copyDecks, unpackDecks, packDecks } from './pptxdeck.js';
import { packDocs, unpackDocs } from './docstage.js';
import { SCHEMA, emptyStage, newProject, migrate, uid } from './model.js';
import { stamp } from './linkage.js';

export { SCHEMA, emptyStage, newProject, migrate };

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
  characters: true,        // EduCast character accents in animated lessons
  illustrations: true,     // allow illustration scenes (image API)
  imageQuality: 'low',
  practice: true,          // one interactive practice scene per animated lesson
  reviewModel: '',         // vision model for the visual reviewer ('' = same as the text model)
  reviewRounds: 2,         // review → repair rounds for the storyboard
  videoRes: '1080p',       // exported video resolution
  editorUrl: 'https://edit.chaxus.com', // presentation editor (ONLYOFFICE document-editor build, runs in the browser)
  theme: 'system',
  rememberKey: false,
  language: 'en',
};

export const MODULES = [
  { id: 'overview', name: 'Overview', icon: 'home' },
  { id: 'workspace', name: 'Workspace', icon: 'code' },
  { id: 'basics', name: 'Course basics', icon: 'info' },
  { id: 'design', name: 'Course design', icon: 'compass' },
  { id: 'slides', name: 'Slides', icon: 'presentation' },
  { id: 'assessments', name: 'Assessments', icon: 'clipboard' },
  { id: 'videos', name: 'Lecture videos', icon: 'video' },
  { id: 'audit', name: 'Audit trail', icon: 'shield' },
];

// ---------------------------------------------------------------- account
export const account = { settings: { ...DEFAULT_SETTINGS }, apiKey: '' , loaded: false };

export async function loadAccount() {
  const saved = await backend.getSettings();
  if (saved) account.settings = { ...DEFAULT_SETTINGS, ...saved };
  else { // migrate legacy single-project settings
    try { const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); if (legacy?.settings) account.settings = { ...DEFAULT_SETTINGS, ...legacy.settings }; } catch { /* ignore */ }
  }
  try { account.apiKey = localStorage.getItem(KEY_LOCAL) || sessionStorage.getItem(KEY_SESSION) || ''; } catch { account.apiKey = ''; }
  account.loaded = true;
  applyTheme();
  return account;
}
export async function saveAccount() { await backend.putSettings(account.settings); applyTheme(); }
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
  const all = (await backend.list()).map(migrate);
  if (!all.length && backend.kind === 'idb') { // one-time import of the legacy single project
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
      if (legacy?.course) { const p = migrate(legacy); await db.put('projects', p.id, p); if (!db.usingMemory) localStorage.removeItem(LEGACY_KEY); all.push(p); }
    } catch { /* ignore */ }
  }
  return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
/** `dir`: the project folder (local app only; the server picks one under its projects root when omitted). */
export async function createProject(fields, { dir } = {}) { return backend.create(newProject(fields), { dir }); }
export async function getProject(id) { const p = await backend.get(id); return p ? migrate(p) : null; }
export async function deleteProject(id) { await backend.remove(id); }
export async function duplicateProject(id) {
  if (backend.duplicate) return migrate(await backend.duplicate(id)); // the server copies the folder
  const src = await getProject(id); if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src)); copy.id = 'prj_' + uid(); copy.name = `${src.name} (copy)`; copy.createdAt = copy.updatedAt = new Date().toISOString();
  copy.audit = [{ id: 1, ts: copy.createdAt, type: 'project', note: `duplicated from ${src.name}` }];
  await copyDecks(src.id, copy.id); await db.put('projects', copy.id, copy); return copy;
}
export async function importProject(json) {
  if (backend.import) return migrate(await backend.import(json)); // the server unpacks it into a new folder
  const p = migrate(JSON.parse(json)); if (!p.course) throw new Error('Not a Studio project file');
  p.id = 'prj_' + uid(); p.updatedAt = new Date().toISOString();
  const decks = p.decks, docs = p.docs; delete p.decks; delete p.docs; await unpackDecks(p.id, decks);
  await unpackDocs(p.id, docs, (...a) => backend.putMedia(...a));
  await db.put('projects', p.id, p); return p;
}
export async function renameProject(id, name) {
  const p = await getProject(id); if (!p) return;
  p.name = name; p.course.name = name; p.updatedAt = new Date().toISOString(); await backend.put(p);
}
/** The project file exported from Projects (JSON with the current deck of every chapter inside). */
export async function exportProject(id) { const p = await getProject(id); return JSON.stringify({ ...p, decks: await packDecks(p), docs: await packDocs(p, (...a) => backend.getMedia(...a)) }, null, 2); }

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
    if (!this.held) this._t = setTimeout(() => this.flush(), 150); // held: a batch (agent changes) is written as one commit
    this.emit();
  }
  /** Write (IndexedDB or the project folder) only when something changed, so a stale tab never overwrites newer data. */
  flush({ message } = {}) { // message: the commit message (local app), e.g. for an import
    clearTimeout(this._t);
    if (!this.dirty || this.held) return Promise.resolve();
    this.dirty = false;
    return backend.put(this.project, { message }).then(n => { if (n) { this.emit(); this.onAdopted?.(n); } }) // n: units merged in from disk
      .catch(e => { this.dirty = true; console.warn('save failed', e); });
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
    stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.origin === 'import' ? 'imported' : stage.edited ? 'user edit' : 'model output' });
    if (stage.history.length > 10) stage.history.shift();
    Object.assign(stage, { output: newOutput, version: stage.version + 1, edited: true, status: 'done', error: null, outputHash: sha1Short(newOutput) });
    delete stage.origin; // 'import' | 'convert' when the caller says so, after this
    stamp(this.project, stage); // what it was edited against: later upstream changes mark it out of date
    this.log({ type: 'edit', stage: label, where, chars: newOutput.length, version: stage.version, hash: stage.outputHash });
    this.save(); return true;
  }
  /** A revision made by the pipeline itself (e.g. visual-review repairs): versioned and logged like an edit, but attributed to the agents. */
  autoRevise(stage, label, newOutput, where, note) {
    if (newOutput === stage.output) return false;
    stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.edited ? 'user edit' : (stage.repaired ? 'auto repair' : 'model output') });
    if (stage.history.length > 10) stage.history.shift();
    Object.assign(stage, { output: newOutput, version: stage.version + 1, status: 'done', error: null, outputHash: sha1Short(newOutput), repaired: note || 'auto repair' });
    this.log({ type: 'auto_repair', stage: label, where, note, version: stage.version, hash: stage.outputHash });
    this.save(); return true;
  }
  applyResult(stage, label, result, where, extra = {}) {
    if (stage.output) stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.origin === 'import' ? 'imported' : stage.edited ? 'user edit' : 'model output' });
    if (stage.history.length > 10) stage.history.shift();
    Object.assign(stage, { status: 'done', edited: false, error: null, ranAt: new Date().toISOString(), version: stage.version + 1, reviewed: false, ...extra });
    delete stage.origin; // sourcePath stays: where the material first came from
    stage.output = result.output; stage.outputHash = sha1Short(result.output || ''); stage.usage = result.usage; stage.durationMs = result.durationMs;
    stage.transcript = result.transcript || []; stage.prompt = result.prompt || stage.prompt; stage.inputHash = result.inputHash || null; stage.provenance = result.provenance || null;
    stamp(this.project, stage);
    this.log({ type: 'stage_done', stage: label, where, version: stage.version, hash: stage.outputHash, tokens: result.usage?.total_tokens, ms: result.durationMs, calls: (result.transcript || []).length });
    this.save();
  }

  // media (narration buffers, recorded video) live in the media store, keyed by project+chapter
  async putMedia(chapterId, kind, value) { await backend.putMedia(this.id, chapterId, kind, value); }
  async getMedia(chapterId, kind) { return backend.getMedia(this.id, chapterId, kind); }
  async delMedia(chapterId, kind) { await backend.delMedia(this.id, chapterId, kind); }
  async mediaKeys(prefix) { return (await backend.mediaKeys(this.id)).filter(k => k.startsWith(prefix)); }
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
