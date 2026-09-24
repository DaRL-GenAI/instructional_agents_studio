// pipeline.js — runs the ADDIE stages in the browser and records everything in the audit trail.
import { LLMClient, extractJson, sha1Short, toArray } from './llm.js';
import { AGENTS, FOUNDATION, CHAPTER_STAGES, EXAMS, PROMPTS, courseContext, priorContext, textbookContext, revisionBlock, PALETTE_RULE_AUTO, PALETTE_RULE_FIXED } from './prompts.js';
import { normalizeDeck, deckOf, PALETTE_NAMES, resolveTheme } from './deck.js';
import { normalizeStoryboard } from './scenes.js';

export class Pipeline {
  constructor(store) {
    this.store = store;
    this.live = null;           // {key, agent, text} while a call streams
    this.onLive = () => {};
    this.abort = null;
  }
  get settings() { return this.store.settings; }
  get client() { return new LLMClient({ ...this.settings, apiKey: this.store.apiKey }); }
  cancel() { this.abort?.abort(); }

  /** One logged model call. */
  async call({ where, stage, agent, messages, json = false, onToken }) {
    const s = this.settings;
    const controller = new AbortController(); this.abort = controller;
    const promptText = messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
    const entry = this.store.log({ type: 'llm_call', where, stage, agent, model: s.model, status: 'running', promptHash: sha1Short(promptText), promptChars: promptText.length });
    this.store.emit();
    try {
      const res = await this.client.chat(messages, { json, temperature: s.temperature, seed: s.seed, signal: controller.signal, onToken });
      Object.assign(entry, { status: 'ok', tokens: res.usage.total_tokens, promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens, estimated: !!res.usage.estimated, ms: res.durationMs, responseHash: sha1Short(res.text), responseChars: res.text.length });
      this.store.save(); return res;
    } catch (e) {
      Object.assign(entry, { status: 'error', error: String(e.message || e), detail: e.detail ? String(e.detail).slice(0, 2000) : undefined });
      this.store.save(); throw e;
    } finally { this.abort = null; }
  }

  // ---------- inputs & provenance ----------------------------------------
  foundationPrior(id) {
    const p = this.store.project; const idx = FOUNDATION.findIndex(f => f.id === id);
    return FOUNDATION.slice(0, idx).map(f => ({ label: f.name, key: f.id, text: p.foundation[f.id]?.output || '', version: p.foundation[f.id]?.version || 0 }));
  }
  foundationInputs(id) { const p = this.store.project; return [{ label: 'Course basics', text: courseContext(p.course) }, ...this.foundationPrior(id).filter(x => x.text)]; }

  chapterInputs(chapterId, stageId) {
    const p = this.store.project; const ch = this.store.chapter(chapterId);
    const items = [{ label: 'Course basics', text: courseContext(p.course) }, { label: 'Chapter', text: `${ch.title}\n${ch.description}` }];
    const f = k => ({ label: FOUNDATION.find(x => x.id === k).name, text: p.foundation[k]?.output || '', version: p.foundation[k]?.version || 0 });
    const s = k => ({ label: CHAPTER_STAGES.find(x => x.id === k).name, text: ch.stages[k]?.output || '', version: ch.stages[k]?.version || 0 });
    if (stageId === 'outline') items.push(f('objectives'), f('syllabus'));
    if (stageId === 'slides') items.push(f('objectives'), s('outline'));
    if (stageId === 'script') items.push(s('slides'));
    if (stageId === 'homework' || stageId === 'quiz') items.push(f('assessment_plan'), s('slides'));
    if (stageId === 'lab') items.push(f('resources'), s('slides'));
    if (stageId === 'storyboard') items.push(s('slides'), s('script'));
    if (stageId === 'video') items.push(s('slides'), s('script'), s('storyboard'));
    if (p.textbook.chunks.length && ['outline', 'slides', 'homework', 'lab', 'quiz'].includes(stageId)) {
      const chunks = this.retrieve(`${ch.title} ${ch.description}`);
      if (chunks.length) items.push({ label: `Textbook excerpts (${chunks.length})`, text: chunks.map(c => c.text).join('\n'), chunks });
    }
    return items.filter(x => x.text);
  }
  examChapters(kind) {
    const chs = this.store.project.chapters;
    const scope = kind === 'midterm' ? chs.slice(0, Math.ceil(chs.length / 2)) : chs;
    return scope.map(c => { const slides = itemsOf(c.stages.slides?.output); return { title: c.title, description: c.description, points: slides.slice(0, 12).map(s => s.title) }; });
  }
  examInputs(kind) {
    const p = this.store.project;
    const f = k => ({ label: FOUNDATION.find(x => x.id === k).name, text: p.foundation[k]?.output || '', version: p.foundation[k]?.version || 0 });
    return [{ label: 'Course basics', text: courseContext(p.course) }, { label: 'Chapters in scope', text: this.examChapters(kind).map(c => `${c.title}: ${c.points.join('; ')}`).join('\n') }, f('syllabus'), f('assessment_plan'), ...(kind === 'final' ? [f('final_project')] : [])].filter(x => x.text);
  }
  inputHash(items) { return sha1Short(items.map(i => `${i.label}:${i.text}`).join('\u0001')); }
  isStale(stage, items) { return stage.status === 'done' && stage.inputHash && stage.inputHash !== this.inputHash(items); }

  retrieve(query, k = 4) {
    const chunks = this.store.project.textbook.chunks; const terms = tokenize(query);
    if (!terms.length) return [];
    return chunks.map(c => { const t = c.tokens || (c.tokens = tokenize(c.text)); const set = new Set(t); let score = 0; for (const q of terms) if (set.has(q)) score += 1 / Math.log(2 + (c.df || 1)); return { c, score }; })
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map(x => ({ text: x.c.text.slice(0, 1500), page: x.c.page, score: +x.score.toFixed(2) }));
  }

  // ---------- prompts (all user-visible & editable) -----------------------
  defaultFoundationPrompt(id) {
    const p = this.store.project; const d = FOUNDATION.find(f => f.id === id);
    return { custom: false, mode: this.settings.deliberation, agents: d.agents.map(k => ({ key: k, name: AGENTS[k].name, role: AGENTS[k].role, system: AGENTS[k].system })), summarizer: { ...d.summarizer }, user: PROMPTS.deliberationOpen(d, p.course, priorContext(this.foundationPrior(id))) };
  }
  defaultChapterPrompt(chapterId, stageId) {
    const p = this.store.project; const ch = this.store.chapter(chapterId); const st = CHAPTER_STAGES.find(s => s.id === stageId);
    const out = k => p.foundation[k]?.output || '';
    const tb = textbookContext(this.chapterInputs(chapterId, stageId).find(i => i.chunks)?.chunks || []);
    const slides = itemsOf(ch.stages.slides?.output); const outline = itemsOf(ch.stages.outline?.output);
    let user = '';
    if (stageId === 'outline') user = PROMPTS.outline(p.course, ch, this.settings.slidesPerChapter, priorContext([{ label: 'Learning objectives', text: out('objectives') }]), tb);
    if (stageId === 'slides') user = PROMPTS.slides(p.course, ch, outline, priorContext([{ label: 'Learning objectives', text: out('objectives') }]), tb, this.paletteRule());
    if (stageId === 'script') user = PROMPTS.script(p.course, ch, slides.map(slideSummary), '');
    if (stageId === 'homework') user = PROMPTS.homework(p.course, ch, slides.map(slideSummary), out('assessment_plan'), tb);
    if (stageId === 'lab') user = PROMPTS.lab(p.course, ch, slides.map(slideSummary), out('resources'), tb);
    if (stageId === 'quiz') user = PROMPTS.quiz(p.course, ch, slides.map(slideSummary), this.settings.quizQuestions || 8, out('assessment_plan'), tb);
    if (stageId === 'storyboard') user = PROMPTS.storyboard(p.course, ch, slides.map(slideSummary), safeJson(ch.stages.script?.output, []) || [], { illustrations: this.settings.illustrations !== false });
    const a = AGENTS[st.agent];
    return { custom: false, agents: [{ key: st.agent, name: a.name, role: a.role, system: a.system }], user };
  }
  /** Palette instruction for the slides prompt: fixed when the project uses a template, else the model chooses. */
  paletteRule() {
    const d = this.store.project.deck || {};
    if (d.template && d.template !== 'auto') return PALETTE_RULE_FIXED(resolveTheme(null, d).name);
    return PALETTE_RULE_AUTO(PALETTE_NAMES);
  }
  defaultExamPrompt(kind) {
    const p = this.store.project; const ex = EXAMS.find(e => e.id === kind); const a = AGENTS.teaching_assistant;
    return { custom: false, agents: [{ key: 'teaching_assistant', name: a.name, role: a.role, system: a.system }], user: PROMPTS.exam(p.course, ex, this.examChapters(kind), p.foundation.assessment_plan?.output || '', p.foundation.final_project?.output || '') };
  }
  defaultChaptersPrompt() {
    const p = this.store.project; const a = AGENTS.syllabus_processor;
    return { custom: false, agents: [{ key: 'syllabus_processor', name: a.name, role: a.role, system: a.system }], user: PROMPTS.chapters(p.course, p.foundation.syllabus?.output || '') };
  }

  /** Effective prompt for a run: the stored custom prompt or the default, plus the instructor's revision comments. */
  promptFor(stage, defaultPrompt, feedback, kind = 'text', label = '', where = '') {
    const base = stage.prompt?.custom ? stage.prompt : defaultPrompt;
    if (!feedback || !feedback.trim()) return base;
    this.store.log({ type: 'feedback', stage: label, where, chars: feedback.length, version: stage.version });
    stage.feedbackLog = [...(stage.feedbackLog || []), { at: new Date().toISOString(), feedback, version: stage.version }];
    return { ...base, user: base.user + revisionBlock(feedback.trim(), stage.output, kind), feedback: feedback.trim() };
  }

  // ---------- runners ----------------------------------------------------
  async runFoundation(id, { feedback } = {}) {
    const p = this.store.project; const d = FOUNDATION.find(f => f.id === id); const stage = this.store.foundationStage(id);
    const prompt = this.promptFor(stage, this.defaultFoundationPrompt(id), feedback, 'text', d.name, 'course');
    const inputs = this.foundationInputs(id);
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, t0 = performance.now(), key = `foundation:${id}`;
    try {
      let finalText;
      if (prompt.mode === 'quick') {
        const [a] = prompt.agents;
        finalText = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: a.name, messages: [{ role: 'system', content: `${a.system}\n\nWhen you answer, act as the whole design committee and produce the final deliverable directly. ${prompt.summarizer.system}` }, { role: 'user', content: prompt.user }] });
      } else {
        const [a, b] = prompt.agents;
        const proposal = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: a.name, messages: [{ role: 'system', content: a.system }, { role: 'user', content: prompt.user }] });
        const review = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: b.name, messages: [{ role: 'system', content: b.system }, { role: 'user', content: `${prompt.user}\n\n${PROMPTS.deliberationReply(d, a.name, proposal)}` }] });
        finalText = await this.stream(key, transcript, usage, { where: 'course', stage: d.name, agent: prompt.summarizer.name, messages: [{ role: 'system', content: prompt.summarizer.system }, { role: 'user', content: PROMPTS.deliberationSummary(d, `${a.name}:\n${proposal}\n\n${b.name}:\n${review}`) }] });
      }
      this.store.applyResult(stage, d.name, { output: finalText.trim(), usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, 'course');
    } catch (e) { stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e; }
    finally { this.live = null; this.onLive(); }
  }

  async runChaptersExtraction({ feedback } = {}) {
    const p = this.store.project; const stage = p.chaptersStage;
    const prompt = this.promptFor(stage, this.defaultChaptersPrompt(), feedback, 'json', 'Chapter extraction', 'course');
    const inputs = [{ label: 'Syllabus', text: p.foundation.syllabus?.output || '' }];
    if (!inputs[0].text) throw new Error('Generate the syllabus first (Course design → Syllabus).');
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, t0 = performance.now();
    try {
      const text = await this.stream('chapters', transcript, usage, { where: 'course', stage: 'Chapter extraction', agent: 'Syllabus Processor', json: true, messages: [{ role: 'system', content: prompt.agents[0].system }, { role: 'user', content: prompt.user }] });
      const chapters = toArray(extractJson(text, 'array')).filter(c => c && c.title).map(c => ({ title: String(c.title), description: String(c.description || '') }));
      if (!chapters.length) throw new Error('The model returned no chapters.');
      const old = p.chapters;
      p.chapters = chapters.map(c => { const prev = old.find(o => o.title === c.title); return { id: prev?.id || 'ch' + Math.random().toString(36).slice(2, 10), title: c.title, description: c.description, stages: prev?.stages || {} }; });
      this.store.applyResult(stage, 'Chapter extraction', { output: JSON.stringify(chapters, null, 2), usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text) })) }, 'course');
    } catch (e) { stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e; }
    finally { this.live = null; this.onLive(); }
  }

  async runChapterStage(chapterId, stageId, { feedback } = {}) {
    const ch = this.store.chapter(chapterId); const st = CHAPTER_STAGES.find(s => s.id === stageId); const stage = this.store.chapterStage(chapterId, stageId);
    const inputs = this.chapterInputs(chapterId, stageId);
    const need = { slides: ['outline'], script: ['slides'], homework: ['slides'], lab: ['slides'], quiz: ['slides'], storyboard: ['slides', 'script'] }[stageId] || [];
    for (const n of need) if (ch.stages[n]?.status !== 'done') throw new Error(`Generate "${CHAPTER_STAGES.find(s => s.id === n).name}" for this chapter first.`);
    const jsonKinds = ['outline', 'slides', 'script', 'quiz', 'storyboard'];
    const prompt = this.promptFor(stage, this.defaultChapterPrompt(chapterId, stageId), feedback, jsonKinds.includes(stageId) ? 'json' : 'text', `${ch.title} / ${st.name}`, ch.title);
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, t0 = performance.now(), key = `chapter:${chapterId}:${stageId}`;
    try {
      const json = ['outline', 'slides', 'script', 'quiz', 'storyboard'].includes(stageId);
      const messages = [{ role: 'system', content: prompt.agents[0].system }, { role: 'user', content: prompt.user }];
      let text = await this.stream(key, transcript, usage, { where: ch.title, stage: st.name, agent: prompt.agents[0].name, json, messages });
      const parse = (t) => {
        if (stageId === 'outline') return JSON.stringify(normalizeOutline(extractJson(t, 'array')), null, 2);
        if (stageId === 'slides') {
          const outline = itemsOf(ch.stages.outline?.output);
          const d = normalizeDeck(extractJson(t, 'object'), outline);
          if (!d.slides.length) throw new Error('The model returned no slides. Re-run, or check the Transcript tab for the raw response.');
          const expected = Math.max(3, Math.ceil(outline.length * 0.6));
          if (d.slides.length < expected) throw new Error(`Only ${d.slides.length} of ${outline.length} outline slides were returned`);
          return JSON.stringify(d, null, 2);
        }
        if (stageId === 'script') return JSON.stringify(normalizeScript(extractJson(t, 'array'), itemsOf(ch.stages.slides?.output)), null, 2);
        if (stageId === 'quiz') return JSON.stringify(normalizeQuiz(extractJson(t, 'array')), null, 2);
        if (stageId === 'storyboard') { const sb = normalizeStoryboard(extractJson(t, 'object')); if (sb.scenes.length < 3) throw new Error(`Only ${sb.scenes.length} scenes were returned`); return JSON.stringify(sb, null, 2); }
        return t.trim();
      };
      let output;
      try { output = parse(text); }
      catch (e) {
        if (!json) throw e;
        // One strict retry: the model answered in an unexpected shape; ask for the bare array.
        const strict = [...messages, { role: 'assistant', content: text }, { role: 'user', content: stageId === 'storyboard' ? `That reply could not be used (${e.message}). Reply again with ONLY the complete JSON object {"scenes":[…]} requested above, 6–8 scene objects, no prose, no code fences.` : stageId === 'slides' ? `That reply could not be used (${e.message}). Reply again with ONLY the complete JSON object {"theme":…,"slides":[…]} requested above: one slide object for EVERY outline item, in order, with slides as a top-level array of objects, no prose, no code fences.` : stageId === 'script' ? `That reply could not be used (${e.message}). Reply again with ONLY a JSON array containing one {"slide_id", "narration"} object for EVERY slide listed above, in order, no wrapper object, no prose, no code fences.` : `That reply could not be used (${e.message}). Reply again with ONLY the JSON array requested above, as a top-level array of objects with exactly the specified fields, no wrapper object, no prose, no code fences.` }];
        text = await this.stream(key, transcript, usage, { where: ch.title, stage: `${st.name} (retry)`, agent: prompt.agents[0].name, json: false, messages: strict });
        output = parse(text);
      }

      this.store.applyResult(stage, st.name, { output, usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version, chunks: i.chunks })) }, ch.title);
    } catch (e) { stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e; }
    finally { this.live = null; this.onLive(); }
  }

  async runExam(kind, { feedback } = {}) {
    const ex = EXAMS.find(e => e.id === kind); const stage = this.store.examStage(kind); const inputs = this.examInputs(kind);
    if (!this.store.project.chapters.length) throw new Error('Extract chapters first (Course design → Chapters).');
    const prompt = this.promptFor(stage, this.defaultExamPrompt(kind), feedback, 'text', ex.name, 'course');
    stage.status = 'running'; stage.error = null; this.store.save();
    const transcript = [], usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, t0 = performance.now();
    try {
      const text = await this.stream(`exam:${kind}`, transcript, usage, { where: 'course', stage: ex.name, agent: prompt.agents[0].name, messages: [{ role: 'system', content: prompt.agents[0].system }, { role: 'user', content: prompt.user }] });
      this.store.applyResult(stage, ex.name, { output: text.trim(), usage, durationMs: Math.round(performance.now() - t0), transcript, prompt, inputHash: this.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, 'course');
    } catch (e) { stage.status = 'error'; stage.error = String(e.message || e); stage.transcript = transcript; this.store.save(); throw e; }
    finally { this.live = null; this.onLive(); }
  }

  async stream(key, transcript, usage, opts) {
    const rec = { role: opts.agent, system: opts.messages[0].content, user: opts.messages[opts.messages.length - 1].content, text: '', model: this.settings.model };
    transcript.push(rec); this.live = { key, agent: opts.agent, text: '' }; this.onLive();
    const res = await this.call({ ...opts, onToken: t => { this.live.text += t; this.onLive(); } });
    rec.text = res.text; rec.usage = res.usage; rec.ms = res.durationMs;
    usage.prompt_tokens += res.usage.prompt_tokens || 0; usage.completion_tokens += res.usage.completion_tokens || 0; usage.total_tokens += res.usage.total_tokens || 0;
    return res.text;
  }

  async review(kind, text, where) {
    const a = AGENTS.reviewer;
    const res = await this.call({ where, stage: `Review: ${kind}`, agent: a.name, json: true, messages: [{ role: 'system', content: a.system }, { role: 'user', content: PROMPTS.review(kind, text) }] });
    return extractJson(res.text, 'object');
  }
}

export function safeJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }
/** Saved stage output as a clean array of objects (tolerates empty, malformed or object-shaped saves). */
export function itemsOf(text) { const v = safeJson(text, null); if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.slides)) return normalizeDeck(v).slides; const a = Array.isArray(v) ? v : toArray(v); return a.filter(x => x && typeof x === 'object'); }
function tokenize(s) { return (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)); }
const STOP = new Set('the and for with that this from are was were will have has into you your can not but our their they them what when where which who why how about than then over under between each also more most such use used using'.split(' '));

function normalizeOutline(arr) { arr = toArray(arr); if (!arr.length) throw new Error('The model returned no outline items. Re-run, or check the Transcript tab for the raw response.'); return arr.filter(x => x && (x.title || x.slide_title)).map((x, i) => ({ slide_id: i + 1, title: String(x.title || x.slide_title), description: String(x.description || x.summary || '') })); }
function normalizeScript(arr, slides) {
  arr = toArray(arr).filter(x => x && typeof x === 'object');
  const text = x => String(x.narration ?? x.script ?? x.text ?? x.speech ?? '');
  const bySlide = new Map(arr.map((x, i) => [Number(x.slide_id ?? x.id ?? i + 1), text(x)]));
  const n = Math.max(slides.length, arr.length);
  const out = [];
  for (let i = 0; i < n; i++) { const s = slides[i]; out.push({ slide_id: s?.slide_id ?? i + 1, title: s?.title ?? arr[i]?.title ?? `Slide ${i + 1}`, narration: bySlide.get(s?.slide_id ?? i + 1) || bySlide.get(i + 1) || text(arr[i] || {}) }); }
  const filled = out.filter(x => x.narration.trim()).length;
  if (!filled) throw new Error('The model returned no narration. Re-run, or check the Transcript tab for the raw response.');
  if (slides.length > 1 && filled < Math.ceil(slides.length * 0.6)) throw new Error(`Narration was returned for only ${filled} of ${slides.length} slides`);
  return out;
}
export function normalizeQuiz(arr) {
  arr = toArray(arr); if (!arr.length) throw new Error('The model returned no questions. Re-run, or check the Transcript tab for the raw response.');
  return arr.filter(x => x && x.question).map((x, i) => ({ id: i + 1, type: ['multiple_choice', 'true_false', 'short_answer'].includes(x.type) ? x.type : (Array.isArray(x.options) && x.options.length ? 'multiple_choice' : 'short_answer'), question: String(x.question), options: Array.isArray(x.options) ? x.options.map(String) : [], answer: String(x.answer ?? x.correct_answer ?? ''), explanation: String(x.explanation || ''), objective: String(x.objective || ''), difficulty: String(x.difficulty || 'medium') }));
}

export function chunkText(text, { size = 1400, overlap = 200 } = {}) {
  const chunks = []; const pages = text.split('\f'); let pageNo = 0;
  for (const page of pages) {
    pageNo++; const clean = page.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    for (let i = 0; i < clean.length; i += size - overlap) { const t = clean.slice(i, i + size); if (t.trim().length > 80) chunks.push({ text: t, page: pages.length > 1 ? pageNo : undefined }); if (i + size >= clean.length) break; }
  }
  const df = new Map();
  for (const c of chunks) { c.tokens = tokenize(c.text); for (const w of new Set(c.tokens)) df.set(w, (df.get(w) || 0) + 1); }
  for (const c of chunks) { c.df = Math.max(...c.tokens.map(w => df.get(w) || 1), 1); delete c.tokens; }
  return chunks;
}

/** Flatten any layout into {slide_id, title, bullets, code, notes} for downstream prompts (script, homework, lab, quiz). */
export function slideSummary(s) {
  const b = [];
  const push = v => { if (Array.isArray(v)) for (const x of v) b.push(typeof x === 'string' ? x : `${x?.header || x?.label || x?.value || ''}${x?.text ? ': ' + x.text : ''}`); };
  push(s.bullets); if (s.callout?.text) b.push(`${s.callout.label || 'Key idea'}: ${s.callout.text}`);
  if (s.left) { b.push(`${s.left.heading || 'Left'}:`); push(s.left.bullets); } if (s.right) { b.push(`${s.right.heading || 'Right'}:`); push(s.right.bullets); }
  push(s.items); push(s.steps); push(s.stats); if (s.quote) b.push(s.quote); if (s.subtitle) b.push(s.subtitle);
  if (s.chart?.labels) b.push(`Chart (${s.chart.type || 'bar'}): ${s.chart.labels.join(', ')}`);
  return { slide_id: s.slide_id, title: s.title, bullets: b.filter(Boolean).slice(0, 12), code: s.code || '', notes: s.notes || '' };
}
