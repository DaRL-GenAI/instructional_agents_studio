// views/basics.js — course facts, learners, grounding materials, per-project generation overrides.
import { el, button, field, input, select, textarea, notice, empty, icon, toast, loadScript, confirmDialog } from '../ui.js';
import { account } from '../state.js';
import { chunkText } from '../pipeline.js';

export function render(ctx) {
  const { store } = ctx; const p = store.project; const c = p.course;
  const page = el('div', { class: 'page' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Course basics'), el('p', {}, 'Everything the agents know before they start. Changing these marks downstream deliverables as “inputs changed” so you can decide whether to regenerate.'))));

  const name = input({ value: c.name }); const subject = input({ value: c.subject }); const level = select(['Undergraduate', 'Graduate', 'Professional development', 'High school'], c.level);
  const weeks = input({ type: 'number', min: 1, max: 30, value: c.weeks }); const language = select(['English', '中文', 'Español', 'Français', 'Deutsch', '日本語'], c.language);
  const audience = textarea({ rows: 3, placeholder: 'e.g. 3rd-year CS students, ~60 per section, comfortable with Python, little ML background' }, c.audience);
  const notes = textarea({ rows: 5, placeholder: 'Institution policies, required tools or platforms, accreditation constraints, topics to include or avoid, tone…' }, c.notes);
  const save = () => { const before = JSON.stringify(c); Object.assign(c, { name: name.value.trim(), subject: subject.value.trim(), level: level.value, weeks: Number(weeks.value) || 14, language: language.value, audience: audience.value.trim(), notes: notes.value.trim() }); if (JSON.stringify(c) !== before) { store.log({ type: 'edit', stage: 'Course basics', where: 'course' }); store.save(); toast('Saved', 'ok'); ctx.render(); } else toast('No changes'); };

  page.append(section('Course', null, el('div', { class: 'form-grid' }, field('Course name', name), field('Subject area', subject), field('Level', level), field('Duration (weeks)', weeks), field('Language of the materials', language))),
    section('Learners', 'Used by the Learner Analysis deliberation and echoed into every prompt.', el('div', { class: 'form-grid' }, el('div', { class: 'span-2' }, field('Who takes this course', audience)))),
    section('Instructor requirements', 'Free text the agents must respect.', el('div', { class: 'form-grid' }, el('div', { class: 'span-2' }, field('Requirements and constraints', notes)))),
    el('div', { class: 'btn-row' }, button({ label: 'Save basics', variant: 'primary', onClick: save })));

  page.append(materialsSection(ctx));
  page.append(overridesSection(ctx));
  return page;
}

function materialsSection(ctx) {
  const { store } = ctx; const p = store.project;
  const box = el('div', { style: 'display:flex;flex-direction:column;gap:14px;max-width:720px' });
  if (p.textbook.chars) box.append(el('div', { class: 'panel', style: 'padding:14px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap' }, icon('book', 'lg'), el('div', { style: 'flex:1' }, el('b', {}, p.textbook.name), el('div', { class: 'meta' }, `${p.textbook.chars.toLocaleString()} characters · ${p.textbook.chunks.length} retrieval chunks · excerpts are retrieved per chapter and listed under each stage’s Provenance tab`)), button({ label: 'Remove', variant: 'danger', size: 'sm', onClick: async () => { if (await confirmDialog({ title: 'Remove the textbook?', body: 'Stages that used excerpts will show “inputs changed”.', confirmLabel: 'Remove', danger: true })) { p.textbook = { name: '', chars: 0, chunks: [] }; store.log({ type: 'textbook', removed: true }); store.save(); ctx.render(); } } })));
  else box.append(notice('info', 'Optional. Upload a textbook, lecture notes or a syllabus PDF; relevant excerpts are retrieved for each chapter to ground slides, homework, labs and quizzes. Text is processed in your browser; only the retrieved excerpts are included in prompts.'));
  const file = el('input', { type: 'file', accept: '.pdf,.txt,.md', class: 'input' });
  const paste = textarea({ rows: 3, placeholder: 'Or paste text here' });
  const status = el('span', { class: 'meta' });
  const ingest = (nameStr, text) => { const chunks = chunkText(text); p.textbook = { name: nameStr, chars: text.length, chunks }; store.log({ type: 'textbook', name: nameStr, chars: text.length, chunks: chunks.length }); store.save(); toast(`Loaded ${chunks.length} chunks`, 'ok'); ctx.render(); };
  file.onchange = async () => { const f = file.files[0]; if (!f) return; try { status.textContent = 'Extracting text…'; const text = f.name.toLowerCase().endsWith('.pdf') ? await extractPdfText(f, n => { status.textContent = `Extracting page ${n}…`; }) : await f.text(); ingest(f.name, text); } catch (e) { toast(`Could not read the file: ${e.message}`, 'error'); status.textContent = ''; } };
  box.append(el('div', { class: 'form-grid' }, field('Upload PDF, TXT or Markdown', file), field('Paste text', paste)), el('div', { class: 'btn-row' }, button({ label: 'Use pasted text', size: 'sm', onClick: () => { if (paste.value.trim().length < 50) return toast('Paste at least a paragraph', 'error'); ingest('pasted text', paste.value); } }), status));
  return section('Grounding materials', 'Textbook or notes the agents should stay close to.', box);
}

function overridesSection(ctx) {
  const { store } = ctx; const o = store.project.overrides || (store.project.overrides = {});
  const model = input({ value: o.model || '', placeholder: `default: ${account.settings.model}` });
  const delib = select([['', `default: ${account.settings.deliberation === 'full' ? 'full deliberation' : 'quick'}`], ['full', 'Full deliberation (3 calls per stage)'], ['quick', 'Quick (1 call per stage)']], o.deliberation || '');
  const per = input({ type: 'number', min: 4, max: 30, value: o.slidesPerChapter || '', placeholder: `default: ${account.settings.slidesPerChapter}` });
  const fmt = select([['', `default: ${account.settings.slideFormat || 'pptx'}`], ['html', 'HTML deck → PDF'], ['latex', 'LaTeX Beamer → PDF'], ['pptx', 'PowerPoint']], o.slideFormat || '');
  const save = () => { const n = {}; if (model.value.trim()) n.model = model.value.trim(); if (delib.value) n.deliberation = delib.value; if (per.value) n.slidesPerChapter = Number(per.value); if (fmt.value) n.slideFormat = fmt.value; store.project.overrides = n; store.log({ type: 'settings', overrides: n }); store.save(); toast('Overrides saved', 'ok'); ctx.render(); };
  return section('Generation overrides for this project', 'Leave empty to use your account defaults.', el('div', {}, el('div', { class: 'form-grid' }, field('Text model', model), field('Deliberation mode', delib), field('Slides per chapter', per), field('Deck format', fmt)), el('div', { class: 'btn-row', style: 'margin-top:14px' }, button({ label: 'Save overrides', size: 'sm', onClick: save }))));
}

let pdfReady;
async function extractPdfText(file, onPage) {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', () => !!window.pdfjsLib);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = []; const max = Math.min(pdf.numPages, 600);
  for (let i = 1; i <= max; i++) { onPage?.(i); const page = await pdf.getPage(i); const content = await page.getTextContent(); pages.push(content.items.map(it => it.str).join(' ')); }
  return pages.join('\f');
}

const section = (title, desc, content) => el('section', { class: 'section' }, el('h2', {}, title), desc ? el('p', { class: 'section-desc' }, desc) : null, content);
