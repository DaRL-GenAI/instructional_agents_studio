// app.js — the Studio UI. Vanilla DOM, no framework.
import { Store, projectTotals, emptyStage } from './state.js';
import { Pipeline, safeJson, chunkText } from './pipeline.js';
import { FOUNDATION, CHAPTER_STAGES } from './prompts.js';
import { LLMClient } from './llm.js';
import { slideHTML, toBeamer, toHtmlDeck, toPptx } from './slides.js';
import { synthesize, recordVideo, buildVtt, mountPreview, pickMime } from './video.js';
import { download, textBlob, buildZip, slug, scriptMarkdown, transcriptMarkdown } from './export.js';

const $ = (sel, root = document) => root.querySelector(sel);
const append = (parent, ...kids) => { for (const k of kids.flat()) if (k) parent.append(k); return parent; };
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
const fmtTs = ts => ts ? new Date(ts).toLocaleString() : '—';

const store = new Store();
const pipe = new Pipeline(store);
const media = {};                    // chapterId -> {audios, video, vtt, cache}
let view = location.hash.slice(1) || (store.apiKey ? 'course' : 'setup');
let tab = 'output';
let busy = null;                     // description of running batch
let toastTimer;

// ------------------------------------------------------------ helpers
function toast(msg, kind = 'info') {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 8000 : 3500);
}
function nav(v, t) { view = v; if (t) tab = t; location.hash = v; render(); }
function stageStatus(stage, inputs) {
  if (!stage) return 'idle';
  if (stage.status === 'running') return 'running';
  if (stage.status === 'error') return 'error';
  if (stage.status === 'done' && inputs && pipe.isStale(stage, inputs)) return 'stale';
  if (stage.status === 'done' && stage.edited) return 'edited';
  return stage.status;
}
const STATUS_LABEL = { idle: 'Not run', running: 'Running', done: 'Generated', edited: 'Edited by you', stale: 'Inputs changed', error: 'Error' };

let markedReady;
async function renderMarkdown(md) {
  if (!window.marked) {
    markedReady ||= new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    await markedReady;
  }
  if (!window.marked) return `<pre>${esc(md)}</pre>`;
  return window.marked.parse(md, { gfm: true, breaks: false });
}

function requireKey() {
  if (!store.apiKey) { toast('Add your API key in Setup first.', 'error'); nav('setup'); return false; }
  if (!store.project.course.name.trim()) { toast('Give the course a name in Setup first.', 'error'); nav('setup'); return false; }
  return true;
}

async function guarded(label, fn) {
  if (busy) { toast(`Already running: ${busy}`, 'error'); return; }
  busy = label; render();
  try { await fn(); }
  catch (e) { console.error(e); toast(e.message || String(e), 'error'); }
  finally { busy = null; render(); }
}

// ------------------------------------------------------------ layout
function render() {
  const p = store.project;
  const totals = projectTotals(p);
  $('#status-chip').innerHTML = store.apiKey
    ? `<i class="dot ok"></i> ${esc(p.settings.model)} · ${totals.calls} calls · ${totals.tokens.toLocaleString()} tokens`
    : `<i class="dot"></i> No API key`;
  $('#busy').textContent = busy || '';
  $('#busy').hidden = !busy;
  renderRail();
  renderPanel();
  renderLive();
  document.querySelectorAll('.top-nav a').forEach(a => a.classList.toggle('active', view.startsWith(a.dataset.view)));
}

function renderRail() {
  const p = store.project;
  const rail = $('#rail'); rail.innerHTML = '';
  const item = (label, v, status, extra) => el('a', { href: `#${v}`, class: `rail-item ${view === v ? 'active' : ''}`, onclick: e => { e.preventDefault(); nav(v); } },
    el('i', { class: `dot ${status}` }), el('span', { class: 'rail-label' }, label), extra ? el('small', {}, extra) : null);
  rail.append(el('div', { class: 'rail-group' }, 'Start'), item('Setup & API key', 'setup', store.apiKey && p.course.name ? 'done' : 'idle'));
  rail.append(el('div', { class: 'rail-group' }, 'Course design (ADDIE)'));
  for (const f of FOUNDATION) rail.append(item(f.name, `foundation:${f.id}`, stageStatus(p.foundation[f.id], pipe.foundationInputs(f.id)), f.phase));
  rail.append(el('div', { class: 'rail-group' }, 'Chapters'), item(`Chapter list (${p.chapters.length})`, 'chapters', stageStatus(p.chaptersStage)));
  p.chapters.forEach((ch, i) => {
    const done = CHAPTER_STAGES.filter(s => ch.stages[s.id]?.status === 'done').length;
    const open = view.startsWith(`chapter:${ch.id}`);
    rail.append(item(`${i + 1}. ${ch.title}`, `chapter:${ch.id}:outline`, done === CHAPTER_STAGES.length ? 'done' : done ? 'partial' : 'idle', `${done}/${CHAPTER_STAGES.length}`));
    if (open) for (const s of CHAPTER_STAGES) {
      const v = `chapter:${ch.id}:${s.id}`;
      rail.append(el('a', { href: `#${v}`, class: `rail-item sub ${view === v ? 'active' : ''}`, onclick: e => { e.preventDefault(); nav(v); } }, el('i', { class: `dot ${stageStatus(ch.stages[s.id], pipe.chapterInputs(ch.id, s.id))}` }), el('span', { class: 'rail-label' }, s.name)));
    }
  });
  rail.append(el('div', { class: 'rail-group' }, 'Records'), item(`Audit trail (${p.audit.length})`, 'audit', 'idle'));
}

function renderPanel() {
  const panel = $('#panel'); panel.innerHTML = '';
  if (view === 'setup') return panel.append(setupView());
  if (view === 'course') return panel.append(courseOverview());
  if (view === 'chapters') return panel.append(chaptersView());
  if (view === 'audit') return panel.append(auditView());
  if (view.startsWith('foundation:')) return panel.append(foundationView(view.split(':')[1]));
  if (view.startsWith('chapter:')) { const [, chId, stId] = view.split(':'); return panel.append(chapterStageView(chId, stId)); }
  panel.append(courseOverview());
}

function renderLive() {
  const box = $('#live');
  if (!pipe.live) { box.hidden = true; return; }
  box.hidden = false;
  $('#live-agent').textContent = `${pipe.live.agent} is writing…`;
  const pre = $('#live-text'); pre.textContent = pipe.live.text; pre.scrollTop = pre.scrollHeight;
}
pipe.onLive = renderLive;

// ------------------------------------------------------------ setup view
function setupView() {
  const p = store.project, s = p.settings, c = p.course;
  const wrap = el('div', { class: 'view' });
  wrap.append(el('h1', {}, 'Setup'), el('p', { class: 'lede' }, 'Everything runs in your browser. Your API key is sent only to the API endpoint you configure below and is never sent to this website\'s host.'));

  const keyInput = el('input', { type: 'password', id: 'api-key', placeholder: 'sk-…', autocomplete: 'new-password', spellcheck: 'false', value: store.apiKey });
  const remember = el('input', { type: 'checkbox', id: 'remember' }); remember.checked = !!s.rememberKey;
  const baseUrl = el('input', { type: 'text', value: s.baseUrl, placeholder: 'https://api.openai.com/v1' });
  const modelInput = el('input', { type: 'text', value: s.model, list: 'model-list', placeholder: 'gpt-4o-mini' });
  const modelList = el('datalist', { id: 'model-list' }, ...['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini', 'gpt-5', 'o4-mini'].map(m => el('option', { value: m })));
  const ttsModel = el('select', {}, ...['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'].map(m => el('option', { value: m, selected: s.ttsModel === m }, m)));
  const voice = el('select', {}, ...['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(v => el('option', { value: v, selected: s.voice === v }, v)));
  const delib = el('select', {}, el('option', { value: 'full', selected: s.deliberation === 'full' }, 'Full deliberation — faculty → reviewer → summarizer (3 calls per stage, as in the paper)'), el('option', { value: 'quick', selected: s.deliberation === 'quick' }, 'Quick — one call per stage'));
  const temp = el('input', { type: 'number', step: '0.1', min: '0', max: '2', value: s.temperature, placeholder: 'model default' });
  const seed = el('input', { type: 'number', value: s.seed, placeholder: 'none' });
  const perChapter = el('input', { type: 'number', min: '4', max: '30', value: s.slidesPerChapter });
  const testBtn = el('button', { class: 'button', type: 'button' }, 'Test connection');
  const testOut = el('span', { class: 'hint' });

  const name = el('input', { type: 'text', value: c.name, placeholder: 'e.g. LLM-based Agents' });
  const subject = el('input', { type: 'text', value: c.subject, placeholder: 'e.g. Computer Science' });
  const level = el('select', {}, ...['Undergraduate', 'Graduate', 'Professional development', 'High school'].map(v => el('option', { value: v, selected: c.level === v }, v)));
  const audience = el('input', { type: 'text', value: c.audience, placeholder: 'e.g. 3rd-year CS students with Python experience' });
  const weeks = el('input', { type: 'number', min: '1', max: '30', value: c.weeks });
  const language = el('select', {}, ...['English', '中文', 'Español', 'Français', 'Deutsch', '日本語'].map(v => el('option', { value: v, selected: c.language === v }, v)));
  const notes = el('textarea', { rows: 4, placeholder: 'Anything the agents must respect: institution policies, required tools, topics to include or avoid, accreditation constraints…' }, c.notes);

  const tbInfo = el('p', { class: 'hint' }, p.textbook.chars ? `Loaded “${p.textbook.name}”: ${p.textbook.chars.toLocaleString()} characters in ${p.textbook.chunks.length} chunks. Relevant excerpts are retrieved per chapter and shown in each stage's Provenance tab.` : 'Optional. Upload a PDF or text file, or paste text. Excerpts are retrieved per chapter to ground slides, homework and labs.');
  const tbFile = el('input', { type: 'file', accept: '.pdf,.txt,.md' });
  const tbPaste = el('textarea', { rows: 3, placeholder: 'Or paste textbook / lecture-notes text here' });
  const tbBtn = el('button', { class: 'button small', type: 'button' }, 'Use pasted text');
  const tbClear = el('button', { class: 'button small', type: 'button' }, 'Remove textbook');

  const save = () => {
    Object.assign(s, { baseUrl: baseUrl.value.trim() || 'https://api.openai.com/v1', model: modelInput.value.trim() || 'gpt-4o-mini', ttsModel: ttsModel.value, voice: voice.value, deliberation: delib.value, temperature: temp.value, seed: seed.value, slidesPerChapter: Number(perChapter.value) || 10 });
    Object.assign(c, { name: name.value.trim(), subject: subject.value.trim(), level: level.value, audience: audience.value.trim(), weeks: Number(weeks.value) || 14, language: language.value, notes: notes.value.trim() });
    store.setKey(keyInput.value.trim(), remember.checked);
    store.log({ type: 'settings', model: s.model, baseUrl: s.baseUrl, deliberation: s.deliberation, course: c.name });
    store.save();
    toast('Saved.');
  };
  testBtn.onclick = async () => {
    testOut.textContent = 'Connecting…';
    try { const client = new LLMClient({ apiKey: keyInput.value.trim(), baseUrl: baseUrl.value.trim() }); const models = await client.listModels(); testOut.textContent = `OK — ${models.length} models available${models.includes(modelInput.value.trim()) ? '' : ` (note: “${modelInput.value.trim()}” not in the list)`}.`; }
    catch (e) { testOut.textContent = `Failed: ${e.message}`; }
  };
  const ingest = (nameStr, text) => {
    const chunks = chunkText(text);
    p.textbook = { name: nameStr, chars: text.length, chunks };
    store.log({ type: 'textbook', name: nameStr, chars: text.length, chunks: chunks.length });
    store.save(); toast(`Textbook loaded: ${chunks.length} chunks.`); render();
  };
  tbFile.onchange = async () => {
    const f = tbFile.files[0]; if (!f) return;
    try {
      tbInfo.textContent = 'Extracting text…';
      const text = f.name.toLowerCase().endsWith('.pdf') ? await extractPdfText(f, n => { tbInfo.textContent = `Extracting page ${n}…`; }) : await f.text();
      ingest(f.name, text);
    } catch (e) { toast(`Could not read file: ${e.message}`, 'error'); render(); }
  };
  tbBtn.onclick = () => { if (tbPaste.value.trim().length < 50) return toast('Paste at least a paragraph.', 'error'); ingest('pasted text', tbPaste.value); };
  tbClear.onclick = () => { p.textbook = { name: '', chars: 0, chunks: [] }; store.log({ type: 'textbook', removed: true }); store.save(); render(); };

  wrap.append(
    card('1 · Model & key', [
      field('API key', keyInput, 'OpenAI key (or a key for any OpenAI-compatible endpoint). Stored in this browser only.'),
      el('label', { class: 'check' }, remember, ' Remember key on this device (localStorage). Otherwise it is kept for this tab session only.'),
      row(field('API base URL', baseUrl, 'Change for Azure/OpenRouter/vLLM/Ollama-compatible servers.'), field('Text model', [modelInput, modelList])),
      row(field('Deliberation mode', delib), field('Slides per chapter', perChapter)),
      row(field('Temperature', temp, 'Leave empty to use the model default.'), field('Seed', seed, 'For reproducible runs when the provider supports it.')),
      row(field('Narration (TTS) model', ttsModel), field('Voice', voice)),
      el('div', { class: 'actions' }, testBtn, testOut),
    ]),
    card('2 · Course', [
      row(field('Course name', name), field('Subject area', subject)),
      row(field('Level', level), field('Duration (weeks)', weeks), field('Output language', language)),
      field('Target learners', audience),
      field('Instructor requirements', notes),
    ]),
    card('3 · Textbook grounding (optional)', [tbInfo, row(field('Upload PDF / TXT / MD', tbFile)), field('Paste text', tbPaste), el('div', { class: 'actions' }, tbBtn, p.textbook.chars ? tbClear : null)]),
    el('div', { class: 'actions sticky' }, el('button', { class: 'button primary', onclick: () => { save(); nav('course'); } }, 'Save and continue →'), el('button', { class: 'button', onclick: save }, 'Save'),
      el('button', { class: 'button danger', onclick: () => { if (confirm('Delete the whole project (all outputs, audit trail and key) from this browser?')) { store.reset(); store.forgetKey(); Object.keys(media).forEach(k => delete media[k]); nav('setup'); } } }, 'Reset project')),
  );
  return wrap;
}

let pdfjsReady;
async function extractPdfText(file, onPage) {
  if (!window.pdfjsLib) {
    pdfjsReady ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load pdf.js')); document.head.appendChild(s); });
    await pdfjsReady;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  const max = Math.min(pdf.numPages, 600);
  for (let i = 1; i <= max; i++) {
    onPage?.(i);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(it => it.str).join(' '));
  }
  return pages.join('\f');
}

const card = (title, children) => el('section', { class: 'card' }, el('h2', {}, title), ...children);
const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), ...[input].flat(), hint ? el('small', {}, hint) : null);
const row = (...fields) => el('div', { class: 'row' }, ...fields);

// ------------------------------------------------------------ course overview
function courseOverview() {
  const p = store.project;
  const wrap = el('div', { class: 'view' });
  wrap.append(el('h1', {}, p.course.name || 'Course design'), el('p', { class: 'lede' }, 'The six ADDIE deliberations of Instructional Agents. Run them in order, read the agents\' discussion, edit any deliverable, then extract chapters.'));
  const grid = el('div', { class: 'stage-grid' });
  for (const f of FOUNDATION) {
    const st = p.foundation[f.id];
    const status = stageStatus(st, pipe.foundationInputs(f.id));
    grid.append(el('button', { class: `stage-tile ${status}`, onclick: () => nav(`foundation:${f.id}`) },
      el('span', { class: 'tile-phase' }, f.phase), el('strong', {}, f.name), el('span', { class: `badge ${status}` }, STATUS_LABEL[status]),
      st?.output ? el('small', {}, `${st.output.length.toLocaleString()} chars · v${st.version}${st.usage ? ` · ${st.usage.total_tokens} tok` : ''}`) : el('small', {}, `${f.agents.length + 1} agents`)));
  }
  wrap.append(grid);
  const calls = p.settings.deliberation === 'full' ? 3 : 1;
  wrap.append(el('div', { class: 'actions' },
    el('button', { class: 'button primary', disabled: !!busy, onclick: () => runFoundationAll() }, `Run all six stages (${6 * calls} model calls)`),
    el('button', { class: 'button', onclick: () => nav('chapters') }, 'Go to chapters →'),
  ));
  return wrap;
}

async function runFoundationAll() {
  if (!requireKey()) return;
  await guarded('Running course design stages', async () => {
    for (const f of FOUNDATION) { if (store.project.foundation[f.id]?.status === 'done' && !pipe.isStale(store.project.foundation[f.id], pipe.foundationInputs(f.id))) continue; nav(`foundation:${f.id}`, 'transcript'); await pipe.runFoundation(f.id); }
    toast('Course design complete. Next: extract chapters.'); nav('chapters');
  });
}

// ------------------------------------------------------------ generic stage view
function foundationView(id) {
  const f = FOUNDATION.find(x => x.id === id);
  const stage = store.foundationStage(id);
  const inputs = pipe.foundationInputs(id);
  return stageView({
    title: f.name, subtitle: `${f.phase} phase · agents: ${f.agents.map(k => pipe.defaultFoundationPrompt(id).agents.find(a => a.key === k)?.name).join(', ')} → Summarizer`,
    stage, inputs, kind: 'md', file: f.file, label: f.name,
    defaultPrompt: () => pipe.defaultFoundationPrompt(id),
    run: () => guarded(`Running ${f.name}`, async () => { if (!requireKey()) return; tab = 'transcript'; await pipe.runFoundation(id); tab = 'output'; toast(`${f.name} generated.`); }),
    where: 'course',
    next: () => { const i = FOUNDATION.indexOf(f); return i < FOUNDATION.length - 1 ? `foundation:${FOUNDATION[i + 1].id}` : 'chapters'; },
  });
}

function chaptersView() {
  const p = store.project;
  const stage = p.chaptersStage;
  const wrap = el('div', { class: 'view' });
  wrap.append(el('h1', {}, 'Chapters'), el('p', { class: 'lede' }, 'The Syllabus Processor agent splits the syllabus into chapters. Edit titles and descriptions freely; each chapter then gets its own slides, script, homework, lab and video.'));
  const status = stageStatus(stage);
  const inputs = [{ label: 'Syllabus', text: p.foundation.syllabus?.output || '' }];
  wrap.append(el('div', { class: 'actions' },
    el('button', { class: 'button primary', disabled: !!busy || !inputs[0].text, onclick: () => guarded('Extracting chapters', async () => { if (!requireKey()) return; await pipe.runChaptersExtraction(); toast(`${store.project.chapters.length} chapters extracted.`); }) }, stage.status === 'done' ? 'Re-extract chapters from syllabus' : 'Extract chapters from syllabus'),
    el('button', { class: 'button', onclick: () => { store.addChapter({ title: 'New chapter', description: '' }); store.log({ type: 'edit', stage: 'Chapter list', where: 'course', note: 'chapter added' }); store.save(); render(); } }, '+ Add chapter'),
    !inputs[0].text ? el('span', { class: 'hint' }, 'Run the syllabus stage first.') : null,
    el('span', { class: `badge ${status}` }, STATUS_LABEL[status]),
  ));
  if (stage.transcript?.length) wrap.append(el('details', { class: 'card' }, el('summary', {}, 'Extraction prompt & response'), transcriptView(stage)));
  if (stage.error) wrap.append(el('p', { class: 'error' }, stage.error));
  const list = el('div', { class: 'chapter-list' });
  p.chapters.forEach((ch, i) => {
    const title = el('input', { type: 'text', value: ch.title });
    const desc = el('textarea', { rows: 2 }, ch.description);
    const commit = () => { if (title.value !== ch.title || desc.value !== ch.description) { ch.title = title.value; ch.description = desc.value; store.log({ type: 'edit', stage: 'Chapter list', where: ch.title, note: `chapter ${i + 1} edited` }); store.save(); renderRail(); } };
    title.onchange = commit; desc.onchange = commit;
    const done = CHAPTER_STAGES.filter(s => ch.stages[s.id]?.status === 'done').length;
    list.append(el('div', { class: 'chapter-row' },
      el('div', { class: 'chapter-num' }, String(i + 1)),
      el('div', { class: 'chapter-fields' }, title, desc),
      el('div', { class: 'chapter-actions' },
        el('span', { class: 'hint' }, `${done}/${CHAPTER_STAGES.length} stages`),
        el('button', { class: 'button small', onclick: () => nav(`chapter:${ch.id}:outline`) }, 'Open'),
        el('button', { class: 'button small', title: 'Move up', disabled: i === 0, onclick: () => { p.chapters.splice(i - 1, 0, p.chapters.splice(i, 1)[0]); store.save(); render(); } }, '↑'),
        el('button', { class: 'button small', title: 'Move down', disabled: i === p.chapters.length - 1, onclick: () => { p.chapters.splice(i + 1, 0, p.chapters.splice(i, 1)[0]); store.save(); render(); } }, '↓'),
        el('button', { class: 'button small danger', onclick: () => { if (confirm(`Remove chapter “${ch.title}” and its generated material?`)) { p.chapters.splice(i, 1); delete media[ch.id]; store.log({ type: 'edit', stage: 'Chapter list', note: `chapter removed: ${ch.title}` }); store.save(); render(); } } }, '✕'))));
  });
  wrap.append(list);
  if (p.chapters.length) {
    const remaining = p.chapters.reduce((a, ch) => a + CHAPTER_STAGES.filter(s => s.id !== 'video' && ch.stages[s.id]?.status !== 'done').length, 0);
    wrap.append(el('div', { class: 'actions' }, el('button', { class: 'button primary', disabled: !!busy || !remaining, onclick: () => runAllChapters() }, `Generate all remaining chapter materials (${remaining} model calls)`), el('span', { class: 'hint' }, 'Outline → slides → script → homework → lab for every chapter. Videos are produced per chapter on demand.')));
  }
  return wrap;
}

async function runAllChapters() {
  if (!requireKey()) return;
  await guarded('Generating chapter materials', async () => {
    for (const ch of store.project.chapters) for (const s of CHAPTER_STAGES) {
      if (s.id === 'video') continue;
      if (ch.stages[s.id]?.status === 'done') continue;
      nav(`chapter:${ch.id}:${s.id}`, 'transcript');
      await pipe.runChapterStage(ch.id, s.id);
    }
    toast('All chapter materials generated.'); nav('chapters');
  });
}

function chapterStageView(chId, stId) {
  const ch = store.chapter(chId);
  if (!ch) return el('p', {}, 'Chapter not found.');
  const st = CHAPTER_STAGES.find(s => s.id === stId);
  const stage = store.chapterStage(chId, stId);
  const inputs = pipe.chapterInputs(chId, stId);
  const idx = store.project.chapters.indexOf(ch);
  if (stId === 'video') return videoView(ch, stage, inputs);
  const agent = pipe.defaultChapterPrompt(chId, stId).agents[0];
  return stageView({
    title: `${st.name}`, subtitle: `Chapter ${idx + 1}: ${ch.title} · agent: ${agent.name} (${agent.role})`,
    stage, inputs, kind: st.kind, file: st.file, label: `${ch.title} / ${st.name}`, where: ch.title, chapter: ch,
    defaultPrompt: () => pipe.defaultChapterPrompt(chId, stId),
    run: () => guarded(`Running ${st.name} for ${ch.title}`, async () => { if (!requireKey()) return; tab = 'transcript'; await pipe.runChapterStage(chId, stId); tab = 'output'; toast(`${st.name} generated.`); }),
    runAll: () => guarded(`Generating chapter ${idx + 1}`, async () => {
      if (!requireKey()) return;
      for (const s of CHAPTER_STAGES) { if (s.id === 'video' || ch.stages[s.id]?.status === 'done') continue; nav(`chapter:${chId}:${s.id}`, 'transcript'); await pipe.runChapterStage(chId, s.id); }
      tab = 'output'; toast(`Chapter ${idx + 1} materials generated.`);
    }),
    next: () => { const i = CHAPTER_STAGES.indexOf(st); return i < CHAPTER_STAGES.length - 1 ? `chapter:${chId}:${CHAPTER_STAGES[i + 1].id}` : (idx < store.project.chapters.length - 1 ? `chapter:${store.project.chapters[idx + 1].id}:outline` : 'chapters'); },
  });
}

function stageView(o) {
  const { stage, inputs } = o;
  const status = stageStatus(stage, inputs);
  const wrap = el('div', { class: 'view' });
  wrap.append(el('div', { class: 'stage-head' },
    el('div', {}, el('h1', {}, o.title), el('p', { class: 'lede' }, o.subtitle)),
    el('div', { class: 'stage-meta' }, el('span', { class: `badge ${status}` }, STATUS_LABEL[status]),
      stage.ranAt ? el('small', {}, `v${stage.version} · ${fmtTs(stage.ranAt)} · ${stage.usage?.total_tokens ?? '?'} tokens${stage.usage?.estimated ? ' (est.)' : ''} · ${fmtMs(stage.durationMs || 0)}`) : null,
      stage.reviewed ? el('small', { class: 'ok' }, '✓ Marked as reviewed') : null)));
  if (status === 'stale') wrap.append(el('p', { class: 'warn' }, 'The inputs of this stage changed after it was generated (see Provenance). Re-run it or keep the current text deliberately.'));
  if (stage.error) wrap.append(el('p', { class: 'error' }, `Last run failed: ${stage.error}`));

  const running = stage.status === 'running';
  const actions = el('div', { class: 'actions' },
    el('button', { class: 'button primary', disabled: !!busy, onclick: o.run }, stage.status === 'done' ? '↻ Re-run stage' : '▶ Run stage'),
    o.runAll ? el('button', { class: 'button', disabled: !!busy, onclick: o.runAll }, '▶▶ Run remaining stages of this chapter') : null,
    running ? el('button', { class: 'button danger', onclick: () => pipe.cancel() }, 'Cancel') : null,
    stage.output ? el('button', { class: 'button', onclick: () => { stage.reviewed = !stage.reviewed; store.log({ type: stage.reviewed ? 'approve' : 'unapprove', stage: o.label, where: o.where, version: stage.version }); store.save(); render(); } }, stage.reviewed ? 'Unmark reviewed' : '✓ Mark as reviewed') : null,
    stage.output ? el('button', { class: 'button', onclick: () => downloadStage(o) }, '⬇ Download') : null,
    stage.output && o.kind !== 'json' ? el('button', { class: 'button', disabled: !!busy, onclick: () => guarded('Reviewing', async () => { if (!requireKey()) return; const r = await pipe.review(o.title, stageText(o), o.where); stage.review = r; store.save(); tab = 'review'; render(); }) }, '🔍 Ask Program Chair to review') : null,
    stage.output ? el('button', { class: 'button', onclick: () => nav(o.next()) }, 'Next →') : null,
  );
  wrap.append(actions);

  const tabs = [['output', 'Output'], ['prompt', 'Prompt'], ['transcript', `Transcript${stage.transcript?.length ? ` (${stage.transcript.length})` : ''}`], ['provenance', 'Provenance'], ['history', `History${stage.history?.length ? ` (${stage.history.length})` : ''}`]];
  if (stage.review) tabs.push(['review', `Review (${stage.review.score}/10)`]);
  wrap.append(el('div', { class: 'tabs' }, ...tabs.map(([k, l]) => el('button', { class: `tab ${tab === k ? 'active' : ''}`, onclick: () => { tab = k; render(); } }, l))));
  const body = el('div', { class: 'tab-body' });
  if (tab === 'output') body.append(outputEditor(o));
  if (tab === 'prompt') body.append(promptEditor(o));
  if (tab === 'transcript') body.append(transcriptView(stage));
  if (tab === 'provenance') body.append(provenanceView(stage, inputs));
  if (tab === 'history') body.append(historyView(o));
  if (tab === 'review') body.append(reviewView(stage));
  wrap.append(body);
  return wrap;
}

function stageText(o) {
  const st = o.stage;
  if (o.kind === 'script') return scriptMarkdown(o.chapter, safeJson(st.output, []));
  return st.output;
}

function downloadStage(o) {
  const st = o.stage;
  if (o.kind === 'slides') {
    const slides = safeJson(st.output, []); const script = safeJson(o.chapter.stages.script?.output, []);
    const menu = el('div', { class: 'menu' },
      el('button', { class: 'button small', onclick: () => download(textBlob(toHtmlDeck(store.project.course, o.chapter, slides, script), 'text/html'), `${slug(o.chapter.title)}_slides.html`) }, 'HTML deck'),
      el('button', { class: 'button small', onclick: () => download(textBlob(toBeamer(store.project.course, o.chapter, slides, script), 'text/x-tex'), `${slug(o.chapter.title)}_slides.tex`) }, 'Beamer .tex'),
      el('button', { class: 'button small', onclick: async () => { try { download(await toPptx(store.project.course, o.chapter, slides, script), `${slug(o.chapter.title)}_slides.pptx`); } catch (e) { toast(e.message, 'error'); } } }, 'PowerPoint .pptx'),
      el('button', { class: 'button small', onclick: () => download(textBlob(st.output, 'application/json'), `${slug(o.chapter.title)}_slides.json`) }, 'JSON'));
    showModal('Download slides as…', menu); return;
  }
  const name = o.chapter ? `${slug(o.chapter.title)}_${o.file}` : o.file;
  download(textBlob(stageText(o), o.kind === 'json' ? 'application/json' : 'text/markdown'), name);
  store.log({ type: 'export', stage: o.label, file: name });
}

function showModal(title, content) {
  const m = $('#modal'); m.innerHTML = ''; m.append(el('div', { class: 'modal-box' }, el('h3', {}, title), content, el('button', { class: 'button small', onclick: () => m.close() }, 'Close'))); m.showModal();
}

// ---- output editors
function outputEditor(o) {
  const st = o.stage;
  if (!st.output) return el('p', { class: 'hint' }, st.status === 'running' ? 'Generating… watch the live panel on the right.' : 'Nothing generated yet. Check the Prompt tab, then press Run.');
  if (o.kind === 'slides') return slidesEditor(o);
  if (o.kind === 'script') return scriptEditor(o);
  const box = el('div', { class: 'editor-split' });
  const ta = el('textarea', { class: 'editor', spellcheck: 'false' }, st.output);
  const preview = el('div', { class: 'preview md' });
  const refresh = async () => { preview.innerHTML = o.kind === 'json' ? `<pre>${esc(ta.value)}</pre>` : await renderMarkdown(ta.value); };
  refresh();
  let t; ta.oninput = () => { clearTimeout(t); t = setTimeout(refresh, 400); };
  const saveBtn = el('button', { class: 'button primary small', onclick: () => { if (o.kind === 'json') { try { JSON.parse(ta.value); } catch (e) { return toast(`Invalid JSON: ${e.message}`, 'error'); } } if (store.userEdit(st, o.label, ta.value, o.where)) { toast('Edit saved and logged.'); render(); } else toast('No changes.'); } }, 'Save edits');
  const revert = el('button', { class: 'button small', onclick: () => { ta.value = st.output; refresh(); } }, 'Discard changes');
  box.append(el('div', { class: 'editor-col' }, el('div', { class: 'editor-bar' }, el('span', {}, 'Editable source'), saveBtn, revert), ta), el('div', { class: 'editor-col' }, el('div', { class: 'editor-bar' }, el('span', {}, 'Preview')), preview));
  return box;
}

function slidesEditor(o) {
  const st = o.stage; const ch = o.chapter;
  const slides = safeJson(st.output, []);
  const box = el('div', { class: 'slides-editor' });
  const list = el('div', { class: 'slide-list' });
  const preview = el('div', { class: 'slide-preview' });
  let current = 0;
  const meta = { course: store.project.course.name, chapter: ch.title };
  const showPreview = () => { preview.innerHTML = slideHTML(slides[current], current, slides.length, meta); };
  const rebuildList = () => {
    list.innerHTML = '';
    slides.forEach((s, i) => list.append(el('button', { class: `slide-thumb ${i === current ? 'active' : ''}`, onclick: () => { current = i; rebuildList(); showPreview(); buildForm(); } }, el('b', {}, `${i + 1}`), el('span', {}, s.title))));
  };
  const form = el('div', { class: 'slide-form' });
  const buildForm = () => {
    const s = slides[current]; form.innerHTML = '';
    const title = el('input', { type: 'text', value: s.title });
    const bullets = el('textarea', { rows: 6 }, (s.bullets || []).join('\n'));
    const code = el('textarea', { rows: 5, class: 'mono', placeholder: 'optional code / formula' }, s.code || '');
    const notes = el('textarea', { rows: 3 }, s.notes || '');
    const upd = () => { s.title = title.value; s.bullets = bullets.value.split('\n').map(x => x.trim()).filter(Boolean); s.code = code.value; s.notes = notes.value; showPreview(); rebuildList(); };
    for (const i of [title, bullets, code, notes]) i.oninput = upd;
    form.append(field('Title', title), field('Bullets (one per line)', bullets), field('Code / formula', code), field('Teaching notes', notes),
      el('div', { class: 'actions' },
        el('button', { class: 'button small', onclick: () => { slides.splice(current + 1, 0, { slide_id: 0, title: 'New slide', bullets: [], code: '', code_language: '', notes: '' }); current++; renumber(); rebuildList(); showPreview(); buildForm(); } }, '+ Insert slide after'),
        el('button', { class: 'button small danger', disabled: slides.length < 2, onclick: () => { slides.splice(current, 1); current = Math.max(0, current - 1); renumber(); rebuildList(); showPreview(); buildForm(); } }, 'Delete slide')));
  };
  const renumber = () => slides.forEach((s, i) => { s.slide_id = i + 1; });
  const save = () => { if (store.userEdit(st, o.label, JSON.stringify(slides, null, 2), o.where)) { toast('Slides saved and logged.'); render(); } else toast('No changes.'); };
  box.append(el('div', { class: 'editor-bar' }, el('span', {}, `${slides.length} slides — click a slide to edit`), el('button', { class: 'button primary small', onclick: save }, 'Save edits'), el('button', { class: 'button small', onclick: () => render() }, 'Discard changes')),
    el('div', { class: 'slides-grid' }, list, el('div', {}, preview, form)));
  rebuildList(); showPreview(); buildForm();
  return box;
}

function scriptEditor(o) {
  const st = o.stage; const script = safeJson(st.output, []);
  const box = el('div', { class: 'script-editor' });
  const words = script.reduce((a, s) => a + (s.narration || '').split(/\s+/).filter(Boolean).length, 0);
  box.append(el('div', { class: 'editor-bar' }, el('span', {}, `${script.length} narration blocks · ~${words} words · ≈${Math.round(words / 2.5 / 60)} min spoken`), el('button', { class: 'button primary small', onclick: () => { if (store.userEdit(st, o.label, JSON.stringify(script, null, 2), o.where)) { toast('Script saved and logged.'); render(); } else toast('No changes.'); } }, 'Save edits'), el('button', { class: 'button small', onclick: () => render() }, 'Discard changes')));
  script.forEach((s, i) => {
    const ta = el('textarea', { rows: 4 }, s.narration); ta.oninput = () => { s.narration = ta.value; };
    box.append(el('div', { class: 'script-row' }, el('div', { class: 'script-label' }, el('b', {}, `Slide ${i + 1}`), el('span', {}, s.title)), ta));
  });
  return box;
}

// ---- prompt editor
function promptEditor(o) {
  const st = o.stage;
  const prompt = st.prompt?.custom ? st.prompt : (st.status === 'done' && st.prompt ? st.prompt : o.defaultPrompt());
  const isCustom = !!st.prompt?.custom;
  const box = el('div', { class: 'prompt-editor' });
  box.append(el('p', { class: 'hint' }, isCustom ? 'This stage uses a custom prompt you saved. It will be used as-is on the next run.' : (st.status === 'done' ? 'This is the exact prompt used for the current output. Defaults are rebuilt from the latest inputs on every run; save a custom version to pin it.' : 'This is the prompt that will be sent. Edit and save to customize.')));
  const agentBoxes = prompt.agents.map(a => { const ta = el('textarea', { rows: 4 }, a.system); return { a, ta, node: field(`System prompt — ${a.name} (${a.role})`, ta) }; });
  const sumTa = prompt.summarizer ? el('textarea', { rows: 3 }, prompt.summarizer.system) : null;
  const userTa = el('textarea', { rows: 14, class: 'mono' }, prompt.user);
  const modeSel = prompt.mode ? el('select', {}, el('option', { value: 'full', selected: prompt.mode === 'full' }, 'Full deliberation (3 calls)'), el('option', { value: 'quick', selected: prompt.mode === 'quick' }, 'Quick (1 call)')) : null;
  box.append(...agentBoxes.map(x => x.node));
  if (sumTa) box.append(field('System prompt — Summarizer', sumTa));
  if (modeSel) box.append(field('Mode', modeSel));
  box.append(field('User prompt (task + context)', userTa));
  box.append(el('div', { class: 'actions' },
    el('button', { class: 'button primary small', onclick: () => { st.prompt = { ...prompt, custom: true, agents: agentBoxes.map(x => ({ ...x.a, system: x.ta.value })), summarizer: sumTa ? { ...prompt.summarizer, system: sumTa.value } : undefined, user: userTa.value, mode: modeSel ? modeSel.value : undefined }; store.log({ type: 'prompt_edit', stage: o.label, where: o.where }); store.save(); toast('Custom prompt saved.'); render(); } }, 'Save custom prompt'),
    isCustom ? el('button', { class: 'button small', onclick: () => { st.prompt = null; store.log({ type: 'prompt_reset', stage: o.label, where: o.where }); store.save(); render(); } }, 'Reset to default') : null,
    el('button', { class: 'button small', onclick: () => navigator.clipboard.writeText(`SYSTEM:\n${agentBoxes.map(x => x.ta.value).join('\n---\n')}\n\nUSER:\n${userTa.value}`).then(() => toast('Copied.')) }, 'Copy')));
  return box;
}

// ---- transcript / provenance / history / review
function transcriptView(stage) {
  const box = el('div', { class: 'transcript' });
  if (!stage.transcript?.length) { box.append(el('p', { class: 'hint' }, 'No model calls recorded for this stage yet.')); return box; }
  stage.transcript.forEach((t, i) => {
    box.append(el('details', { class: 'turn', open: i === stage.transcript.length - 1 },
      el('summary', {}, el('b', {}, `${i + 1}. ${t.role}`), el('span', { class: 'hint' }, ` ${t.model || ''}${t.usage ? ` · ${t.usage.prompt_tokens}→${t.usage.completion_tokens} tokens` : ''}${t.ms ? ` · ${fmtMs(t.ms)}` : ''}`)),
      el('details', {}, el('summary', {}, 'System prompt'), el('pre', {}, t.system)),
      el('details', {}, el('summary', {}, 'User prompt'), el('pre', {}, t.user)),
      el('div', { class: 'turn-response' }, el('div', { class: 'hint' }, 'Response'), el('pre', {}, t.text || '(streaming…)'))));
  });
  return box;
}

function provenanceView(stage, inputs) {
  const box = el('div', { class: 'provenance' });
  box.append(el('p', { class: 'hint' }, 'Inputs this stage reads. Hashes let you verify that a stored output was produced from exactly these inputs.'));
  const table = el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Input'), el('th', {}, 'Current hash'), el('th', {}, 'Hash at last run'), el('th', {}, 'Chars'))));
  const tb = el('tbody', {});
  for (const i of inputs) {
    const used = stage.provenance?.find(p => p.label === i.label);
    const h = hashOf(i.text);
    tb.append(el('tr', { class: used && used.hash !== h ? 'changed' : '' }, el('td', {}, i.label), el('td', { class: 'mono' }, h), el('td', { class: 'mono' }, used?.hash || '—'), el('td', {}, i.text.length.toLocaleString())));
  }
  table.append(tb); box.append(table);
  const chunks = inputs.find(i => i.chunks)?.chunks;
  if (chunks?.length) box.append(el('h3', {}, 'Retrieved textbook excerpts'), ...chunks.map((c, i) => el('details', {}, el('summary', {}, `Excerpt ${i + 1}${c.page ? ` · page ${c.page}` : ''} · score ${c.score}`), el('pre', {}, c.text))));
  if (stage.outputHash) box.append(el('p', { class: 'hint mono' }, `Output hash: ${stage.outputHash} · version ${stage.version} · ${stage.edited ? 'contains user edits' : 'model output'}`));
  return box;
}
import { sha1Short as hashOf } from './llm.js';

function historyView(o) {
  const st = o.stage; const box = el('div', {});
  if (!st.history?.length) return el('p', { class: 'hint' }, 'No earlier versions.');
  [...st.history].reverse().forEach(h => box.append(el('details', { class: 'turn' }, el('summary', {}, `Version ${h.version} · ${h.reason} · ${fmtTs(h.at)} · ${(h.output || '').length.toLocaleString()} chars`), el('pre', {}, h.output), el('button', { class: 'button small', onclick: () => { if (store.userEdit(st, o.label, h.output, o.where)) { toast(`Restored version ${h.version}.`); render(); } } }, 'Restore this version'))));
  return box;
}

function reviewView(stage) {
  const r = stage.review;
  return el('div', { class: 'review' }, el('p', {}, el('b', {}, `Program Chair score: ${r.score}/10`)), el('h3', {}, 'Issues'), el('ul', {}, ...(r.issues || []).map(x => el('li', {}, x))), el('h3', {}, 'Strengths'), el('ul', {}, ...(r.strengths || []).map(x => el('li', {}, x))));
}

// ------------------------------------------------------------ video view
function videoView(ch, stage, inputs) {
  const p = store.project;
  const wrap = el('div', { class: 'view' });
  const slides = safeJson(ch.stages.slides?.output, null);
  const script = safeJson(ch.stages.script?.output, null);
  const m = media[ch.id] ||= { audios: null, video: null, vtt: null, cache: new Map() };
  wrap.append(el('div', { class: 'stage-head' }, el('div', {}, el('h1', {}, 'Lecture video'), el('p', { class: 'lede' }, `Chapter: ${ch.title}. Narration is synthesized per slide with the TTS model; the deck is drawn on a canvas and recorded in your browser. Nothing is uploaded anywhere except the narration text sent to the TTS endpoint.`))));
  if (!slides || !script) { wrap.append(el('p', { class: 'warn' }, 'Generate the slides and the lecture script for this chapter first.')); return wrap; }
  if (slides.length !== script.length) wrap.append(el('p', { class: 'warn' }, `The script has ${script.length} entries but the deck has ${slides.length} slides. Re-run the script stage after editing slides.`));
  const status = stageStatus(stage, inputs);
  const chars = script.reduce((a, s) => a + (s.narration || '').length, 0);
  const themeSel = el('select', {}, el('option', { value: 'studio' }, 'Studio light'), el('option', { value: 'dark' }, 'Academic dark'));
  const voiceSel = el('select', {}, ...['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(v => el('option', { value: v, selected: p.settings.voice === v }, v)));
  const progress = el('p', { class: 'hint', id: 'video-progress' }, stage.output ? stage.output : `${slides.length} slides · ${chars.toLocaleString()} characters of narration to synthesize`);
  const previewBox = el('div', { class: 'video-preview' });
  const meta = { course: p.course.name, chapter: ch.title };
  const mime = pickMime();

  const synthBtn = el('button', { class: 'button primary', disabled: !!busy, onclick: () => guarded('Synthesizing narration', async () => {
    if (!requireKey()) return;
    m.audios = await synthesize(pipe.client, store, script, { where: ch.title, voice: voiceSel.value, cache: m.cache, onProgress: e => { progress.textContent = e.text; } });
    m.vtt = buildVtt(script, m.audios);
    const secs = m.audios.reduce((a, x) => a + (x.seconds || 0), 0);
    store.applyResult(stage, `${ch.title} / Lecture video`, { output: `Narration ready: ${m.audios.length} clips, ${Math.round(secs)} s of audio (voice ${voiceSel.value}). Video not yet recorded.`, usage: null, durationMs: 0, transcript: [], inputHash: pipe.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: hashOf(i.text), version: i.version })) }, ch.title, { narrationSeconds: secs, voice: voiceSel.value });
    mountPreview(previewBox, { slides, script, audios: m.audios, meta, theme: themeSel.value });
    toast('Narration synthesized. Preview it, then record.');
  }) }, m.audios ? '↻ Re-synthesize narration' : '1 · Synthesize narration');

  const recBtn = el('button', { class: 'button primary', disabled: !!busy || !m.audios || !mime, onclick: () => guarded('Recording video', async () => {
    const ctrl = new AbortController(); pipe.abort = ctrl;
    progress.textContent = 'Recording… keep this tab visible until it finishes.';
    const res = await recordVideo({ slides, script, audios: m.audios, meta, theme: themeSel.value, signal: ctrl.signal, onProgress: e => { progress.textContent = e.text; } });
    m.video = res;
    store.log({ type: 'video', where: ch.title, seconds: res.seconds, bytes: res.blob.size, mime: res.mime, slides: slides.length });
    stage.output = `Video recorded: ${Math.round(res.seconds)} s, ${(res.blob.size / 1e6).toFixed(1)} MB (${res.mime}). Narration: ${m.audios.length} clips.`;
    stage.timeline = res.timeline; store.save();
    previewBox.innerHTML = ''; const v = el('video', { controls: true, class: 'video-player' }); v.src = URL.createObjectURL(res.blob); previewBox.append(v);
    toast('Video recorded.');
  }) }, m.video ? '↻ Re-record video' : '2 · Record video');

  const dl = el('div', { class: 'actions' },
    m.video ? el('button', { class: 'button', onclick: () => download(m.video.blob, `${slug(ch.title)}_lecture.${m.video.mime.includes('mp4') ? 'mp4' : 'webm'}`) }, '⬇ Video') : null,
    m.vtt ? el('button', { class: 'button', onclick: () => download(textBlob(m.vtt, 'text/vtt'), `${slug(ch.title)}_captions.vtt`) }, '⬇ Captions (.vtt)') : null,
    m.audios ? el('button', { class: 'button', onclick: async () => { const JSZip = await (await import('./export.js')).loadJSZip(); const z = new JSZip(); m.audios.forEach((a, i) => a?.buffer && z.file(`slide_${String(i + 1).padStart(2, '0')}.mp3`, a.buffer)); download(await z.generateAsync({ type: 'blob' }), `${slug(ch.title)}_narration.zip`); } }, '⬇ Narration MP3s') : null,
    el('button', { class: 'button', onclick: () => download(textBlob(scriptMarkdown(ch, script), 'text/markdown'), `${slug(ch.title)}_script.md`) }, '⬇ Script'));

  wrap.append(el('div', { class: 'actions' }, el('span', { class: `badge ${status}` }, STATUS_LABEL[status]), field('Theme', themeSel), field('Voice', voiceSel)),
    el('div', { class: 'actions' }, synthBtn, recBtn, busy ? el('button', { class: 'button danger', onclick: () => pipe.cancel() }, 'Cancel') : null),
    progress, el('div', {}, !mime ? el('p', { class: 'warn' }, 'This browser cannot record WebM video. Use Chrome, Edge or Firefox; narration MP3s and the HTML deck still work.') : null),
    previewBox, dl,
    el('details', { class: 'card' }, el('summary', {}, 'How the video is made (auditable)'), el('ol', {},
      el('li', {}, `Each narration block is sent to ${p.settings.ttsModel} (voice selectable). Every TTS call is logged with slide number, characters and duration.`),
      el('li', {}, 'Slides are drawn deterministically from the slide JSON you can edit in the Slides stage: title, bullets, code and footer.'),
      el('li', {}, 'The canvas and the decoded audio are captured with the browser MediaRecorder API into a WebM file. Captions are timed proportionally to sentence length; the .vtt file is downloadable.'),
      el('li', {}, 'For a LaTeX-Beamer PDF video with the same script, export the .tex and run the Python pipeline with --video.'))));
  if (m.audios && !m.video) setTimeout(() => mountPreview(previewBox, { slides, script, audios: m.audios, meta, theme: themeSel.value }), 0);
  if (m.video) setTimeout(() => { const v = el('video', { controls: true, class: 'video-player' }); v.src = URL.createObjectURL(m.video.blob); previewBox.append(v); }, 0);
  return wrap;
}

// ------------------------------------------------------------ audit view
function auditView() {
  const p = store.project;
  const wrap = el('div', { class: 'view' });
  const totals = projectTotals(p);
  wrap.append(el('h1', {}, 'Audit trail'), el('p', { class: 'lede' }, 'Every model call, TTS call, edit, prompt change, approval and export, in order. Stored in this browser; export it with the project.'));
  wrap.append(el('div', { class: 'kpis' }, kpi('Model calls', p.audit.filter(a => a.type === 'llm_call').length), kpi('Tokens', totals.tokens.toLocaleString()), kpi('TTS characters', totals.ttsChars.toLocaleString()), kpi('User edits', p.audit.filter(a => a.type === 'edit').length), kpi('Stages done', totals.done)));
  const filter = el('select', {}, el('option', { value: '' }, 'All events'), ...['llm_call', 'tts_call', 'stage_done', 'edit', 'prompt_edit', 'approve', 'export', 'settings', 'textbook', 'video'].map(t => el('option', { value: t }, t)));
  const table = el('table', { class: 'table audit-table' });
  const draw = () => {
    table.innerHTML = '';
    table.append(el('thead', {}, el('tr', {}, ...['#', 'Time', 'Type', 'Where', 'Stage', 'Agent / model', 'Status', 'Tokens / chars', 'Time', 'Hash'].map(h => el('th', {}, h)))));
    const tb = el('tbody', {});
    [...p.audit].reverse().filter(a => !filter.value || a.type === filter.value).forEach(a => tb.append(el('tr', { class: a.status === 'error' ? 'changed' : '', title: a.error || '' },
      el('td', {}, a.id), el('td', {}, new Date(a.ts).toLocaleTimeString()), el('td', {}, a.type), el('td', {}, a.where || ''), el('td', {}, a.stage || ''), el('td', {}, a.agent || a.model || ''), el('td', {}, a.status || ''),
      el('td', {}, a.tokens != null ? `${a.tokens}${a.estimated ? '*' : ''}` : (a.chars != null ? `${a.chars} ch` : '')), el('td', {}, a.ms != null ? fmtMs(a.ms) : ''), el('td', { class: 'mono' }, a.hash || a.responseHash || a.promptHash || ''))));
    table.append(tb);
  };
  filter.onchange = draw; draw();
  wrap.append(el('div', { class: 'actions' }, filter,
    el('button', { class: 'button', onclick: () => download(textBlob(JSON.stringify(p.audit, null, 2), 'application/json'), `${slug(p.course.name)}_audit_log.json`) }, '⬇ Audit JSON'),
    el('button', { class: 'button', onclick: () => download(textBlob(JSON.stringify(p, null, 2), 'application/json'), `${slug(p.course.name)}_project.json`) }, '⬇ Project JSON'),
    importButton()), table);
  return wrap;
}
const kpi = (label, value) => el('div', { class: 'kpi' }, el('b', {}, String(value)), el('span', {}, label));
function importButton() {
  const inp = el('input', { type: 'file', accept: '.json', hidden: true });
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (!j.course || !j.foundation) throw new Error('not a Studio project'); store.replace(j); toast('Project imported.'); nav('course'); } catch (e) { toast(`Import failed: ${e.message}`, 'error'); } };
  return el('span', {}, inp, el('button', { class: 'button', onclick: () => inp.click() }, '⬆ Import project JSON'));
}

// ------------------------------------------------------------ export all
async function exportAll() {
  await guarded('Building ZIP', async () => {
    const blob = await buildZip(store.project, media);
    download(blob, `${slug(store.project.course.name)}_instructional_agents.zip`);
    store.log({ type: 'export', file: 'zip', bytes: blob.size }); store.save();
    toast('ZIP ready.');
  });
}

// ------------------------------------------------------------ boot
function boot() {
  $('#export-all').onclick = exportAll;
  $('#live-close').onclick = () => { $('#live').hidden = true; };
  document.querySelectorAll('.top-nav a').forEach(a => a.onclick = e => { e.preventDefault(); nav(a.dataset.view); });
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== view) { view = h; render(); } });
  window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
  store.on(() => { /* state saved */ });
  render();
}
boot();
