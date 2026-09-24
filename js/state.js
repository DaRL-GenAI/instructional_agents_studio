// state.js — single project state, persistence and the audit trail.
import { sha1Short } from './llm.js';

const STORE_KEY = 'ia-studio.project.v1';
const KEY_LOCAL = 'ia-studio.apiKey';
const KEY_SESSION = 'ia-studio.apiKey.session';

export const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  ttsModel: 'gpt-4o-mini-tts',
  voice: 'alloy',
  temperature: '',
  seed: '',
  deliberation: 'full',     // full = faculty → reviewer → summarizer (3 calls); quick = single call
  slidesPerChapter: 10,
  rememberKey: false,
};

export function emptyStage() {
  return { status: 'idle', output: '', prompt: null, transcript: [], usage: null, durationMs: 0, ranAt: null, inputHash: null, version: 0, history: [], edited: false, error: null, reviewed: false };
}

export function newProject() {
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    course: { name: '', subject: '', level: 'Undergraduate', audience: '', weeks: 14, language: 'English', notes: '' },
    textbook: { name: '', chars: 0, chunks: [] },
    foundation: {},      // id -> stage
    chaptersStage: emptyStage(),
    chapters: [],        // {id, title, description, stages:{outline, slides, script, homework, lab, video}}
    audit: [],
  };
}

export class Store {
  constructor() {
    this.project = this.load() || newProject();
    this.listeners = new Set();
    this.apiKey = this.loadKey();
  }

  load() {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.project, (k, v) => (k === 'audioBuffers' || k === 'blob' ? undefined : v))); } catch (e) { console.warn('save failed', e); }
    this.emit();
  }
  reset() { this.project = newProject(); this.save(); }
  replace(project) { this.project = project; this.save(); }

  loadKey() {
    try { return localStorage.getItem(KEY_LOCAL) || sessionStorage.getItem(KEY_SESSION) || ''; } catch { return ''; }
  }
  setKey(key, remember) {
    this.apiKey = key || '';
    try {
      if (remember && key) { localStorage.setItem(KEY_LOCAL, key); sessionStorage.removeItem(KEY_SESSION); }
      else { localStorage.removeItem(KEY_LOCAL); if (key) sessionStorage.setItem(KEY_SESSION, key); else sessionStorage.removeItem(KEY_SESSION); }
    } catch { /* private mode */ }
    this.project.settings.rememberKey = !!remember;
    this.save();
  }
  forgetKey() { this.setKey('', false); }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.project); }

  // ---- audit -------------------------------------------------------------
  log(entry) {
    const e = { id: (this.project.audit.at(-1)?.id || 0) + 1, ts: new Date().toISOString(), ...entry };
    this.project.audit.push(e);
    if (this.project.audit.length > 2000) this.project.audit.splice(0, this.project.audit.length - 2000);
    return e;
  }

  // ---- stages ------------------------------------------------------------
  foundationStage(id) { return this.project.foundation[id] || (this.project.foundation[id] = emptyStage()); }
  chapter(id) { return this.project.chapters.find(c => c.id === id); }
  chapterStage(chapterId, stageId) {
    const ch = this.chapter(chapterId);
    if (!ch) return null;
    return ch.stages[stageId] || (ch.stages[stageId] = emptyStage());
  }

  /** Record a user edit of a stage output; keeps history and marks downstream stale. */
  userEdit(stage, label, newOutput, where) {
    if (newOutput === stage.output) return false;
    stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.edited ? 'user edit' : 'model output' });
    if (stage.history.length > 10) stage.history.shift();
    stage.output = newOutput;
    stage.version += 1;
    stage.edited = true;
    stage.status = 'done';
    stage.error = null;
    stage.outputHash = sha1Short(newOutput);
    this.log({ type: 'edit', stage: label, where, chars: newOutput.length, version: stage.version, hash: stage.outputHash });
    this.save();
    return true;
  }

  applyResult(stage, label, result, where, extra = {}) {
    if (stage.output) stage.history.push({ version: stage.version, output: stage.output, at: stage.ranAt, reason: stage.edited ? 'user edit' : 'model output' });
    if (stage.history.length > 10) stage.history.shift();
    Object.assign(stage, { status: 'done', edited: false, error: null, ranAt: new Date().toISOString(), version: stage.version + 1, ...extra });
    stage.output = result.output;
    stage.outputHash = sha1Short(result.output || '');
    stage.usage = result.usage;
    stage.durationMs = result.durationMs;
    stage.transcript = result.transcript || [];
    stage.prompt = result.prompt || stage.prompt;
    stage.inputHash = result.inputHash || null;
    stage.provenance = result.provenance || null;
    this.log({ type: 'stage_done', stage: label, where, version: stage.version, hash: stage.outputHash, tokens: result.usage?.total_tokens, ms: result.durationMs, calls: (result.transcript || []).filter(t => t.role !== 'system').length });
    this.save();
  }

  addChapter(ch) {
    const id = 'ch' + Math.random().toString(36).slice(2, 8);
    this.project.chapters.push({ id, title: ch.title || 'Untitled chapter', description: ch.description || '', stages: {} });
    return id;
  }
}

export const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);

export function projectTotals(project) {
  const stages = [...Object.values(project.foundation), project.chaptersStage, ...project.chapters.flatMap(c => Object.values(c.stages || {}))];
  return {
    calls: project.audit.filter(a => a.type === 'llm_call' || a.type === 'tts_call').length,
    tokens: sum(project.audit.filter(a => a.type === 'llm_call'), a => a.tokens),
    ttsChars: sum(project.audit.filter(a => a.type === 'tts_call'), a => a.chars),
    done: stages.filter(s => s.status === 'done').length,
    edited: stages.filter(s => s.edited).length,
  };
}
