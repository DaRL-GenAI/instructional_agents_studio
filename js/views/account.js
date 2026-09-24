// views/account.js — personal center: settings, API key & privacy, projects, data & storage, about.
import { el, button, field, input, select, textarea, toggle, notice, icon, fmtBytes, fmtRel, toast, confirmDialog, empty } from '../ui.js';
import { account, saveAccount, setApiKey, DEFAULT_SETTINGS, deleteProject, duplicateProject, moduleProgress } from '../state.js';
import { LLMClient } from '../llm.js';
import { db } from '../db.js';
import { href, go } from '../router.js';
import { download, textBlob, slug } from '../export.js';
import { importButton } from './home.js';

const TABS = [['settings', 'Generation defaults', 'sliders'], ['privacy', 'API key & privacy', 'key'], ['projects', 'Projects', 'folder'], ['storage', 'Data & storage', 'database'], ['about', 'About', 'info']];

export function render(ctx) {
  const tab = ctx.route.tab || 'settings';
  const page = el('div', { class: 'page' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Account'), el('p', {}, 'Your defaults, your key, your projects. Nothing here leaves this browser except requests to the API endpoint you configure.'))));
  const nav = el('nav', { class: 'account-nav', 'aria-label': 'Account sections' }, ...TABS.map(([k, l, ic]) => el('a', { class: 'nav-item', href: href('account', k), 'aria-current': k === tab ? 'page' : null }, icon(ic), l)));
  const body = el('div', {});
  ({ settings: settingsTab, privacy: privacyTab, projects: projectsTab, storage: storageTab, about: aboutTab }[tab] || settingsTab)(ctx, body);
  page.append(el('div', { class: 'account-grid' }, nav, body));
  return page;
}

function settingsTab(ctx, body) {
  const s = account.settings;
  const model = input({ value: s.model, list: 'model-list' });
  const baseUrl = input({ value: s.baseUrl, placeholder: DEFAULT_SETTINGS.baseUrl });
  const delib = select([['full', 'Full deliberation: faculty → reviewer → summarizer (3 calls per stage, as in the paper)'], ['quick', 'Quick: one call per stage']], s.deliberation);
  const per = input({ type: 'number', min: 4, max: 30, value: s.slidesPerChapter });
  const quizN = input({ type: 'number', min: 3, max: 25, value: s.quizQuestions });
  const slideFmt = select([['html', 'HTML deck (print to PDF in the browser)'], ['latex', 'LaTeX Beamer (.tex, compile to PDF yourself)'], ['pptx', 'PowerPoint (.pptx)']], s.slideFormat || 'pptx');
  const temp = input({ type: 'number', step: '0.1', min: 0, max: 2, value: s.temperature, placeholder: 'model default' });
  const seed = input({ type: 'number', value: s.seed, placeholder: 'none' });
  const tts = select(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], s.ttsModel);
  const voice = select(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'], s.voice);
  const theme = select([['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']], s.theme);
  const save = async () => { Object.assign(s, { model: model.value.trim() || DEFAULT_SETTINGS.model, baseUrl: baseUrl.value.trim() || DEFAULT_SETTINGS.baseUrl, deliberation: delib.value, slidesPerChapter: Number(per.value) || 10, quizQuestions: Number(quizN.value) || 8, slideFormat: slideFmt.value, temperature: temp.value, seed: seed.value, ttsModel: tts.value, voice: voice.value, theme: theme.value }); await saveAccount(); toast('Defaults saved', 'ok'); ctx.render(); };
  body.append(section('Model', 'Used by every project unless a project overrides it under Course basics.', el('div', { class: 'form-grid' }, field('Text model', model, { hint: 'Any chat model your endpoint serves.' }), field('API base URL', baseUrl, { hint: 'OpenAI, Azure, OpenRouter, vLLM or Ollama-compatible.' }), field('Temperature', temp, { hint: 'Empty = model default.' }), field('Seed', seed, { hint: 'For reproducible runs when supported.' }))),
    section('Generation', 'How much the agents deliberate and how large each deliverable is.', el('div', { class: 'form-grid' }, el('div', { class: 'span-2' }, field('Deliberation mode', delib)), field('Slides per chapter', per), field('Quiz questions per chapter', quizN), el('div', { class: 'span-2' }, field('Default deck format', slideFmt, { hint: 'Each project can override this on its Slides page.' })))),
    section('Narration', 'Text-to-speech for lecture videos.', el('div', { class: 'form-grid' }, field('TTS model', tts), field('Voice', voice))),
    section('Appearance', null, el('div', { class: 'form-grid' }, field('Theme', theme))),
    el('div', { class: 'btn-row', style: 'margin-top:24px' }, button({ label: 'Save defaults', variant: 'primary', onClick: save }), button({ label: 'Reset to factory defaults', variant: 'ghost', onClick: async () => { if (await confirmDialog({ title: 'Reset all defaults?', body: 'Your API key and projects are not affected.', confirmLabel: 'Reset' })) { Object.assign(account.settings, DEFAULT_SETTINGS, { rememberKey: account.settings.rememberKey }); await saveAccount(); ctx.render(); } } })),
    el('datalist', { id: 'model-list' }, ...['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5-mini', 'gpt-5', 'o4-mini'].map(m => el('option', { value: m }))));
}

function privacyTab(ctx, body) {
  const key = input({ type: 'password', value: account.apiKey, placeholder: 'sk-…', autocomplete: 'new-password', spellcheck: 'false' });
  const remember = toggle(account.settings.rememberKey, () => {}, 'Remember key on this device');
  const status = el('span', { class: 'meta' });
  const save = async () => { setApiKey(key.value.trim(), remember.getAttribute('aria-checked') === 'true'); await saveAccount(); toast(account.apiKey ? 'Key saved' : 'Key removed', 'ok'); ctx.render(); };
  const test = async () => { status.textContent = 'Connecting…'; try { const c = new LLMClient({ apiKey: key.value.trim(), baseUrl: account.settings.baseUrl }); const models = await c.listModels(); status.textContent = `Connected: ${models.length} models${models.includes(account.settings.model) ? '' : ` (default model “${account.settings.model}” not listed)`}.`; } catch (e) { status.textContent = `Failed: ${e.message}`; } };
  body.append(section('API key', 'Sent only to the API base URL configured in Generation defaults, as a Bearer token, from your browser.', el('div', { style: 'display:flex;flex-direction:column;gap:14px;max-width:560px' }, field('OpenAI-compatible API key', key), el('div', { class: 'field inline' }, remember, el('span', { class: 'label' }, 'Remember on this device'), el('span', { class: 'hint' }, 'On: stored in localStorage. Off: kept only until this tab closes.')), el('div', { class: 'btn-row' }, button({ label: 'Save key', variant: 'primary', onClick: save }), button({ label: 'Test connection', onClick: test }), account.apiKey ? button({ label: 'Forget key', variant: 'danger', onClick: async () => { key.value = ''; await save(); } }) : null), status)),
    section('What leaves your browser', null, el('ul', { style: 'margin:0;padding-left:18px;color:var(--text-2);font-size:var(--fs-2);line-height:1.7;max-width:68ch' },
      el('li', {}, 'Prompts (course basics, prior deliverables, retrieved textbook excerpts) and narration text go to your API endpoint.'),
      el('li', {}, 'Nothing is sent to the host of this page. There is no analytics or telemetry.'),
      el('li', {}, 'Third-party libraries load on demand from public CDNs: JSZip, pdf.js and marked from cdnjs.cloudflare.com, PptxGenJS from cdn.jsdelivr.net (fallback unpkg.com).'),
      el('li', {}, 'Projects, media and the audit trail live in this browser’s IndexedDB; use Export to move them.'))));
}

function projectsTab(ctx, body) {
  const projects = ctx.projects || [];
  const panel = el('div', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, 'Projects'), el('div', { class: 'btn-row' }, importButton(ctx), button({ label: 'New course', icon: 'plus', variant: 'primary', size: 'sm', onClick: () => go('projects') }))));
  if (!projects.length) panel.append(el('div', { style: 'padding:8px' }, empty({ icon: 'folder', title: 'No projects', body: 'Create one from the Projects page.' })));
  for (const p of projects) {
    const prog = moduleProgress(p); const pct = Object.values(prog).reduce((a, x) => a + x.done, 0) / Math.max(1, Object.values(prog).reduce((a, x) => a + x.total, 0));
    panel.append(el('div', { class: 'list-row' }, el('div', {}, el('a', { class: 'title', href: href('p', p.id, 'overview'), style: 'text-decoration:none' }, p.name), el('div', { class: 'sub' }, `${p.chapters.length} chapters · ${Math.round(pct * 100)}% complete · ${(p.audit || []).length} audit events · updated ${fmtRel(p.updatedAt)}`)),
      el('div', { class: 'aside' }, button({ label: 'Rename', size: 'sm', variant: 'ghost', onClick: async () => { const n = await confirmDialog({ title: 'Rename project', confirmLabel: 'Rename', input: { label: 'Name', value: p.name } }); if (n && n.trim()) { p.name = n.trim(); p.course.name = n.trim(); await db.put('projects', p.id, p); await ctx.reloadProjects(); ctx.render(); } } }),
        button({ label: 'Duplicate', size: 'sm', variant: 'ghost', onClick: async () => { await duplicateProject(p.id); await ctx.reloadProjects(); ctx.render(); } }),
        button({ label: 'Export', size: 'sm', variant: 'ghost', onClick: () => download(textBlob(JSON.stringify(p, null, 2), 'application/json'), `${slug(p.name)}_project.json`) }),
        button({ label: 'Delete', size: 'sm', variant: 'danger', onClick: async () => { if (await confirmDialog({ title: `Delete “${p.name}”?`, body: 'Removes the project, its media and audit trail from this browser.', confirmLabel: 'Delete', danger: true })) { await deleteProject(p.id); await ctx.reloadProjects(); ctx.render(); } } }))));
  }
  body.append(panel);
}

function storageTab(ctx, body) {
  const info = el('dl', { class: 'kv' }, el('dt', {}, 'Engine'), el('dd', {}, db.usingMemory ? 'In-memory fallback (IndexedDB unavailable: data is lost when the tab closes)' : 'IndexedDB'), el('dt', {}, 'Used'), el('dd', { id: 'st-used' }, '…'), el('dt', {}, 'Quota'), el('dd', { id: 'st-quota' }, '…'), el('dt', {}, 'Persistent storage'), el('dd', { id: 'st-persist' }, '…'));
  const persistBtn = button({ label: 'Request persistent storage', onClick: async () => { const ok = await db.persist(); toast(ok ? 'Persistent storage granted' : 'The browser declined; data is still saved but may be evicted under storage pressure', ok ? 'ok' : ''); ctx.render(); } });
  body.append(section('Storage', 'Projects, narration audio and recorded videos are saved in this browser. Persistent storage asks the browser not to evict them automatically.', el('div', { style: 'display:flex;flex-direction:column;gap:16px' }, info, el('div', { class: 'btn-row' }, persistBtn))),
    section('Danger zone', null, el('div', { class: 'btn-row' }, button({ label: 'Delete all Studio data', variant: 'danger', onClick: async () => { if (await confirmDialog({ title: 'Delete everything?', body: 'All projects, media, settings and the API key are removed from this browser. This cannot be undone.', confirmLabel: 'Delete all', danger: true })) { for (const p of ctx.projects || []) await deleteProject(p.id); await db.del('settings', 'account'); setApiKey('', false); localStorage.clear(); location.hash = '#/projects'; location.reload(); } } }))));
  (async () => { const e = await db.estimate(); const persisted = await db.persisted(); const set = (id, v) => { const n = body.querySelector('#' + id); if (n) n.textContent = v; }; set('st-used', e ? fmtBytes(e.usage) : 'unknown'); set('st-quota', e ? fmtBytes(e.quota) : 'unknown'); set('st-persist', persisted === null ? 'not supported' : persisted ? 'granted' : 'not granted'); if (persisted) persistBtn.disabled = true; })();
}

function aboutTab(ctx, body) {
  body.append(section('Instructional Agents Studio', null, el('div', { style: 'max-width:68ch;color:var(--text-2);font-size:var(--fs-2);line-height:1.7;display:flex;flex-direction:column;gap:10px' },
    el('p', {}, 'A browser-only edition of ', el('a', { href: 'https://github.com/DaRL-GenAI/instructional_agents' }, 'Instructional Agents'), ' (EACL 2026). It runs the same ADDIE deliberations with your own API key and keeps every prompt, response and edit auditable.'),
    el('p', {}, 'Source: ', el('a', { href: 'https://github.com/DaRL-GenAI/instructional_agents_studio' }, 'github.com/DaRL-GenAI/instructional_agents_studio'), ' · Paper homepage: ', el('a', { href: 'https://darl-genai.github.io/instructional_agents_homepage/' }, 'instructional_agents_homepage'), ' · Related: ', el('a', { href: 'https://darl-genai.github.io/EduCAST/' }, 'EduCast')),
    el('pre', {}, `@misc{yao2025instructionalagentsllmagents,\n  title={Instructional Agents: Reducing Teaching Faculty Workload through Multi-Agent Instructional Design},\n  author={Yao, Huaiyuan and Xu, Wanpeng and Turnau, Justin and Kellam, Nadia and Wei, Hua},\n  year={2025}, eprint={2508.19611}, archivePrefix={arXiv}, primaryClass={cs.AI}\n}`))));
}

function section(title, desc, content) { return el('section', { class: 'section', style: 'margin-top:0;margin-bottom:32px' }, el('h2', {}, title), desc ? el('p', { class: 'section-desc' }, desc) : null, content); }
