// views/workspace.js — the project as files, VS Code style: activity bar (Files / Search / History / Settings), a
// resizable file tree, tabbed editors (ONLYOFFICE for .pptx/.docx, CodeMirror for text, PDF.js, native media), a
// side panel slot (the agent, next milestone) and a status bar.
//
// The Workspace lives in its own host element next to #main and is built once per project: app re-renders only
// call update(), so editors (and the ONLYOFFICE iframes, which reload when moved in the DOM) survive navigation.
// A file that backs a stage is saved through the store (userEdit / commitDeck / commitDoc), so the stage's version,
// history and audit trail stay right; any other file is written as is (local app only).
import { el, append, button, icon, toast, confirmDialog, notice, empty, renderMarkdown, loadScript, fmtRel, fmtBytes } from '../ui.js';
import { wsHref, go, href } from '../router.js';
import { LOCAL, onServerEvent } from '../fs/api.js';
import { makeSource, shaHex, typeOf } from '../ws/source.js';
import { layout, stageInfo } from '../ws/stages.js';
import { stageStatus } from './stage.js';
import { createCodeEditor, TEXT_EXT } from './codeeditor.js';
import { OfficeFrame, officeFormat, downloadFile } from './officeeditor.js';
import { commitDeck, deckManifest } from '../pptxdeck.js';
import { commitDoc, docManifest, convertToWord, convertToMarkdown, CONVERTIBLE } from '../docstage.js';
import { download } from '../export.js';
import { AgentPanel } from '../agent/panel.js';

let ws = null; // the Workspace of the open project

const LS = 'ia-ws.';
const pref = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const extOf = p => (p.match(/\.([^./]+)$/)?.[1] || (p.split('/').pop().startsWith('.') ? p.split('/').pop().slice(1) : '')).toLowerCase();
const baseName = p => p.split('/').pop();
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const join = (d, n) => d ? `${d}/${n}` : n;
const MEDIA = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', mp4: 'video', webm: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio' };
const isInternal = p => p === '.studio' || p.startsWith('.studio/') || p === '.git' || p.startsWith('.git/');
const ICON = { pptx: 'presentation', docx: 'file-text', md: 'file-text', pdf: 'book', image: 'image', video: 'video', audio: 'mic' };
const fileIcon = p => { const e = extOf(p); return ICON[e] || ICON[MEDIA[e]] || 'file'; };
const BADGE = { generated: ['G', 'Generated'], edited: ['E', 'Edited'], imported: ['I', 'Imported'], stale: ['!', 'Inputs changed: re-run or keep'], running: ['…', 'Running'], error: ['×', 'Last run failed'] };

/** The Workspace element for the open project (built on first use). */
export function mount(ctx, host) {
  if (ws && ws.id !== ctx.store.id) { ws.destroy(); ws = null; }
  if (!ws) { ws = new Workspace(ctx); host.replaceChildren(ws.root); }
  else if (ws.root.parentNode !== host) host.replaceChildren(ws.root);
  ws.ctx = ctx; ws.update();
  return ws;
}
export const dirtyCount = () => ws ? [...ws.tabs.values()].filter(t => t.dirty).length : 0;
/** Before switching to another project: ask when files are unsaved, then drop the Workspace. */
export async function release(nextId) {
  if (!ws || ws.id === nextId) return true;
  const n = dirtyCount();
  if (n && !(await confirmDialog({ title: `Discard unsaved changes in ${n} file${n > 1 ? 's' : ''}?`, body: 'They are lost when you open another project.', confirmLabel: 'Discard changes', danger: true }))) return false;
  ws.destroy(); ws = null; return true;
}

class Workspace {
  constructor(ctx) {
    this.ctx = ctx; this.id = ctx.store.id; this.src = makeSource(ctx.store);
    this.tabs = new Map(); this.active = null; this.entries = []; this.managed = new Set();
    this.expanded = new Set(pref(`open.${this.id}`, null) || []); this.firstList = !pref(`open.${this.id}`, null);
    this.view = pref('view', 'files'); this.panelOpen = pref('panel', false); this.vcs = null; this.saving = 0;
    this.offs = [];
    this.build();
    this.refresh();
    if (this.panelOpen) this.togglePanel(true);
    if (LOCAL) this.offs.push(onServerEvent(ev => this.onServerEvent(ev)));
    this.offs.push(ctx.store.on(() => this.onProjectChange()));
    this._key = e => this.onKey(e); addEventListener('keydown', this._key);
  }

  // ---------------------------------------------------------------- layout
  build() {
    const act = (id, label, ic) => el('button', { class: 'ws-act', type: 'button', 'aria-label': label, title: label, 'aria-pressed': String(this.view === id), dataset: { view: id }, onClick: () => this.setView(id) }, icon(ic));
    this.activity = el('nav', { class: 'ws-activity', 'aria-label': 'Workspace views' },
      act('files', 'Files', 'folder'), act('search', 'Search', 'search'), act('history', 'History', 'history'), act('settings', 'Settings', 'settings'),
      el('span', { class: 'spacer' }),
      this.panelBtn = el('button', { class: 'ws-act', type: 'button', 'aria-label': 'Agent panel', title: 'Agent panel', 'aria-pressed': String(this.panelOpen), onClick: () => this.togglePanel() }, icon('message')));
    this.sideHead = el('div', { class: 'ws-side-head' });
    this.sideBody = el('div', { class: 'ws-side-body' });
    this.side = el('aside', { class: 'ws-side', 'aria-label': 'Explorer' }, this.sideHead, this.sideBody);
    this.tabStrip = el('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': 'Open files' });
    this.panels = el('div', { class: 'ws-panels' });
    this.editor = el('section', { class: 'ws-editor', 'aria-label': 'Editor' }, this.tabStrip, this.panels);
    this.dock = pref('dock', 'right');
    this.agentBody = el('div', { class: 'ws-agent-body' });
    this.dockBtn = button({ icon: 'sliders', size: 'sm', variant: 'ghost', title: 'Move panel', onClick: () => this.setDock(this.dock === 'right' ? 'bottom' : 'right') });
    this.agent = el('aside', { class: 'ws-agent', 'aria-label': 'Agent', hidden: !this.panelOpen },
      el('div', { class: 'ws-side-head' }, el('b', {}, 'Agent'), el('span', { class: 'spacer' }), this.dockBtn, button({ icon: 'x', size: 'sm', variant: 'ghost', title: 'Close panel', onClick: () => this.togglePanel(false) })),
      this.agentBody);
    this.status = el('footer', { class: 'ws-status', role: 'status', 'aria-live': 'polite' });
    const splitL = this.splitter('side', 260, 160, 520, this.side, 1);
    this.splitR = this.splitter('agent', 340, 240, 640, this.agent, -1);
    this.splitB = this.splitter('agentH', 260, 140, 640, this.agent, -1, true);
    this.body = el('div', { class: 'ws-body' }, this.activity, this.side, splitL, this.editor, this.splitR, this.agent);
    this.root = el('div', { class: 'ws' }, this.body, this.status);
    this.setDock(this.dock, true);
    this.root.style.setProperty('--ws-font', `${pref('font', 13)}px`);
    this.renderSide(); this.renderTabs(); this.renderStatus();
    // drag files from the computer into the tree (local app)
    this.side.addEventListener('dragover', e => { if (!this.src.writable || !e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); this.side.classList.add('drop'); });
    this.side.addEventListener('dragleave', e => { if (!this.side.contains(e.relatedTarget)) this.side.classList.remove('drop'); });
    this.side.addEventListener('drop', e => { this.side.classList.remove('drop'); if (!this.src.writable || !e.dataTransfer?.files?.length) return; e.preventDefault(); const row = e.target.closest?.('[data-path]'); const p = row?.dataset.path || ''; this.upload([...e.dataTransfer.files], row?.dataset.dir === '1' ? p : dirOf(p)); });
  }
  splitter(name, def, min, max, target, dir, horizontal = false) {
    const dim = horizontal ? 'height' : 'width'; const w = pref(`w.${name}`, def);
    const s = el('div', { class: `ws-split${horizontal ? ' h' : ''}`, role: 'separator', 'aria-orientation': horizontal ? 'horizontal' : 'vertical', 'aria-label': `Resize ${name === 'side' ? 'explorer' : 'agent panel'}`, tabindex: '0', 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': w });
    const set = v => { v = Math.max(min, Math.min(max, Math.round(v))); target.style[dim] = `${v}px`; s.setAttribute('aria-valuenow', v); setPref(`w.${name}`, v); };
    s.apply = () => { target.style.width = target.style.height = ''; target.style[dim] = `${pref(`w.${name}`, def)}px`; };
    if (!horizontal) target.style.width = `${w}px`;
    s.addEventListener('pointerdown', e => {
      e.preventDefault(); s.setPointerCapture(e.pointerId); const x0 = horizontal ? e.clientY : e.clientX, w0 = target.getBoundingClientRect()[dim]; this.root.classList.add('resizing');
      const move = ev => set(w0 + dir * ((horizontal ? ev.clientY : ev.clientX) - x0));
      const up = () => { s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); this.root.classList.remove('resizing'); };
      s.addEventListener('pointermove', move); s.addEventListener('pointerup', up);
    });
    s.addEventListener('keydown', e => { const k = horizontal ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']; if (k.includes(e.key)) { e.preventDefault(); set(target.getBoundingClientRect()[dim] + (e.key === k[1] ? 16 : -16) * dir); } });
    return s;
  }
  setView(v) {
    if (this.view === v && !this.side.hidden) { this.side.hidden = true; this.side.nextSibling.hidden = true; }
    else { this.view = v; this.side.hidden = false; this.side.nextSibling.hidden = false; setPref('view', v); }
    for (const b of this.activity.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(!this.side.hidden && b.dataset.view === this.view));
    this.renderSide();
  }
  togglePanel(on = !this.panelOpen) {
    this.panelOpen = on; setPref('panel', on); this.agent.hidden = !on; this.splitR.hidden = this.splitB.hidden = !on; this.panelBtn.setAttribute('aria-pressed', String(on));
    if (on && !this.agentPanel) { this.agentPanel = new AgentPanel(this); this.agentBody.replaceChildren(this.agentPanel.el); }
    if (on) this.agentPanel.refreshContext();
  }
  /** The agent panel at the right of the editor, or below it. */
  setDock(d, first = false) {
    this.dock = d; if (!first) setPref('dock', d);
    const split = d === 'bottom' ? this.splitB : this.splitR; const other = d === 'bottom' ? this.splitR : this.splitB;
    other.remove(); split.apply();
    if (d === 'bottom') this.editor.append(split, this.agent); else this.body.append(split, this.agent);
    this.agent.classList.toggle('bottom', d === 'bottom'); split.hidden = !this.panelOpen;
    const t = d === 'bottom' ? 'Move panel to the right' : 'Move panel to the bottom'; this.dockBtn.title = t; this.dockBtn.setAttribute('aria-label', t);
  }

  /** Called on every app render (stage status may have changed). */
  update() {
    const want = this.ctx.route.path;
    if (want && this.active !== want) this.open(want);
    if (this.view === 'files') this.renderTree();
    this.renderStatus();
  }
  destroy() { this.agentPanel?.destroy(); for (const t of this.tabs.values()) t.destroy(); this.tabs.clear(); for (const off of this.offs) off(); removeEventListener('keydown', this._key); this.root.remove(); }

  // ---------------------------------------------------------------- data
  async refresh() {
    try { const r = await this.src.list(); this.entries = r.entries; this.managed = r.managed; }
    catch (e) { this.entries = []; this.listError = e.message; }
    if (this.firstList && this.entries.length) { this.firstList = false; for (const e of this.entries) if (e.dir && !isInternal(e.path) && !/^build(\/|$)/.test(e.path) && e.path.split('/').length <= 2) this.expanded.add(e.path); }
    if (this.view === 'files') this.renderTree();
    if (this.src.kind === 'local') { this.vcs = await this.src.vcs(); this.renderStatus(); }
  }
  onServerEvent(ev) {
    if (ev.type !== 'changed' || ev.id !== this.id) return;
    clearTimeout(this._rt); this._rt = setTimeout(() => this.refresh(), 120);
    // let the app adopt the change into the project first, then compare open files with the disk
    setTimeout(() => { for (const t of this.tabs.values()) if (!ev.paths || ev.paths.includes(t.path)) t.check(); }, 300);
  }
  onProjectChange() {
    if (this.src.kind !== 'virtual') return;
    clearTimeout(this._pt); this._pt = setTimeout(() => { this.refresh(); for (const t of this.tabs.values()) t.check(); }, 200);
  }
  /** path → { key, info, status } for the files that back a stage. */
  owners() {
    const p = this.ctx.store.project; const { meta } = layout(p); const map = new Map();
    for (const [key, m] of Object.entries(meta.stages || {})) { const f = m.$file || m.$deck; if (f) map.set(f, key); }
    return map;
  }
  ownerInfo(path) { const key = this.owners().get(path); if (!key) return null; const info = stageInfo(this.ctx, key); return info && { key, ...info, kind: path.endsWith('.pptx') ? 'deck' : path.endsWith('.docx') ? 'doc' : 'text' }; }
  badgeOf(info) {
    const st = info.stage; const s = stageStatus(this.ctx.pipe, st, info.inputs);
    if (s === 'stale' || s === 'running' || s === 'error') return s;
    if (st.origin === 'import') return 'imported';
    if (st.edited) return 'edited';
    if (st.status === 'done') return 'generated';
    return null;
  }
  readOnly(path) { return isInternal(path) || path === 'course.json' || (this.managed.has(path) && !this.owners().has(path)) || (!this.src.writable && !this.owners().has(path)); }

  // ---------------------------------------------------------------- for the agent panel
  activeTab() { return this.tabs.get(this.active) || null; }
  reveal(path) { go(...wsParts(this.id, path)); }
  checkTabs(paths) { setTimeout(() => { for (const t of this.tabs.values()) if (!paths || paths.includes(t.path)) t.check(); }, 200); }
  /** Files in a running agent's scope are read-only in their tabs. */
  setLocks(paths) { this.locks = paths ? new Set(paths) : null; for (const t of this.tabs.values()) t.setLocked(!!this.locks?.has(t.path)); }
  /** Unsaved tabs: offer to save them (the agent reads the files on disk). false: the user cancelled or a save failed. */
  async saveAllFirst() {
    const dirty = [...this.tabs.values()].filter(t => t.dirty); if (!dirty.length) return true;
    if (!(await confirmDialog({ title: `Save ${dirty.length} file${dirty.length > 1 ? 's' : ''} first?`, body: `${dirty.map(t => baseName(t.path)).join(', ')} ${dirty.length > 1 ? 'have' : 'has'} unsaved changes; the agent works on the saved files.`, confirmLabel: 'Save and continue' }))) return false;
    for (const t of dirty) if (!(await t.save())) { toast(`${baseName(t.path)} was not saved`, 'error'); return false; }
    return true;
  }
  /** The open .pptx/.docx tab the built-in agent may run macros in: one in scope, else none. */
  officeFor(scope = []) {
    const t = [...this.tabs.values()].find(x => x.kind === 'office' && x.office?.state.opened && scope.includes(x.path)); if (!t) return null;
    let original = null;
    return {
      path: t.path, format: t.office.format,
      macro: async code => { original ||= (await this.src.read(t.path))?.blob; return t.office.macro(code, null, false); },
      save: () => t.office.save(),
      reopen: async () => { if (original) { await t.office.openBuffer(original); t.setDirty(false); } },
    };
  }
  /** Show an agent's version of a .pptx/.docx in its tab without saving it. */
  async preview(path, blob) {
    const had = this.tabs.get(path); if (had?.previewBlob) return;
    if (had) had.previewBlob = blob; // before the tab shows: no context reads while the preview opens
    this.reveal(path); await this.open(path);
    const t = this.tabs.get(path); if (t.kind !== 'office') throw new Error('No preview for this file');
    t.previewBlob = blob; await t.ready(); await t.showPreview(blob);
    this.agentPanel?.renderReview();
  }
  previewing(path) { return !!this.tabs.get(path)?.previewBlob; }
  async endPreview(path, { reload = true } = {}) { const t = this.tabs.get(path); if (!t?.previewBlob) return; t.previewBlob = null; t.renderTools(); t.banner.replaceChildren(); if (reload) await t.reloadFrom(); this.agentPanel?.renderReview(); }

  // ---------------------------------------------------------------- side bar
  renderSide() {
    const v = this.view; this.sideHead.replaceChildren(); this.sideBody.replaceChildren();
    const title = { files: 'Files', search: 'Search', history: 'History', settings: 'Settings' }[v];
    this.sideHead.append(el('b', {}, title), el('span', { class: 'spacer' }));
    if (v === 'files') {
      if (this.src.writable) this.sideHead.append(
        button({ icon: 'file', size: 'sm', variant: 'ghost', title: 'New file', onClick: () => this.newFile('') }),
        button({ icon: 'folder', size: 'sm', variant: 'ghost', title: 'New folder', onClick: () => this.newFolder('') }),
        button({ icon: 'upload', size: 'sm', variant: 'ghost', title: 'Upload files', onClick: () => this.pickUpload('') }));
      this.sideHead.append(button({ icon: 'refresh', size: 'sm', variant: 'ghost', title: 'Refresh', onClick: () => this.refresh() }));
      this.tree = el('div', { class: 'ws-tree', role: 'tree', 'aria-label': 'Project files' });
      this.tree.addEventListener('contextmenu', e => { const row = e.target.closest('[data-path]'); e.preventDefault(); this.menu(e, row ? row.dataset.path : '', row ? row.dataset.dir === '1' : true); });
      this.sideBody.append(this.tree); this.renderTree();
    }
    if (v === 'search') this.renderSearch();
    if (v === 'history') this.renderHistory();
    if (v === 'settings') this.renderSettings();
  }

  renderTree() {
    if (!this.tree || this.view !== 'files') return;
    if (!this.entries.length) { this.tree.replaceChildren(this.listError ? notice('error', this.listError) : el('p', { class: 'meta', style: 'padding:8px 12px' }, 'Loading…')); return; }
    const owners = this.owners(); const kids = new Map();
    for (const e of this.entries) { const d = dirOf(e.path); if (!kids.has(d)) kids.set(d, []); kids.get(d).push(e); }
    const order = (a, b) => (b.dir - a.dir) || (a.path.startsWith('.') - b.path.startsWith('.')) || a.path.localeCompare(b.path);
    const rows = [];
    const walk = (dir, depth) => {
      for (const e of (kids.get(dir) || []).sort(order)) {
        const open = e.dir && this.expanded.has(e.path) && !(isInternal(e.path) && !this.expanded.has(e.path));
        const key = owners.get(e.path); const info = key ? stageInfo(this.ctx, key) : null; const b = info ? this.badgeOf(info) : null;
        const dirty = this.tabs.get(e.path)?.dirty;
        rows.push(el('div', { class: `ws-row${this.active === e.path ? ' active' : ''}${isInternal(e.path) || e.path === 'build' ? ' dim' : ''}`, role: 'treeitem', tabindex: this.active === e.path ? '0' : '-1', 'aria-level': depth + 1, 'aria-expanded': e.dir ? String(open) : null, 'aria-selected': String(this.active === e.path), dataset: { path: e.path, dir: e.dir ? '1' : '0' }, style: `padding-left:${8 + depth * 14}px`, title: e.path,
          onClick: () => e.dir ? this.toggleDir(e.path) : go(...wsParts(this.id, e.path)),
          onKeydown: ev => this.treeKey(ev, e) },
        e.dir ? icon(open ? 'chevron-down' : 'chevron-right', 'sm chev') : el('span', { class: 'chev' }),
        icon(e.dir ? 'folder' : fileIcon(e.path), 'sm'), el('span', { class: 'name' }, baseName(e.path)),
        dirty ? el('i', { class: 'ws-dirty', title: 'Unsaved changes' }) : null,
        b ? el('span', { class: `ws-badge ${b}`, title: BADGE[b][1], 'aria-label': BADGE[b][1] }, BADGE[b][0]) : null));
        if (open) walk(e.path, depth + 1);
      }
    };
    walk('', 0);
    if (!this.tree.querySelector('[tabindex="0"]') && rows[0]) rows[0].tabIndex = 0;
    this.tree.replaceChildren(...rows);
  }
  toggleDir(p) { if (this.expanded.has(p)) this.expanded.delete(p); else this.expanded.add(p); setPref(`open.${this.id}`, [...this.expanded].filter(x => !isInternal(x))); this.renderTree(); this.tree.querySelector(`[data-path="${CSS.escape(p)}"]`)?.focus(); }
  treeKey(ev, e) {
    const rows = [...this.tree.querySelectorAll('[data-path]')]; const i = rows.indexOf(ev.currentTarget);
    const focus = r => { if (!r) return; rows.forEach(x => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
    if (ev.key === 'ArrowDown') { ev.preventDefault(); focus(rows[i + 1]); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); focus(rows[i - 1]); }
    else if (ev.key === 'ArrowRight' && e.dir && !this.expanded.has(e.path)) { ev.preventDefault(); this.toggleDir(e.path); }
    else if (ev.key === 'ArrowLeft' && e.dir && this.expanded.has(e.path)) { ev.preventDefault(); this.toggleDir(e.path); }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click(); }
    else if (ev.key === 'F2' && this.src.writable) { ev.preventDefault(); this.rename(e.path); }
    else if (ev.key === 'Delete' && this.src.writable) { ev.preventDefault(); this.remove(e.path, e.dir); }
  }

  menu(ev, path, isDir) {
    document.querySelector('.ws-menu')?.remove();
    const dir = isDir ? path : dirOf(path); const w = this.src.writable; const locked = this.managed.has(path) || isInternal(path) || [...this.managed].some(m => isDir && path && m.startsWith(`${path}/`));
    const item = (label, fn, extra = {}) => el('button', { type: 'button', role: 'menuitem', class: extra.danger ? 'danger' : '', onClick: () => { m.remove(); fn(); } }, label);
    const items = [
      w && !isInternal(dir) ? item('New file…', () => this.newFile(dir)) : null,
      w && !isInternal(dir) ? item('New folder…', () => this.newFolder(dir)) : null,
      w && !isInternal(dir) ? item('Upload files…', () => this.pickUpload(dir)) : null,
      path && !isDir ? item('Download', () => this.download(path)) : null,
      w && path && !locked ? item('Rename…', () => this.rename(path)) : null,
      w && path && !locked ? item('Delete', () => this.remove(path, isDir), { danger: true }) : null,
    ].filter(Boolean);
    if (!items.length) return;
    const m = el('div', { class: 'ws-menu', role: 'menu', 'aria-label': path || 'Project' }, ...items);
    document.body.append(m);
    const r = m.getBoundingClientRect(); const x = ev.clientX || ev.target.getBoundingClientRect?.().left || 0, y = ev.clientY || ev.target.getBoundingClientRect?.().bottom || 0;
    m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    m.querySelector('button')?.focus();
    const close = e => { if (e.type === 'keydown' && e.key !== 'Escape') return; if (e.type === 'pointerdown' && m.contains(e.target)) return; m.remove(); removeEventListener('pointerdown', close, true); removeEventListener('keydown', close, true); };
    setTimeout(() => { addEventListener('pointerdown', close, true); addEventListener('keydown', close, true); });
    m.addEventListener('keydown', e => { const b = [...m.querySelectorAll('button')]; const i = b.indexOf(document.activeElement); if (e.key === 'ArrowDown') { e.preventDefault(); b[(i + 1) % b.length].focus(); } if (e.key === 'ArrowUp') { e.preventDefault(); b[(i - 1 + b.length) % b.length].focus(); } });
  }

  // ---------------------------------------------------------------- file operations (local app)
  async ask(title, label, value = '') { const v = await confirmDialog({ title, confirmLabel: 'OK', input: { label, value } }); return typeof v === 'string' ? v.trim().replace(/^\/+|\/+$/g, '') : null; }
  async run(fn) { try { return await fn(); } catch (e) { toast(e.message, 'error'); return null; } }
  async newFile(dir) {
    const name = await this.ask('New file', 'Name', 'notes.md'); if (!name) return;
    const path = join(dir, name);
    if (await this.run(() => this.src.write(path, '', { base: 'new' }))) { this.expandTo(path); await this.refresh(); go(...wsParts(this.id, path)); }
  }
  async newFolder(dir) {
    const name = await this.ask('New folder', 'Name'); if (!name) return;
    const path = join(dir, name);
    if (await this.run(() => this.src.mkdir(path))) { this.expandTo(join(path, 'x')); this.refresh(); }
  }
  async rename(path) {
    const to = await this.ask(`Rename ${baseName(path)}`, 'New path', path); if (!to || to === path) return;
    const tab = this.tabs.get(path);
    if (tab?.dirty) return toast('Save the file before renaming it', 'error');
    if (await this.run(() => this.src.rename(path, to))) {
      for (const t of [...this.tabs.values()]) if (t.path === path || t.path.startsWith(`${path}/`)) { await this.closeTab(t.path, { force: true }); }
      this.expandTo(to); await this.refresh(); if (tab) go(...wsParts(this.id, to));
    }
  }
  async remove(path, isDir) {
    if (!(await confirmDialog({ title: `Delete ${baseName(path)}?`, body: `${isDir ? 'The folder and everything in it move' : 'It moves'} to .studio/trash.`, confirmLabel: 'Delete', danger: true }))) return;
    if (await this.run(() => this.src.remove(path))) { for (const t of [...this.tabs.values()]) if (t.path === path || t.path.startsWith(`${path}/`)) await this.closeTab(t.path, { force: true }); this.refresh(); }
  }
  pickUpload(dir) {
    const pick = el('input', { type: 'file', multiple: true, style: 'display:none' });
    pick.onchange = () => { const f = [...pick.files]; pick.remove(); if (f.length) this.upload(f, dir); };
    document.body.append(pick); pick.click();
  }
  async upload(files, dir) {
    if (isInternal(dir)) return toast('Not allowed here', 'error');
    let n = 0;
    for (const f of files) {
      const path = join(dir, f.name);
      try { await this.src.write(path, f, { base: 'new', kind: 'import' }); n++; }
      catch (e) {
        if (e.status === 409 && e.body?.exists && await confirmDialog({ title: `Replace ${f.name}?`, body: `${path} already exists. The current version stays in the project history.`, confirmLabel: 'Replace' })) { if (await this.run(() => this.src.write(path, f, { kind: 'import' }))) n++; }
        else if (!(e.status === 409 && e.body?.exists)) toast(`${f.name}: ${e.message}`, 'error');
      }
    }
    if (n) { this.expandTo(join(dir, 'x')); toast(`${n} file${n > 1 ? 's' : ''} added`, 'ok'); this.refresh(); }
  }
  async download(path) { const r = await this.run(() => this.src.read(path)); if (r) download(r.blob, baseName(path)); }
  expandTo(path) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/')); }

  // ---------------------------------------------------------------- search / history / settings
  renderSearch() {
    const q = el('input', { class: 'input', type: 'search', placeholder: 'Search files', 'aria-label': 'Search in files', value: this.lastQuery || '' });
    const out = el('div', { class: 'ws-results', 'aria-live': 'polite' });
    const run = async () => {
      this.lastQuery = q.value.trim(); if (!this.lastQuery) { out.replaceChildren(); return; }
      const res = await this.run(() => this.src.search(this.lastQuery)) || [];
      const byFile = new Map(); for (const m of res) { if (!byFile.has(m.path)) byFile.set(m.path, []); if (m.line) byFile.get(m.path).push(m); }
      out.replaceChildren(...(res.length ? [...byFile].map(([p, ms]) => el('div', { class: 'ws-hit' },
        el('a', { href: wsHref(this.id, p), class: 'ws-hit-file' }, icon(fileIcon(p), 'sm'), el('span', {}, p)),
        ...ms.slice(0, 20).map(m => el('a', { href: wsHref(this.id, p), class: 'ws-hit-line', onClick: () => { this.pendingLine = { path: p, line: m.line }; } }, el('span', { class: 'n' }, m.line), el('span', {}, m.text.trim()))))) : [el('p', { class: 'meta', style: 'padding:8px 12px' }, 'No results')]));
    };
    let t; q.oninput = () => { clearTimeout(t); t = setTimeout(run, 250); };
    this.sideBody.append(el('div', { style: 'padding:8px 10px' }, q), out); q.focus(); if (q.value) run();
  }
  async renderHistory() {
    if (this.src.kind !== 'local') { this.sideBody.append(el('p', { class: 'meta', style: 'padding:8px 12px' }, 'Local app only')); return; }
    const list = el('ol', { class: 'ws-log' }); this.sideBody.append(list);
    const log = await this.src.log();
    list.replaceChildren(...log.map(c => el('li', {}, el('span', { class: 'msg', title: c.message }, c.message), el('span', { class: 'meta' }, `${c.oid.slice(0, 7)} · ${fmtRel(c.at)}`))));
  }
  renderSettings() {
    const row = (label, control) => el('label', { class: 'ws-set' }, el('span', {}, label), control);
    const wrap = el('input', { type: 'checkbox', checked: pref('wrap', true), onChange: e => { setPref('wrap', e.target.checked); toast('Applies to files opened next'); } });
    const size = el('select', { class: 'select', onChange: e => { setPref('font', +e.target.value); this.root.style.setProperty('--ws-font', `${e.target.value}px`); } }, ...[12, 13, 14, 15, 16].map(n => el('option', { value: n, selected: pref('font', 13) === n }, `${n}px`)));
    this.sideBody.append(el('div', { class: 'ws-settings' }, row('Wrap lines', wrap), row('Font size', size), el('a', { href: href('account', 'settings'), class: 'meta' }, 'Account settings')));
  }

  // ---------------------------------------------------------------- tabs
  async open(path) {
    this.active = path;
    if (!this.tabs.has(path)) {
      const tab = new Tab(this, path); this.tabs.set(path, tab);
      this.panels.append(tab.panel); tab.load();
    }
    for (const t of this.tabs.values()) t.panel.classList.toggle('active', t.path === path);
    this.expandTo(path); this.renderTabs(); this.renderTree(); this.renderStatus();
    const t = this.tabs.get(path); if (this.pendingLine?.path === path) { t.reveal(this.pendingLine.line); this.pendingLine = null; }
    if (this.locks) t.setLocked(this.locks.has(path));
    this.agentPanel?.refreshContext();
  }
  async closeTab(path, { force = false } = {}) {
    const t = this.tabs.get(path); if (!t) return true;
    if (t.dirty && !force && !(await confirmDialog({ title: `Discard changes to ${baseName(path)}?`, body: 'Your edits since the last save are lost.', confirmLabel: 'Discard changes', danger: true }))) return false;
    t.destroy(); this.tabs.delete(path);
    if (this.active === path) { const next = [...this.tabs.keys()].pop() || null; this.active = null; if (next) go(...wsParts(this.id, next)); else { history.replaceState(null, '', wsHref(this.id, null)); this.ctx.route.path = null; } }
    this.renderTabs(); this.renderTree(); this.renderStatus(); this.agentPanel?.refreshContext();
    return true;
  }
  renderTabs() {
    if (!this.tabs.size) { this.tabStrip.replaceChildren(); this.panels.classList.add('empty'); if (!this.panels.querySelector('.ws-welcome')) this.panels.append(el('div', { class: 'ws-welcome' }, empty({ icon: 'folder', title: this.ctx.store.project.name, body: 'Open a file from the tree.' }))); return; }
    this.panels.classList.remove('empty'); this.panels.querySelector('.ws-welcome')?.remove();
    this.tabStrip.replaceChildren(...[...this.tabs.values()].map(t => el('div', { class: `ws-tab${t.path === this.active ? ' active' : ''}${t.dirty ? ' dirty' : ''}`, role: 'tab', 'aria-selected': String(t.path === this.active), title: t.path, dataset: { path: t.path } },
      el('a', { href: wsHref(this.id, t.path), onAuxclick: e => { if (e.button === 1) { e.preventDefault(); this.closeTab(t.path); } } }, icon(fileIcon(t.path), 'sm'), el('span', {}, baseName(t.path))),
      el('button', { type: 'button', class: 'ws-tab-x', 'aria-label': `Close ${baseName(t.path)}${t.dirty ? ' (unsaved)' : ''}`, onClick: () => this.closeTab(t.path) }, el('i', { class: 'ws-dirty' }), icon('x', 'sm')))));
  }
  renderStatus() {
    const n = dirtyCount(); const v = this.vcs;
    const t = this.tabs.get(this.active);
    this.status.replaceChildren(); append(this.status,
      el('span', { class: 'ws-st', title: LOCAL ? 'Files are in a folder on this computer' : 'Files are kept in this browser' }, icon(LOCAL ? 'folder' : 'database', 'sm'), LOCAL ? 'Local' : 'Browser'),
      v?.branch ? el('span', { class: 'ws-st', title: v.last ? `${v.last.oid.slice(0, 7)} ${v.last.message}` : '' }, icon('history', 'sm'), v.branch, v.last ? el('span', { class: 'meta' }, ` · ${v.last.message.slice(0, 48)}`) : null) : null,
      el('span', { class: 'spacer' }),
      t?.info ? el('span', { class: 'ws-st' }, el('a', { href: href('p', this.id, ...t.info.page) }, t.info.label)) : null,
      el('span', { class: `ws-st save ${this.saving ? 'busy' : n ? 'dirty' : 'ok'}` }, this.saving ? 'Saving…' : n ? `${n} unsaved` : 'Saved'));
  }
  onKey(e) {
    if (!this.root.isConnected || this.root.offsetParent === null) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { const t = this.tabs.get(this.active); if (t) { e.preventDefault(); t.save(); } }
  }
}

// The selection in an open presentation / document (read-only macros).
const SEL_PPTX = `const pr = Api.GetPresentation(); const n = pr.GetSlidesCount(); let idx = [];
try { const sel = Api.GetSelection && Api.GetSelection(); const sl = sel && sel.GetSlides ? sel.GetSlides() : []; for (const s of sl || []) idx.push(s.GetSlideIndex()); } catch (e) { idx = []; }
if (!idx.length) idx = [pr.GetCurSlideIndex ? pr.GetCurSlideIndex() : 0];
idx = [...new Set(idx)].filter(i => i >= 0 && i < n).sort((a, b) => a - b);
const title = i => { const s = pr.GetSlideByIndex(i); for (const sh of s.GetAllShapes()) { const c = sh.GetDocContent && sh.GetDocContent(); if (!c) continue; const t = []; for (let k = 0; k < c.GetElementsCount(); k++) { const e = c.GetElement(k); if (e && e.GetText) t.push(e.GetText().trim()); } const x = t.join(' ').trim(); if (x) return x.slice(0, 120); } return ''; };
return { slides: idx.map(i => i + 1), titles: idx.map(title), count: n };`;
const SEL_DOCX = `const d = Api.GetDocument(); const r = d.GetRangeBySelect && d.GetRangeBySelect(); if (!r) return null;
const text = r.GetText ? r.GetText() : ''; if (!text || !text.trim()) return null;
const out = []; const ps = r.GetAllParagraphs ? r.GetAllParagraphs() : [];
for (const p of ps) { let i = -1; try { i = p.GetPosInParent(); } catch (e) { i = -1; } if (i < 0) { const t = p.GetText(); for (let k = 0; k < d.GetElementsCount(); k++) { const e = d.GetElement(k); if (e && e.GetText && e.GetText() === t) { i = k; break; } } } if (i >= 0) out.push(i + 1); }
return { paragraphs: [...new Set(out)].sort((a, b) => a - b), text };`;

const wsParts = (id, path) => ['p', id, 'workspace', ...path.split('/')];

// ---------------------------------------------------------------- one open file
class Tab {
  constructor(w, path) {
    this.w = w; this.path = path; this.ext = extOf(path); this.dirty = false; this.baseSha = null; this.busy = false;
    this.kind = officeFormat(path) ? 'office' : TEXT_EXT.has(this.ext) || this.ext === '' ? 'code' : this.ext === 'pdf' ? 'pdf' : MEDIA[this.ext] ? 'media' : 'binary';
    this.owner = w.ownerInfo(path); this.info = this.owner;
    this.readOnly = w.readOnly(path);
    this.tools = el('div', { class: 'ws-tools' });
    this.banner = el('div', { class: 'ws-banner' });
    this.body = el('div', { class: 'ws-tabbody' });
    this.cover = el('div', { class: 'ws-lockcover', hidden: true, title: 'The agent is working on this file' });
    this.panel = el('div', { class: 'ws-panel', role: 'tabpanel', 'aria-label': path }, this.tools, this.banner, this.body, this.cover);
    this.readyP = new Promise(r => { this._readyR = r; });
  }
  ready() { return this.readyP; }
  setLocked(on) { if (this.locked === on) return; this.locked = on; this.cover.hidden = !on; this.renderTools(); }
  /** What the agent gets as context for this tab: the file, plus the selection (lines, slides, paragraphs). */
  async context() {
    const base = { path: this.path, label: baseName(this.path) };
    if (this.kind === 'code' && this.code?.view) {
      const st = this.code.view.state; const sel = st.selection.main; if (sel.empty) return base;
      const a = st.doc.lineAt(sel.from).number, b = st.doc.lineAt(sel.to).number;
      return { ...base, label: `${base.label}:${a}${b > a ? `-${b}` : ''}`, lines: [a, b], text: st.doc.sliceString(sel.from, sel.to).slice(0, 6000) };
    }
    if (this.kind === 'office' && this.office?.state.opened && !this.previewBlob) {
      if (this.office.format === 'pptx') {
        const r = await this.office.macro(SEL_PPTX, null, true); if (!r?.slides?.length) return base;
        return { ...base, label: `${base.label} · slide${r.slides.length > 1 ? 's' : ''} ${r.slides.join(', ')}`, slides: r.slides, text: r.titles.map((t, i) => `Slide ${r.slides[i]}: ${t}`).join('\n') };
      }
      const r = await this.office.macro(SEL_DOCX, null, true); if (!r?.paragraphs?.length) return base;
      const ps = r.paragraphs; const span = ps.length > 1 ? `${ps[0]}–${ps.at(-1)}` : `${ps[0]}`;
      return { ...base, label: `${base.label} · ¶${span}`, paragraphs: ps, text: String(r.text || '').slice(0, 6000) };
    }
    return base;
  }
  /** An agent's version of this .pptx/.docx, shown without saving. */
  async showPreview(blob) {
    this.previewBlob = blob; this.renderTools();
    this.banner.replaceChildren(notice('info', el('b', {}, 'Agent preview. '), 'Not saved. ', button({ label: 'Back to current', size: 'sm', onClick: () => this.w.endPreview(this.path) })));
    await this.office.openBuffer(blob);
  }
  get store() { return this.w.ctx.store; }
  setDirty(d) { if (this.dirty === d) return; this.dirty = d; this.w.renderTabs(); this.w.renderStatus(); this.w.renderTree(); this.renderTools(); }

  renderTools() {
    const o = this.owner; const conv = o && o.chapter && CONVERTIBLE.has(o.stageId) && !this.readOnly;
    const parts = this.path.split('/');
    this.tools.replaceChildren(); append(this.tools,
      el('span', { class: 'ws-crumbs' }, ...parts.flatMap((p, i) => [i ? el('span', { class: 'sep' }, '/') : null, i === parts.length - 1 ? el('b', {}, p) : el('span', {}, p)])),
      this.readOnly ? el('span', { class: 'ws-lock', title: isInternal(this.path) || this.w.managed.has(this.path) ? 'Managed by the app' : 'Read-only here' }, 'read-only') : null,
      this.locked ? el('span', { class: 'ws-lock agent', title: 'Read-only while the agent works on it' }, icon('message', 'sm'), 'agent') : null,
      this.previewBlob ? el('span', { class: 'ws-lock preview', title: 'Showing the agent’s version; not saved' }, 'preview') : null,
      el('span', { class: 'spacer' }),
      this.kind === 'code' && this.ext === 'md' ? el('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, ...[['source', 'Source'], ['split', 'Split'], ['preview', 'Preview']].map(([v, l]) => el('button', { type: 'button', 'aria-pressed': String((this.mode || 'source') === v), onClick: () => this.setMode(v) }, l))) : null,
      conv && this.kind === 'code' && this.ext === 'md' ? button({ label: 'Convert to Word', size: 'sm', variant: 'ghost', onClick: () => this.convert(false) }) : null,
      conv && this.ext === 'docx' ? button({ label: 'Convert to Markdown', size: 'sm', variant: 'ghost', onClick: () => this.convert(true) }) : null,
      this.kind === 'office' ? button({ label: 'Export PDF', size: 'sm', variant: 'ghost', disabled: !this.office?.state.opened, onClick: () => this.exportPdf() }) : null,
      button({ icon: 'download', size: 'sm', variant: 'ghost', title: 'Download', onClick: () => this.w.download(this.path) }),
      (this.kind === 'code' || this.kind === 'office') && !this.readOnly ? button({ label: 'Save', size: 'sm', variant: this.dirty ? 'primary' : '', disabled: !this.dirty || this.busy || this.locked || !!this.previewBlob, onClick: () => this.save() }) : null);
  }

  async load() {
    this.renderTools();
    this.body.replaceChildren(el('p', { class: 'meta', style: 'padding:16px' }, 'Opening…'));
    let r; try { r = await this.w.src.read(this.path); } catch (e) { this.body.replaceChildren(notice('error', e.message)); return; }
    if (!r) { this.body.replaceChildren(empty({ icon: 'file', title: 'Not found', body: this.path })); return; }
    this.baseSha = r.sha;
    try {
      if (this.kind !== 'office') this._readyR();
      if (this.kind === 'code') await this.loadCode(r.blob);
      else if (this.kind === 'office') await this.loadOffice(r.blob);
      else if (this.kind === 'pdf') await this.loadPdf(r.blob);
      else if (this.kind === 'media') this.loadMedia(r.blob);
      else this.body.replaceChildren(empty({ icon: 'file', title: baseName(this.path), body: `${fmtBytes(r.blob.size)} · no preview`, actions: [button({ label: 'Download', icon: 'download', onClick: () => this.w.download(this.path) })] }));
    } catch (e) { console.error(e); this.body.replaceChildren(notice('error', e.message)); }
    this.renderTools();
  }

  // ---- text
  async loadCode(blob) {
    const text = await blob.text(); this.saved = text;
    this.code = await createCodeEditor({ text, ext: this.ext, readOnly: this.readOnly, wrap: pref('wrap', true), onChange: t => { this.setDirty(t !== this.saved); if (this.mode && this.mode !== 'source') this.schedulePreview(); }, onSave: () => this.save() });
    this.preview = el('div', { class: 'preview md ws-preview' });
    this.split = el('div', { class: 'ws-code' }, this.code.el, this.preview);
    this.body.replaceChildren(this.split); this.setMode(this.mode || 'source');
    if (this.w.pendingLine?.path === this.path) { this.reveal(this.w.pendingLine.line); this.w.pendingLine = null; }
  }
  setMode(v) { this.mode = v; if (this.split) { this.split.dataset.mode = v; if (v !== 'source') this.renderPreview(); } this.renderTools(); }
  schedulePreview() { clearTimeout(this._pv); this._pv = setTimeout(() => this.renderPreview(), 300); }
  async renderPreview() { if (this.code) this.preview.innerHTML = await renderMarkdown(this.code.getText()); }
  reveal(line) {
    const v = this.code?.view; if (!v || !line) return;
    const l = v.state.doc.line(Math.min(line, v.state.doc.lines)); v.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true }); v.focus();
  }

  // ---- Office
  async loadOffice(blob) {
    this.office = new OfficeFrame({
      fileName: baseName(this.path), title: `Editor · ${this.path}`,
      onDirty: d => this.setDirty(d),
      onStatus: (s, text) => { if (s === 'error') this.showBanner('error', text); },
      onExported: (file, { regularSave, dirty }) => { if (regularSave && (this.previewBlob || this.locked)) return toast(this.previewBlob ? 'This is the agent’s preview: keep or discard it in the panel' : 'The agent is working on this file', 'error'); if (regularSave) this.persistOffice(file).then(() => { if (!dirty) this.setDirty(false); }).catch(e => toast(e.message, 'error')); else downloadFile(file, `${baseName(this.path).replace(/\.\w+$/, '')}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`); },
    });
    this.body.replaceChildren(this.office.el);
    await this.office.load(blob);
    this.panel.dataset.ready = '1'; this._readyR();
  }
  async exportPdf() {
    if (this.busy) return; this.busy = true; this.renderTools();
    try {
      const { file } = await this.office.save('PDF');
      const name = `${baseName(this.path).replace(/\.\w+$/, '')}.pdf`;
      if (this.w.src.writable) { const out = `build/${name}`; await this.w.src.write(out, file); toast(`Exported ${out}`, 'ok'); this.w.refresh(); }
      else downloadFile(file, name);
    } catch (e) { toast(e.message, 'error'); }
    finally { this.busy = false; this.renderTools(); }
  }
  /** A saved .pptx/.docx: a new version of its stage, or the plain file. */
  async persistOffice(file) {
    const o = this.owner; const sha = await shaHex(file);
    this.pendingSha = sha;
    if (o?.kind === 'deck') { await commitDeck(this.store, o.chapter.id, file, { name: deckManifest(o.stage.output)?.name, label: o.label, where: o.where }); await this.store.flush(); }
    else if (o?.kind === 'doc') { await commitDoc(this.store, o.chapter.id, o.stageId, file, { name: docManifest(o.stage.output)?.name, label: o.label, where: o.where }); await this.store.flush(); }
    else if (this.w.src.writable) { const r = await this.write(file); if (!r) return false; }
    else throw new Error('This file cannot be saved in the browser edition');
    this.baseSha = sha; this.pendingSha = null; this.w.ctx.render();
    return true;
  }

  // ---- PDF and media
  async loadPdf(blob) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', () => !!window.pdfjsLib);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf = await window.pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
    const pages = el('div', { class: 'ws-pdf', 'aria-label': `${pdf.numPages} pages` }); this.body.replaceChildren(pages);
    const width = Math.max(320, Math.min(1100, this.body.clientWidth - 48 || 900));
    for (let i = 1; i <= Math.min(pdf.numPages, 300); i++) {
      const page = await pdf.getPage(i); const v1 = page.getViewport({ scale: 1 }); const scale = width / v1.width; const vp = page.getViewport({ scale: scale * devicePixelRatio });
      const c = el('canvas', { width: Math.floor(vp.width), height: Math.floor(vp.height), style: `width:${Math.floor(vp.width / devicePixelRatio)}px`, 'aria-label': `Page ${i}`, role: 'img' });
      pages.append(c); await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (!this.panel.isConnected) return;
    }
  }
  loadMedia(blob) {
    this.url = URL.createObjectURL(blob); const k = MEDIA[this.ext];
    const node = k === 'image' ? el('img', { src: this.url, alt: baseName(this.path) }) : el(k, { src: this.url, controls: true });
    this.body.replaceChildren(el('div', { class: 'ws-media' }, node));
  }

  // ---- saving
  async write(data) {
    try { const r = await this.w.src.write(this.path, data, { base: this.baseSha }); return r; }
    catch (e) {
      if (e.status === 409 && e.body?.sha) { this.diskSha = e.body.sha; this.showConflict(); toast('The file changed on disk', 'error'); return null; }
      throw e;
    }
  }
  async save() {
    if (this.readOnly || !this.dirty || this.busy || this.previewBlob) return false;
    if (this.locked) { toast('The agent is working on this file', 'error'); return false; }
    this.busy = true; this.w.saving++; this.w.renderStatus(); this.renderTools();
    try {
      if (this.kind === 'office') { const { file, dirty } = await this.office.save(); const ok = await this.persistOffice(file); if (ok && !dirty) this.setDirty(false); return ok; }
      const text = this.code.getText(); const o = this.owner;
      if (/\.json$/i.test(this.path)) { try { JSON.parse(text); } catch (e) { toast(`Invalid JSON: ${e.message}`, 'error'); return false; } }
      const sha = await shaHex(text); this.pendingSha = sha;
      if (o?.kind === 'text') { this.store.userEdit(o.stage, o.label, text, o.where); await this.store.flush(); this.w.ctx.render(); }
      else if (!(await this.write(text))) return false;
      this.baseSha = sha; this.pendingSha = null; this.saved = text; this.setDirty(this.code.getText() !== text); this.banner.replaceChildren();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
    finally { this.busy = false; this.w.saving--; this.w.renderStatus(); this.renderTools(); }
  }
  async convert(toMarkdown) {
    const o = this.owner; if (!o) return;
    if (this.dirty && !(await this.save())) return;
    try {
      await (toMarkdown ? convertToMarkdown : convertToWord)(this.store, o.chapter, o.stageId, { label: o.label, where: o.where });
      await this.store.flush();
      const next = layout(this.store.project).meta.stages[o.key]; const to = next?.$file || next?.$deck;
      await this.w.closeTab(this.path, { force: true }); await this.w.refresh();
      if (to) go(...wsParts(this.w.id, to)); toast(`${to} is now the stage’s file`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- the file changed elsewhere
  async check() {
    if (this.busy || this.pendingSha || this.previewBlob) return;
    let r; try { r = await this.w.src.read(this.path); } catch { return; }
    this.owner = this.w.ownerInfo(this.path); this.info = this.owner;
    if (!r) { this.showBanner('warn', 'This file was deleted or moved.'); return; }
    if (r.sha === this.baseSha) return;
    this.diskSha = r.sha;
    if (!this.dirty) return this.reloadFrom(r);
    this.showConflict();
  }
  async reloadFrom(r) {
    r ||= await this.w.src.read(this.path); if (!r) return;
    this.baseSha = r.sha; this.banner.replaceChildren();
    if (this.kind === 'code') { const t = await r.blob.text(); this.saved = t; this.code.setText(t); this.setDirty(false); }
    else if (this.kind === 'office') { await this.office.openBuffer(r.blob); this.setDirty(false); }
    else { this.destroyBody(); await this.load(); }
  }
  showConflict() {
    this.banner.replaceChildren(notice('warn', el('b', {}, 'Changed on disk. '), 'Your edits here are not saved yet. ',
      button({ label: 'Reload from disk', size: 'sm', onClick: () => this.reloadFrom() }), ' ',
      button({ label: 'Keep mine', size: 'sm', variant: 'ghost', onClick: () => { this.baseSha = this.diskSha; this.banner.replaceChildren(); } })));
  }
  showBanner(kind, text) { this.banner.replaceChildren(notice(kind, text)); }
  destroyBody() { this.code?.destroy(); this.code = null; this.office?.destroy(); this.office = null; if (this.url) URL.revokeObjectURL(this.url); this.url = null; }
  destroy() { this.destroyBody(); this.panel.remove(); }
}

export { typeOf };
