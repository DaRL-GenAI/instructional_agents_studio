// app.js — app shell, routing and the shared view context.
import { el, icon, button, toast, badge, dot, fmtInt, $ } from './ui.js';
import { parse, href, go, onRoute } from './router.js';
import { account, loadAccount, listProjects, getProject, ProjectStore, MODULES, moduleProgress, projectTotals } from './state.js';
import { Pipeline } from './pipeline.js';
import { buildZip, download } from './export.js';
import { slug } from './export.js';
import * as home from './views/home.js';
import * as accountView from './views/account.js';
import * as overview from './views/overview.js';
import * as basics from './views/basics.js';
import * as design from './views/design.js';
import * as slides from './views/slides.js';
import * as assessments from './views/assessments.js';
import * as videos from './views/videos.js';
import * as audit from './views/audit.js';

const VIEWS = { overview, basics, design, slides, assessments, videos, audit };

const ctx = {
  route: parse(), store: null, pipe: null, projects: [], ui: {}, media: {}, busy: null,
  render, go,
  async reloadProjects() { ctx.projects = await listProjects(); },
  requireKey() {
    if (!account.apiKey) { toast('Add your API key under Account → API key & privacy first.', 'error'); go('account', 'privacy'); return false; }
    return true;
  },
  async guarded(label, fn) {
    if (ctx.busy) { toast(`Already running: ${ctx.busy}`, 'error'); return; }
    ctx.busy = label; render();
    try { await fn(); } catch (e) { console.error(e); toast(e.message || String(e), 'error'); }
    finally { ctx.busy = null; render(); }
  },
  async exportAll() {
    if (!ctx.store) return;
    await ctx.guarded('Building ZIP', async () => {
      const media = {};
      for (const ch of ctx.store.project.chapters) {
        const [audios, video, scene_audios, anim_video, images, lesson] = await Promise.all(['audios', 'video', 'scene_audios', 'anim_video', 'images', 'lesson_bundle'].map(k => ctx.store.getMedia(ch.id, k)));
        if (audios || video || scene_audios || anim_video || images || lesson) media[ch.id] = { audios, video, scene_audios, anim_video, images, lesson };
      }
      media.template = await ctx.store.getMedia('project', 'template');
      const blob = await buildZip(ctx.store.project, media);
      download(blob, `${slug(ctx.store.project.name)}_instructional_agents.zip`);
      ctx.store.log({ type: 'export', file: 'zip', bytes: blob.size }); ctx.store.save(); toast('ZIP ready', 'ok');
    });
  },
};

async function openProject(id) {
  const p = await getProject(id);
  if (!p) return false;
  if (ctx.store?.id === id) {
    // Same project: adopt a newer copy from the database (another tab, an import) unless we hold unsaved edits.
    if (!ctx.store.dirty && (p.updatedAt || '') > (ctx.store.project.updatedAt || '')) { ctx.store.project = p; ctx.pipe.store = ctx.store; }
    return true;
  }
  if (ctx.store) await ctx.store.flush();
  ctx.store = new ProjectStore(p); ctx.pipe = new Pipeline(ctx.store); ctx.ui = {}; ctx.media = {};
  ctx.pipe.onLive = renderLive;
  return true;
}

// ------------------------------------------------------------------ render
let rendering = false;
function render() {
  if (rendering) return; rendering = true;
  try {
    const r = ctx.route;
    renderNav(); renderTopbar();
    const panel = $('#main'); panel.innerHTML = '';
    try {
      if (r.name === 'projects') panel.append(home.render(ctx));
      else if (r.name === 'account') panel.append(accountView.render(ctx));
      else if (r.name === 'project' && ctx.store) panel.append((VIEWS[r.module] || overview).render(ctx));
      else panel.append(home.render(ctx));
    } catch (e) {
      console.error('render failed', e);
      panel.append(errorPanel(e));
    }
    renderLive();
    document.title = ctx.store && r.name === 'project' ? `${ctx.store.project.name} · ${MODULES.find(m => m.id === r.module)?.name || 'Overview'} · Studio` : r.name === 'account' ? 'Account · Studio' : 'Instructional Agents Studio';
  } finally { rendering = false; }
}

function renderNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  const r = ctx.route; const p = ctx.store?.project;
  nav.append(el('a', { class: 'brand', href: href('projects') }, el('img', { src: 'assets/favicon.svg', alt: '' }), el('span', {}, el('b', {}, 'Instructional Agents'), el('small', {}, 'Studio'))));
  nav.append(el('a', { class: 'project-switch', href: href('projects'), title: 'All projects' }, icon('folder', 'sm'), el('b', {}, p && r.name === 'project' ? p.name : 'Projects'), icon('chevron-down', 'sm')));
  if (p && r.name === 'project') {
    const prog = moduleProgress(p);
    nav.append(el('div', { class: 'nav-group' }, 'Course'));
    for (const m of MODULES) {
      const pr = prog[m.id];
      nav.append(el('a', { class: 'nav-item', href: href('p', p.id, m.id), 'aria-current': r.module === m.id ? 'page' : null }, icon(m.icon), m.name,
        pr && pr.total ? el('span', { class: 'prog', title: `${pr.done} of ${pr.total}` }, el('i', { style: `width:${Math.round(100 * pr.done / pr.total)}%` })) : m.id === 'audit' ? el('span', { class: 'count' }, fmtInt(p.audit.length)) : null));
    }
  }
  nav.append(el('div', { class: 'nav-group' }, 'You'));
  nav.append(el('a', { class: 'nav-item', href: href('account', 'settings'), 'aria-current': r.name === 'account' ? 'page' : null }, icon('user'), 'Account', !account.apiKey ? el('span', { class: 'count', title: 'No API key' }, dot('stale')) : null));
  nav.append(el('div', { class: 'nav-foot' }, 'Browser edition of ', el('a', { href: 'https://github.com/DaRL-GenAI/instructional_agents' }, 'instructional_agents'), '. Data stays in this browser.'));
}

function renderTopbar() {
  const bar = $('#topbar'); bar.innerHTML = '';
  const r = ctx.route; const crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
  crumbs.append(el('a', { href: href('projects') }, 'Projects'));
  if (r.name === 'project' && ctx.store) { crumbs.append(icon('chevron-right', 'sm'), el('a', { href: href('p', ctx.store.id, 'overview') }, ctx.store.project.name), icon('chevron-right', 'sm'), el('b', {}, MODULES.find(m => m.id === r.module)?.name || 'Overview')); }
  if (r.name === 'account') crumbs.append(icon('chevron-right', 'sm'), el('b', {}, 'Account'));
  bar.append(crumbs, el('span', { class: 'spacer' }));
  if (ctx.busy) bar.append(el('span', { class: 'status-pill busy' }, dot(), el('span', {}, ctx.busy), button({ label: 'Cancel', size: 'sm', variant: 'ghost', onClick: () => ctx.pipe?.cancel() })));
  else if (ctx.store && r.name === 'project') { const t = projectTotals(ctx.store.project); bar.append(el('span', { class: 'status-pill', title: 'Model calls and tokens in this project' }, dot(account.apiKey ? 'done' : 'stale'), el('span', { class: 'long' }, ctx.store.settings.model), el('span', {}, `${fmtInt(t.calls)} calls · ${fmtInt(t.tokens)} tok`))); }
  if (ctx.store && r.name === 'project') bar.append(button({ label: 'Export ZIP', icon: 'download', size: 'sm', onClick: () => ctx.exportAll() }));
}

function renderLive() {
  const live = $('#live'); const p = ctx.pipe;
  if (!p?.live) { live.hidden = true; return; }
  live.hidden = false; $('#live-agent').textContent = `${p.live.agent} is writing…`;
  const pre = $('#live-text'); pre.textContent = p.live.text; pre.scrollTop = pre.scrollHeight;
}

function errorPanel(e) {
  const r = ctx.route; const p = ctx.store?.project;
  const diag = { route: location.hash, error: String(e && e.stack || e), project: p ? { id: p.id, schema: p.schema, chapters: p.chapters?.length, updatedAt: p.updatedAt } : null, version: document.querySelector('script[src*="app.js"]')?.src.split('?v=')[1], ua: navigator.userAgent };
  return el('div', { class: 'page' }, el('div', { class: 'notice error', style: 'flex-direction:column;align-items:flex-start;gap:12px' },
    el('div', {}, el('b', {}, 'This page could not be displayed.'), ' Your data is intact; the view hit an error while rendering: ', el('code', {}, String(e?.message || e))),
    el('div', { class: 'btn-row' },
      p ? button({ label: 'Back to overview', size: 'sm', variant: 'primary', onClick: () => go('p', p.id, 'overview') }) : button({ label: 'Back to projects', size: 'sm', variant: 'primary', onClick: () => go('projects') }),
      button({ label: 'Copy diagnostics', size: 'sm', onClick: () => navigator.clipboard.writeText(JSON.stringify(diag, null, 2)).then(() => toast('Diagnostics copied; please paste them in an issue')) }),
      button({ label: 'Retry', size: 'sm', variant: 'ghost', onClick: () => render() }))));
}

// ------------------------------------------------------------------ routing
async function route() {
  ctx.route = parse();
  try {
    if (ctx.route.name === 'project') {
      const ok = await openProject(ctx.route.id);
      if (!ok) { toast('Project not found', 'error'); go('projects'); return; }
      if (!VIEWS[ctx.route.module]) { go('p', ctx.route.id, 'overview'); return; }
    }
    if (ctx.route.name === 'projects' || ctx.route.name === 'account') await ctx.reloadProjects();
  } catch (e) {
    console.error('route failed', e);
    const panel = $('#main'); panel.innerHTML = ''; panel.append(errorPanel(e)); return;
  }
  render();
  $('#main').focus({ preventScroll: true });
}

async function boot() {
  await loadAccount();
  await ctx.reloadProjects();
  $('#live-close').onclick = () => { $('#live').hidden = true; };
  setupLivePanel();
  onRoute(route);
  window.addEventListener('beforeunload', e => { if (ctx.busy) { e.preventDefault(); e.returnValue = ''; } ctx.store?.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) ctx.store?.flush(); });
  if (!location.hash) location.hash = ctx.projects.length ? href('p', ctx.projects[0].id, 'overview') : href('projects');
  await route();
}
boot();


// ------------------------------------------------------------------ live panel: draggable + minimizable
function setupLivePanel() {
  const live = $('#live'), head = $('#live-head'), min = $('#live-min');
  if (!live || !head) return;
  const LS_POS = 'studio.livePos', LS_MIN = 'studio.liveMin';
  const applyMin = (on) => { live.classList.toggle('min', on); min.setAttribute('aria-pressed', String(on)); min.querySelector('use')?.setAttribute('href', on ? '#i-chevron-right' : '#i-chevron-down'); try { localStorage.setItem(LS_MIN, on ? '1' : '0'); } catch { /* ignore */ } };
  try { if (localStorage.getItem(LS_MIN) === '1') applyMin(true); } catch { /* ignore */ }
  try { const pos = JSON.parse(localStorage.getItem(LS_POS) || 'null'); if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) place(pos.x, pos.y); } catch { /* ignore */ }
  function place(x, y) {
    const w = live.offsetWidth || 440, h = live.offsetHeight || 200;
    x = Math.max(4, Math.min(window.innerWidth - Math.min(w, 120), x)); y = Math.max(4, Math.min(window.innerHeight - 40, y));
    Object.assign(live.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
  }
  min.onclick = (e) => { e.stopPropagation(); applyMin(!live.classList.contains('min')); };
  head.ondblclick = (e) => { if (e.target.closest('button')) return; applyMin(!live.classList.contains('min')); };
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.button !== 0) return;
    const r = live.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    head.setPointerCapture(e.pointerId); live.classList.add('dragging');
  });
  head.addEventListener('pointermove', (e) => { if (!drag) return; drag.moved = true; place(e.clientX - drag.dx, e.clientY - drag.dy); });
  const end = (e) => { if (!drag) return; live.classList.remove('dragging'); if (drag.moved) { const r = live.getBoundingClientRect(); try { localStorage.setItem(LS_POS, JSON.stringify({ x: r.left, y: r.top })); } catch { /* ignore */ } } drag = null; try { head.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
  head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => { const r = live.getBoundingClientRect(); if (live.style.left) place(r.left, r.top); });
}
