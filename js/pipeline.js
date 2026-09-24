// pipeline.js — runs the ADDIE stages in the browser and records everything in the audit trail.
import { LLMClient, extractJson, sha1Short } from './llm.js';
import { AGENTS, FOUNDATION, CHAPTER_STAGES, PROMPTS, courseContext, priorContext, textbookContext } from './prompts.js';

export class Pipeline {
  constructor(store) {
    this.store = store;
    this.live = null;          // {stageKey, text, transcript} for the UI while a call streams
    this.onLive = () => {};
    this.abort = null;
  }

  get client() { return new LLMClient({ ...this.store.project.settings, apiKey: this.store.apiKey }); }

  cancel() { this.abort?.abort(); }

  /** One logged model call. */
  async call({ where, stage, agent, messages, json = false, onToken }) {
    const p = this.store.project;
    const controller = new AbortController();
    this.abort = controller;
    const promptText = messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
    const entry = this.store.log({ type: 'llm_call', where, stage, agent, model: p.settings.model, status: 'running', promptHash: sha1Short(promptText), promptChars: promptText.length });
    this.store.emit();
    try {
      const res = await this.client.chat(messages, { json, temperature: p.settings.temperature, seed: p.settings.seed, signal: controller.signal, onToken });
      Object.assign(entry, { status: 'ok', tokens: res.usage.total_tokens, promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, estimated: !!res.usage.estimated, ms: res.durationMs, responseHash: sha1Short(res.text), responseChars: res.text.length });
      this.store.save();
      return res;
    } catch (e) {
      Object.assign(entry, { status: 'error', error: String(e.message || e), detail: e.detail ? String(e.detail).slice(0, 2000) : undefined });
      this.store.save();
      throw e;
    } finally { this.abort = null; }
  }

  // ---------- inputs & provenance ----------------------------------------
  foundationPrior(id) {
    const p = this.store.project;
    const idx = FOUNDATION.findIndex(f => f.id === id);
    return FOUNDATION.slice(0, idx).map(f => ({ label: f.name, key: f.id, text: p.foundation[f.id]?.output || '', version: p.foundation[f.id]?.version || 0 }));
  }

  foundationInputs(id) {
    const p = this.store.project;
    const prior = this.foundationPrior(id);
    const items = [{ label: 'Course setup', text: courseContext(p.course) }, ...prior.filter(x => x.text)];
    return items;
  }

  chapterInputs(chapterId, stageId) {
    const p = this.store.project;
    const ch = this.store.chapter(chapterId);
    const items = [{ label: 'Course setup', text: courseContext(p.course) }, { label: 'Chapter', text: `${ch.title}\n${ch.description}` }];
    const f = k => ({ label: FOUNDATION.find(x => x.id === k).name, text: p.foundation[k]?.output || '', version: p.foundation[k]?.version || 0 });
    const s = k => ({ label: CHAPTER_STAGES.find(x => x.id === k).name, text: ch.stages[k]?.output || '', version: ch.stages[k]?.version || 0 });
    if (stageId === 'outline') items.push(f('objectives'), f('syllabus'));
    if (stageId === 'slides') items.push(f('objectives'), s('outline'));
    if (stageId === 'script') items.push(s('slides'));
    if (stageId === 'homework') items.push(f('assessment_plan'), s('slides'));
    if (stageId === 'lab') items.push(f('resources'), s('slides'));
    if (stageId === 'video') items.push(s('slides'), s('script'));
    if (p.textbook.chunks.length && ['outline', 'slides', 'homework', 'lab'].includes(stageId)) {
      const chunks = this.retrieve(`${ch.title} ${ch.description}`);
      items.push({ label: `Textbook excerpts (${chunks.length})`, text: chunks.map(c => c.text).join('\n'), chunks });
    }
    return items.filter(x => x.text);
  }

  inputHash(items) { return sha1Short(items.map(i => `${i.label}:${i.text}`).join('\u0001')); }

  isStale(stage, items) { return stage.status === 'done' && stage.inputHash && stage.inputHash !== this.inputHash(items); }

  /** Lexical retrieval over textbook chunks (no embeddings needed in the browser). */
  retrieve(query, k = 4) {
    const chunks = this.store.project.textbook.chunks;
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored = chunks.map(c => {
      const t = c.tokens || (c.tokens = tokenize(c.text));
      const set = new Set(t);
      let score = 0;
      for (const q of terms) if (set.has(q)) score += 1 / Math.log(2 + (c.df || 1));
      return { c, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
    return scored.map(x => ({ text: x.c.text.slice(0, 1500), page: x.c.page, score: +x.score.toFixed(2) }));
  }

  // ---------- prompt construction (all user-visible & editable) ---------
  defaultFoundationPrompt(id) {
    const p = this.store.project;
    const d = FOUNDATION.find(f => f.id === id);
    const prior = priorContext(this.foundationPrior(id));
    return {
      custom: false,
      mode: p.settings.deliberation,
      agents: d.agents.map(k => ({ key: k, name: AGENTS[k].name, role: AGENTS[k].role, system: AGENTS[k].system })),
      summarizer: { ...d.summarizer },
      user: PROMPTS.deliberationOpen(d, p.course, prior),
    };
  }

  defaultChapterPrompt(chapterId, stageId) {
    const p = this.store.project;
    const ch = this.store.chapter(chapterId);
    const st = CHAPTER_STAGES.find(s => s.id === stageId);
    const out = k => p.foundation[k]?.output || '';
    const chunks = this.chapterInputs(chapterId, stageId).find(i => i.chunks)?.chunks || [];
    const tb = textbookContext(chunks);
    const slides = safeJson(ch.stages.slides?.output, []);
    const outline = safeJson(ch.stages.outline?.output, []);
    let user = '';
    if (stageId === 'outline') user = PROMPTS.outline(p.course, ch, p.settings.slidesPerChapter, priorContext([{ label: 'Learning objectives', text: out('objectives') }]), tb);
    if (stageId === 'slides') user = PROMPTS.slides(p.course, ch, outline, priorContext([{ label: 'Learning objectives', text: out('objectives') }]), tb);
    if (stageId === 'script') user = PROMPTS.script(p.course, ch, slides, '');
    if (stageId === 'homework') user = PROMPTS.homework(p.course, ch, slides, out('assessment_plan'), tb);
    if (stageId === 'lab') user = PROMPTS.lab(p.course, ch, slides, out('resources'), tb);
    const a = AGENTS[st.agent];
    return { custom: false, agents: [{ key: st.agent, name: a.name, role: a.role, system: a.system }], user };
  }

  defaultChaptersPrompt() {
    const p = this.store.project;
    const a = AGENTS.syllabus_processor;
    return { custom: false, agents: [{ key: 'syllabus_processor', name: a.name, role: a.role, system: a.system }], user: PROMPTS.chapters(p.course, p.foundation.syllabus?.output || '') };
  }

  // ---------- runners ----------------------------------------------------
  async runFoundation(id) {
    const p = this.store.project;
    const d = FOUNDATION.find(f => f.id === id);
    const stage = this.store.foundationStage(id);
    const prompt = stage.prompt?.custom ? stage.prompt : this.defaultFoundationPrompt(id);
    const inputs = this.foundationInputs(id);
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [];
    const key = `foundation:${id}`;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const t0 = performance.now();
    try {
      let finalText;
      if (prompt.mode === 'quick') {
        const [a] = prompt.agents;
        const sys = `${a.system}\n\nWhen you answer, act as the whole design committee and produce the final deliverable directly. ${prompt.summarizer.system}`;
        finalText = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: a.name, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt.user }] });
      } else {
        // Round 1: first agent proposes.
        const [a, b] = prompt.agents;
        const proposal = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: a.name, messages: [{ role: 'system', content: a.system }, { role: 'user', content: prompt.user }] });
        // Round 1: second agent reviews.
        const review = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: b.name, messages: [{ role: 'system', content: b.system }, { role: 'user', content: `${prompt.user}\n\n${PROMPTS.deliberationReply(d, a.name, proposal)}` }] });
        // Summarizer writes the deliverable.
        const discussion = `${a.name}:\n${proposal}\n\n${b.name}:\n${review}`;
        finalText = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: prompt.summarizer.name, messages: [{ role: 'system', content: prompt.summarizer.system }, { role: 'user', content: PROMPTS.deliberationSummary(d, discussion) }] });
      }
      this.store.applyResult(stage, d.name, { output: finalText.trim(), usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, 'course');
    } catch (e) {
      stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e;
    } finally { this.live = null; this.onLive(); }
  }

  async runChaptersExtraction() {
    const p = this.store.project;
    const stage = p.chaptersStage;
    const prompt = stage.prompt?.custom ? stage.prompt : this.defaultChaptersPrompt();
    const inputs = [{ label: 'Syllabus', text: p.foundation.syllabus?.output || '' }];
    if (!inputs[0].text) throw new Error('Run the syllabus stage first.');
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, t0 = performance.now();
    try {
      const text = await this.stream('chapters', transcript, usage, { where: 'course', stage: 'Chapter extraction', agent: 'Syllabus Processor', json: true, messages: [{ role: 'system', content: prompt.agents[0].system }, { role: 'user', content: prompt.user }] });
      const chapters = extractJson(text, 'array').filter(c => c && c.title).map(c => ({ title: String(c.title), description: String(c.description || '') }));
      if (!chapters.length) throw new Error('The model returned no chapters.');
      // Replace chapter list, keeping stages of chapters with identical titles.
      const old = p.chapters;
      p.chapters = chapters.map(c => { const prev = old.find(o => o.title === c.title); return { id: prev?.id || 'ch' + Math.random().toString(36).slice(2, 8), title: c.title, description: c.description, stages: prev?.stages || {} }; });
      this.store.applyResult(stage, 'Chapter extraction', { output: JSON.stringify(chapters, null, 2), usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text) })) }, 'course');
    } catch (e) { stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e; }
    finally { this.live = null; this.onLive(); }
  }

  async runChapterStage(chapterId, stageId) {
    const ch = this.store.chapter(chapterId);
    const st = CHAPTER_STAGES.find(s => s.id === stageId);
    const stage = this.store.chapterStage(chapterId, stageId);
    const inputs = this.chapterInputs(chapterId, stageId);
    // Dependencies
    const need = { slides: ['outline'], script: ['slides'], homework: ['slides'], lab: ['slides'] }[stageId] || [];
    for (const n of need) if (ch.stages[n]?.status !== 'done') throw new Error(`Run "${CHAPTER_STAGES.find(s => s.id === n).name}" for this chapter first.`);
    const prompt = stage.prompt?.custom ? stage.prompt : this.defaultChapterPrompt(chapterId, stageId);
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, t0 = performance.now();
    const key = `chapter:${chapterId}:${stageId}`;
    try {
      const json = ['outline', 'slides', 'script'].includes(stageId);
      const text = await this.stream(key, transcript, usage, { where: ch.title, stage: st.name, agent: prompt.agents[0].name, json, messages: [{ role: 'system', content: prompt.agents[0].system }, { role: 'user', content: prompt.user }] });
      let output = text.trim();
      if (stageId === 'outline') output = JSON.stringify(normalizeOutline(extractJson(text, 'array')), null, 2);
      if (stageId === 'slides') output = JSON.stringify(normalizeSlides(extractJson(text, 'array'), safeJson(ch.stages.outline.output, [])), null, 2);
      if (stageId === 'script') output = JSON.stringify(normalizeScript(extractJson(text, 'array'), safeJson(ch.stages.slides.output, [])), null, 2);
      this.store.applyResult(stage, `${st.name}`, { output, usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version, chunks: i.chunks })) }, ch.title);
    } catch (e) { stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e; }
    finally { this.live = null; this.onLive(); }
  }

  /** Streams one call into the live panel and appends it to the stage transcript. */
  async stream(key, transcript, usage, opts) {
    const rec = { role: opts.agent, system: opts.messages[0].content, user: opts.messages[opts.messages.length - 1].content, text: '', model: this.store.project.settings.model };
    transcript.push(rec);
    this.live = { key, agent: opts.agent, text: '' };
    this.onLive();
    const res = await this.call({ ...opts, onToken: t => { this.live.text += t; this.onLive(); } });
    rec.text = res.text; rec.usage = res.usage; rec.ms = res.durationMs;
    usage.prompt_tokens += res.usage.prompt_tokens || 0; usage.completion_tokens += res.usage.completion_tokens || 0; usage.total_tokens += res.usage.total_tokens || 0;
    return res.text;
  }

  /** Optional quality review of any Markdown deliverable (Program Chair agent). */
  async review(kind, text, where) {
    const a = AGENTS.reviewer;
    const res = await this.call({ where, stage: `Review: ${kind}`, agent: a.name, json: true, messages: [{ role: 'system', content: a.system }, { role: 'user', content: PROMPTS.review(kind, text) }] });
    return extractJson(res.text, 'object');
  }
}

export function safeJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}
const STOP = new Set('the and for with that this from are was were will have has into you your can not but our their they them what when where which who why how about than then over under between each also more most such use used using'.split(' '));

function normalizeOutline(arr) {
  return arr.filter(x => x && (x.title || x.slide_title)).map((x, i) => ({ slide_id: i + 1, title: String(x.title || x.slide_title), description: String(x.description || x.summary || '') }));
}
function normalizeSlides(arr, outline) {
  const res = arr.filter(x => x && (x.title || x.slide_id)).map((x, i) => ({
    slide_id: i + 1,
    title: String(x.title || outline[i]?.title || `Slide ${i + 1}`),
    bullets: Array.isArray(x.bullets) ? x.bullets.map(String).slice(0, 8) : (typeof x.bullets === 'string' ? x.bullets.split('\n').filter(Boolean) : []),
    code: typeof x.code === 'string' ? x.code : '',
    code_language: typeof x.code_language === 'string' ? x.code_language : '',
    notes: typeof x.notes === 'string' ? x.notes : '',
  }));
  return res;
}
function normalizeScript(arr, slides) {
  const bySlide = new Map(arr.filter(x => x).map(x => [Number(x.slide_id), String(x.narration || x.script || x.text || '')]));
  return slides.map((s, i) => ({ slide_id: s.slide_id, title: s.title, narration: bySlide.get(s.slide_id) || bySlide.get(i + 1) || arr[i]?.narration || '' }));
}

/** Split extracted textbook text into overlapping chunks for lexical retrieval. */
export function chunkText(text, { size = 1400, overlap = 200 } = {}) {
  const chunks = [];
  const pages = text.split('\f');
  let pageNo = 0;
  for (const page of pages) {
    pageNo++;
    const clean = page.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    for (let i = 0; i < clean.length; i += size - overlap) {
      const t = clean.slice(i, i + size);
      if (t.trim().length > 80) chunks.push({ text: t, page: pages.length > 1 ? pageNo : undefined });
      if (i + size >= clean.length) break;
    }
  }
  // document frequency for a crude idf
  const df = new Map();
  for (const c of chunks) { c.tokens = tokenize(c.text); for (const w of new Set(c.tokens)) df.set(w, (df.get(w) || 0) + 1); }
  for (const c of chunks) { c.df = Math.max(...c.tokens.map(w => df.get(w) || 1), 1); delete c.tokens; }
  return chunks;
}
