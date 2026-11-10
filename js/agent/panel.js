// agent/panel.js — the Workspace's agent panel: pick an agent (built-in, Claude Code, Codex), chat over several turns,
// watch its steps live, stop it, and review what it changed (hunks for text, a preview and an off-selection check for
// slides and Word files) before anything reaches the project. Chats are kept per project (.studio/sessions/ in the
// local app, this browser's storage in the browser edition).
import { el, button, icon, toast, confirmDialog, notice, renderMarkdown } from '../ui.js';
import { api, LOCAL, onServerEvent } from '../fs/api.js';
import { LLMClient } from '../llm.js';
import { hunkRows } from '../diff.js';
import { readPptx } from '../pptxdeck.js';
import { docxToMd } from '../docconv.js';
import { runBuiltin } from './builtin.js';
import { jobChanges, overlayChanges, undoCommit } from './changes.js';
import { backend } from '../fs/backend.js';
import { liveEdit } from './live.js';
import { DERIVE, deriveActions, runDerive } from './derive.js';
import { needsSignIn, SIGN_IN_COMMAND, REMOTE_SIGN_IN_COMMAND } from './signin.js';

export const AGENTS = { builtin: 'Built-in', claude: 'Claude Code', codex: 'Codex' };
const LS = 'ia-agent.';
const pref = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const baseName = p => p.split('/').pop();
const ckey = c => c.key || c.path;
const ON_THIS_COMPUTER = ['127.0.0.1', 'localhost'].includes(globalThis.location?.hostname);
const STATUS = { added: ['A', 'Added'], modified: ['M', 'Modified'], deleted: ['D', 'Deleted'] };

// ---------------------------------------------------------------- where chats are kept
function localChats(pid) {
  const P = `/api/projects/${encodeURIComponent(pid)}/agent`;
  return {
    info: () => api(P),
    list: async () => (await api(`${P}/sessions`)).sessions,
    create: agent => api(`${P}/sessions`, { method: 'POST', body: { agent } }),
    get: id => api(`${P}/sessions/${id}`),
    put: (id, b) => api(`${P}/sessions/${id}`, { method: 'PUT', body: b }),
    remove: id => api(`${P}/sessions/${id}`, { method: 'DELETE' }),
    run: (id, b) => api(`${P}/sessions/${id}/run`, { method: 'POST', body: b }),
    cancel: () => api(`${P}/cancel`, { method: 'POST' }),
    discard: id => api(`${P}/sessions/${id}/discard`, { method: 'POST' }),
  };
}
function browserChats(pid) {
  const key = `chats.${pid}`; const all = () => pref(key, []); const save = l => setPref(key, l.slice(0, 30));
  const id = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return {
    info: async () => ({ agents: { claude: false, codex: false }, running: null }),
    list: async () => all().map(({ messages, ...s }) => ({ ...s, count: messages.length })),
    create: async agent => { const now = new Date().toISOString(); const s = { id: id(), agent, title: '', createdAt: now, updatedAt: now, messages: [] }; save([s, ...all()]); return s; },
    get: async sid => { const s = all().find(x => x.id === sid); if (!s) throw new Error('No such chat'); return s; },
    put: async (sid, b) => { const l = all(); const s = l.find(x => x.id === sid); if (!s) return null; Object.assign(s, b, { updatedAt: new Date().toISOString() }); if (!s.title) s.title = (s.messages.find(m => m.role === 'user')?.text || '').slice(0, 60); save([s, ...l.filter(x => x !== s)]); return s; },
    remove: async sid => save(all().filter(x => x.id !== sid)),
  };
}

export class AgentPanel {
  /** ws: the Workspace (its source, tabs, context, locks and previews). */
  constructor(ws) {
    this.ws = ws; this.pid = ws.id; this.chats = LOCAL ? localChats(this.pid) : browserChats(this.pid);
    this.agent = pref('agent', 'builtin'); this.available = { builtin: true, claude: false, codex: false };
    this.session = null; this.list = []; this.running = null; this.review = null; this.chips = []; this.auto = null; this.autoOff = null; this.login = null; this.signedIn = {};
    this.build();
    this.off = LOCAL ? onServerEvent(ev => this.onEvent(ev)) : () => {};
    this.init();
  }
  get ctx() { return this.ws.ctx; }

  build() {
    this.picker = el('select', { class: 'select sm', 'aria-label': 'Agent', onChange: e => this.setAgent(e.target.value) });
    this.chatSel = el('select', { class: 'select sm ag-chats', 'aria-label': 'Chat', onChange: e => this.openChat(e.target.value) });
    this.stopBtn = button({ icon: 'x', label: 'Stop', size: 'sm', variant: 'danger', onClick: () => this.stop(), attrs: { hidden: true } });
    this.head = el('div', { class: 'ag-head' }, this.picker, this.chatSel,
      button({ icon: 'plus', size: 'sm', variant: 'ghost', title: 'New chat', onClick: () => this.newChat() }), this.stopBtn);
    this.log = el('div', { class: 'ag-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
    this.reviewBox = el('div', { class: 'ag-review', hidden: true });
    this.chipRow = el('div', { class: 'ag-chips', 'aria-label': 'Context' });
    this.input = el('textarea', { class: 'textarea ag-input', rows: 3, placeholder: 'Ask the agent… (@ to add a file)', 'aria-label': 'Message to the agent' });
    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('focus', () => this.refreshContext());
    this.sendBtn = button({ icon: 'arrow-up', size: 'sm', variant: 'primary', title: 'Send (Enter)', onClick: () => this.send() });
    this.mention = el('div', { class: 'ag-mention', role: 'listbox', hidden: true, 'aria-label': 'Files' });
    this.actions = el('div', { class: 'ag-actions', role: 'group', 'aria-label': 'Draft from this file', hidden: true });
    this.composer = el('div', { class: 'ag-composer' }, this.actions, this.chipRow, el('div', { class: 'ag-inputrow' }, this.input, this.sendBtn), this.mention);
    this.el = el('div', { class: 'ag' }, this.head, this.log, this.reviewBox, this.composer);
  }
  destroy() { this.off(); this.ws.setLocks(null); }

  async init() {
    try { const info = await this.chats.info(); this.login = info.login || null; this.available = { builtin: true, claude: !!info.agents?.claude, codex: !!info.agents?.codex }; if (info.running) this.running = { session: info.running.session, steps: [], text: '', agent: info.running.agent, scope: info.running.scope }; }
    catch (e) { this.log.replaceChildren(notice('error', e.message)); }
    if (!this.available[this.agent]) this.agent = 'builtin';
    this.renderPicker();
    this.list = await this.chats.list().catch(() => []);
    const want = this.running?.session || pref(`last.${this.pid}`, null);
    if (want && this.list.some(s => s.id === want)) await this.openChat(want); else this.renderAll();
    if (this.running) { this.ws.setLocks(this.running.scope); this.renderRunning(); }
    this.refreshContext();
  }

  // ---------------------------------------------------------------- header
  renderPicker() {
    const why = id => !LOCAL ? 'Runs in the local app (npx instructional-agents)' : `${AGENTS[id]} is not installed on this computer`;
    this.picker.replaceChildren(...Object.entries(AGENTS).map(([id, name]) => el('option', { value: id, disabled: !this.available[id], selected: id === this.agent, title: this.available[id] ? '' : why(id) }, name)));
    this.picker.disabled = !!this.session?.messages?.length || !!this.running; // a chat keeps its agent
    this.picker.title = this.picker.disabled ? 'Start a new chat to switch agents' : '';
    const opts = this.list.map(s => el('option', { value: s.id, selected: s.id === this.session?.id }, `${s.title || 'New chat'} · ${AGENTS[s.agent] || s.agent}`));
    if (!this.session) opts.unshift(el('option', { value: '', selected: true }, 'New chat'));
    this.chatSel.replaceChildren(...opts);
    this.stopBtn.hidden = !this.running;
  }
  setAgent(a) { if (!this.available[a]) return; this.agent = a; setPref('agent', a); if (this.session && !this.session.messages.length) this.session.agent = a; this.renderPicker(); this.renderLog(); }
  async newChat() {
    if (this.running) return toast('Stop the agent first', 'error');
    if (!(await this.dropReview())) return;
    this.session = null; this.review = null; const a = pref('agent', 'builtin'); this.agent = this.available[a] ? a : 'builtin';
    this.renderAll(); this.input.focus();
  }
  async openChat(id) {
    if (!id) return this.newChat();
    if (this.session?.id !== id && !(await this.dropReview(true))) { this.renderPicker(); return; }
    try { this.session = await this.chats.get(id); } catch (e) { toast(e.message, 'error'); return; }
    this.agent = this.session.agent; setPref(`last.${this.pid}`, id);
    this.review = null;
    if (this.session.pending?.changes?.length) await this.loadReview(jobChanges({ projectId: this.pid, session: id, items: this.session.pending.changes, src: this.ws.src, owners: this.ws.owners() }));
    this.renderAll();
  }

  // ---------------------------------------------------------------- conversation
  renderAll() { this.renderPicker(); this.renderLog(); this.renderReview(); this.renderChips(); }
  renderLog() {
    const msgs = this.session?.messages || [];
    if (!msgs.length && !this.running) {
      this.log.replaceChildren(el('div', { class: 'ag-empty' }, icon('message'), el('p', {}, AGENTS[this.agent]),
        el('p', { class: 'meta' }, 'Changes are reviewed before they are saved.'),
        this.agent === 'builtin' && !this.ctx.store.apiKey ? notice('warn', 'Add an API key under Account → Settings.') : null));
      return;
    }
    this.log.replaceChildren(...msgs.map((m, i) => this.renderMsg(m, i === msgs.length - 1)));
    if (this.running && this.running.session === this.session?.id) this.log.append(this.runEl = this.renderLive());
    this.log.scrollTop = this.log.scrollHeight;
  }
  renderMsg(m, last) {
    if (m.role === 'user') return el('div', { class: 'ag-msg user' }, m.context?.length ? el('div', { class: 'ag-chips static' }, ...m.context.map(c => el('span', { class: 'chip' }, icon('file', 'sm'), c.label || baseName(c.path)))) : null, el('div', { class: 'ag-text' }, m.text));
    if (m.kept) return el('div', { class: 'ag-msg note' }, icon(m.undone ? 'history' : 'check', 'sm'),
      el('span', {}, m.undone ? `Undid ${m.kept.paths.length} file${m.kept.paths.length > 1 ? 's' : ''}` : `Kept ${m.kept.paths.join(', ')}`), m.kept.commit ? el('code', { class: 'meta' }, m.kept.commit.slice(0, 7)) : null,
      last && LOCAL && m.kept.commit && !m.undone ? button({ label: 'Undo', size: 'sm', variant: 'ghost', onClick: () => this.undo(m) }) : null);
    if (m.discarded) return el('div', { class: 'ag-msg note' }, icon('x', 'sm'), el('span', {}, 'Changes discarded'));
    const body = el('div', { class: 'ag-text md' }); if (m.text) renderMarkdown(m.text).then(h => { body.innerHTML = h; });
    return el('div', { class: 'ag-msg bot' },
      m.steps?.length ? el('details', { class: 'ag-steps' }, el('summary', {}, `${m.steps.length} step${m.steps.length > 1 ? 's' : ''}`), el('ol', {}, ...m.steps.map(s => el('li', {}, s)))) : null,
      m.text ? body : null, m.error ? notice(/^Stopped/.test(m.error) ? 'warn' : 'error', m.error) : null,
      last ? this.renderSignIn(m) : null,
      m.changes?.length && !(last && this.review) ? el('p', { class: 'meta' }, `${m.changes.length} file${m.changes.length > 1 ? 's' : ''} changed`) : null,
      m.live ? el('p', { class: 'meta' }, icon('check', 'sm'), ` Applied in ${baseName(m.live.path)}`) : null);
  }
  renderSignIn(m) {
    if (!LOCAL || !needsSignIn(m.agent, m.error) || this.signedIn[m.agent]) return null;
    if (!ON_THIS_COMPUTER) return notice('warn', `Run ${REMOTE_SIGN_IN_COMMAND[m.agent]} in a terminal on the computer running the app, then send again.`);
    const waiting = this.login?.agent === m.agent;
    return el('div', { class: 'btn-row' }, waiting
      ? button({ label: 'Waiting for sign-in in your browser…', size: 'sm', disabled: true })
      : button({ label: `Sign in to ${AGENTS[m.agent]}`, size: 'sm', variant: 'primary', title: `Runs ${SIGN_IN_COMMAND[m.agent]}`, onClick: () => this.startLogin(m.agent) }),
    waiting ? button({ label: 'Cancel', size: 'sm', variant: 'ghost', onClick: () => api('/api/agents/login/cancel', { method: 'POST' }).catch(e => toast(e.message, 'error')) }) : null);
  }
  async startLogin(agent) {
    try { this.login = await api('/api/agents/login', { method: 'POST', body: { agent } }); this.renderLog(); }
    catch (e) { toast(e.message, 'error'); }
  }
  onLogin({ agent, status, error }) {
    this.login = status === 'started' ? { agent } : null;
    if (status === 'ok') {
      this.signedIn[agent] = true; toast(`Signed in to ${AGENTS[agent]}. Send your message again.`, 'ok');
      const msgs = this.session?.messages || [];
      if (needsSignIn(agent, msgs.at(-1)?.error) && !this.input.value.trim()) { this.input.value = msgs.findLast(x => x.role === 'user')?.text || ''; this.input.focus(); }
    }
    if (error) toast(error, 'error');
    this.renderLog();
  }
  renderLive() {
    const r = this.running;
    return el('div', { class: 'ag-msg bot ag-running', 'aria-busy': 'true' },
      el('ol', { class: 'ag-steps-live' }, ...r.steps.slice(-8).map(s => el('li', {}, s))),
      r.text ? el('div', { class: 'ag-text' }, r.text.slice(-600)) : null,
      el('p', { class: 'meta ag-working' }, el('i', { class: 'ag-pulse' }), `${AGENTS[r.agent] || 'Agent'} is working…`));
  }
  renderRunning() {
    this.renderPicker(); this.sendBtn.disabled = !!this.running;
    if (this.runEl?.isConnected) this.runEl.replaceWith(this.runEl = this.renderLive()); else this.renderLog();
    this.log.scrollTop = this.log.scrollHeight;
  }

  // ---------------------------------------------------------------- context chips
  async refreshContext() {
    const t = this.ws.activeTab(); const path = t?.path || null;
    if (t?.previewBlob || t?.locked) return; // the agent's preview or its running edit: keep the chip as it was
    if (!path) { this.auto = null; this.renderChips(); return; }
    if (this.autoOff && this.autoOff !== path) this.autoOff = null;
    if (this.autoOff === path) return;
    try { this.auto = await t.context(); } catch { this.auto = { path, label: baseName(path) }; }
    this.renderChips();
  }
  /** Derive actions for the open stage file (slides → outline / script, syllabus → objectives / chapters). */
  renderActions() {
    const t = this.ws.activeTab(); const owner = t?.path ? this.ws.ownerInfo(t.path) : null;
    const ids = this.running ? [] : deriveActions(owner);
    this.actions.replaceChildren(...ids.map(id => button({ label: DERIVE[id].label, size: 'sm', variant: 'ghost', title: DERIVE[id].title, onClick: () => this.derive(id) })));
    this.actions.hidden = !ids.length;
  }
  /** Open with the input focused and the selection as context (Ask in a tab, Ctrl/⌘+K). */
  async focusAsk() { this.autoOff = null; this.input.focus(); await this.refreshContext(); this.input.focus(); }
  /** Start a message: text in the input, extra context chips; the instructor reviews and sends it. */
  async prefill({ text = '', chips = [], fresh = false } = {}) {
    if (this.running) { toast('The agent is still working', 'error'); return false; }
    if (fresh && this.session?.messages?.length) await this.newChat();
    this.autoOff = null; await this.refreshContext();
    for (const c of chips) { this.chips = this.chips.filter(x => ckey(x) !== ckey(c)); this.chips.push(c); }
    if (text) this.input.value = text;
    this.renderChips(); this.input.focus(); this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    return true;
  }
  renderChips() {
    this.renderActions();
    const chip = (c, onRemove) => el('span', { class: `chip${c.auto ? ' auto' : ''}`, title: c.path }, icon('file', 'sm'), el('span', {}, c.label || baseName(c.path)),
      el('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${c.label || c.path}`, onClick: onRemove }, icon('x', 'sm')));
    const all = [];
    if (this.auto) all.push(chip({ ...this.auto, auto: true }, () => { this.autoOff = this.auto.path; this.auto = null; this.renderChips(); }));
    for (const c of this.chips) all.push(chip(c, () => { this.chips = this.chips.filter(x => x !== c); this.renderChips(); }));
    this.chipRow.replaceChildren(...all); this.chipRow.hidden = !all.length;
  }
  context() { const out = []; if (this.auto) out.push(this.auto); for (const c of this.chips) if (!out.some(x => ckey(x) === ckey(c))) out.push(c); return out; }

  onInput() {
    const v = this.input.value.slice(0, this.input.selectionStart); const m = v.match(/(^|\s)@([^\s@]*)$/);
    if (!m) { this.mention.hidden = true; return; }
    const q = m[2].toLowerCase();
    const files = this.ws.entries.filter(e => !e.dir && !/^(\.git|\.studio|build)(\/|$)/.test(e.path) && e.path.toLowerCase().includes(q)).slice(0, 8);
    if (!files.length) { this.mention.hidden = true; return; }
    this.mentionIdx = 0; this.mentionFiles = files;
    this.mention.replaceChildren(...files.map((f, i) => el('div', { class: 'ag-opt', role: 'option', id: `ag-opt-${i}`, 'aria-selected': String(i === 0), onMousedown: e => { e.preventDefault(); this.pickMention(f.path); } }, icon('file', 'sm'), el('span', {}, f.path))));
    this.mention.hidden = false; this.input.setAttribute('aria-activedescendant', 'ag-opt-0');
  }
  pickMention(path) {
    const pos = this.input.selectionStart; const before = this.input.value.slice(0, pos).replace(/@[^\s@]*$/, ''); this.input.value = before + this.input.value.slice(pos);
    this.input.selectionStart = this.input.selectionEnd = before.length; this.mention.hidden = true;
    if (!this.chips.some(c => ckey(c) === path) && this.auto?.path !== path) this.chips.push({ path, label: baseName(path) });
    this.renderChips(); this.input.focus();
  }
  onKey(e) {
    if (!this.mention.hidden) {
      const opts = [...this.mention.children];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); this.mentionIdx = (this.mentionIdx + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === this.mentionIdx))); this.input.setAttribute('aria-activedescendant', `ag-opt-${this.mentionIdx}`); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.pickMention(this.mentionFiles[this.mentionIdx].path); return; }
      if (e.key === 'Escape') { this.mention.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
  }

  // ---------------------------------------------------------------- a turn
  async send() {
    const text = this.input.value.trim(); if (!text || this.running) return;
    if (this.agent === 'builtin' && !this.ctx.store.apiKey) return toast('Add an API key under Account → Settings', 'error');
    if (!(await this.dropReview())) return;
    await this.refreshContext();
    let context = this.context();
    // a light edit happens in the open document itself (unsaved edits included); anything else reads the saved files
    const liveFirst = this.agent === 'builtin' && (!this.session || this.session.agent === 'builtin') && this.liveTarget(context);
    if (!liveFirst) { if (!(await this.ws.saveAllFirst())) return; await this.refreshContext(); context = this.context(); }
    const scope = [...new Set(context.map(c => c.path))];
    try {
      if (!this.session) { this.session = await this.chats.create(this.agent); setPref(`last.${this.pid}`, this.session.id); this.session.messages ||= []; }
    } catch (e) { return toast(e.message, 'error'); }
    this.input.value = ''; this.chips = [];
    this.lastContext = context;
    const live = this.session.agent === 'builtin' ? this.liveTarget(context) : null;
    if (live) return this.runLive(text, context, live);
    if (this.session.agent === 'builtin') return this.runBuiltin(text, context, scope);
    delete this.signedIn[this.session.agent];
    this.running = { session: this.session.id, steps: [], text: '', agent: this.session.agent, scope };
    this.session.messages.push({ role: 'user', text, context, at: new Date().toISOString() });
    this.ws.setLocks(scope); this.renderAll(); this.renderRunning();
    try { await this.chats.run(this.session.id, { message: text, context, scope }); }
    catch (e) { this.running = null; this.ws.setLocks(null); this.session.messages.pop(); this.renderAll(); this.sendBtn.disabled = false; toast(e.message, 'error'); }
  }
  async onEvent(ev) {
    if (ev.type === 'agent-login') return this.onLogin(ev);
    if (ev.type !== 'agent' || ev.id !== this.pid) return;
    const e = ev.ev || {};
    if (e.type === 'start') { if (!this.running) { this.running = { session: e.session, steps: [], text: '', agent: e.agent, scope: e.scope || [] }; this.ws.setLocks(e.scope || []); this.renderRunning(); } return; }
    if (!this.running || this.running.session !== e.session) return;
    if (e.type === 'step') { this.running.steps.push(e.text); this.renderRunning(); }
    if (e.type === 'text') { this.running.text = e.text; this.renderRunning(); }
    if (e.type === 'done') {
      this.running = null; this.ws.setLocks(null); this.sendBtn.disabled = false;
      if (this.session?.id === e.session) {
        try { this.session = await this.chats.get(e.session); } catch { /* keep */ }
        if (e.changes?.length) await this.loadReview(jobChanges({ projectId: this.pid, session: e.session, items: e.changes, src: this.ws.src, owners: this.ws.owners() }));
      }
      this.list = await this.chats.list().catch(() => this.list);
      this.renderAll();
    }
  }
  async stop() {
    if (this.builtinAbort) { this.builtinAbort.abort(); return; }
    try { await this.chats.cancel(); } catch (e) { toast(e.message, 'error'); }
  }

  async runBuiltin(text, context, scope) {
    const s = this.session; const store = this.ctx.store;
    const history = s.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.text).map(m => ({ role: m.role, text: m.text }));
    s.messages.push({ role: 'user', text, context, at: new Date().toISOString() });
    this.running = { session: s.id, steps: [], text: '', agent: 'builtin', scope };
    this.ws.setLocks(scope); this.renderAll(); this.renderRunning();
    const ac = this.builtinAbort = new AbortController();
    const office = this.ws.officeFor(scope);
    let guide = null; try { const g = await this.ws.src.read('AGENTS.md'); guide = g ? await g.blob.text() : null; } catch { /* none */ }
    const env = {
      llm: new LLMClient({ ...store.settings, apiKey: store.apiKey }), model: store.settings.model, src: this.ws.src, office, guide, sources: store.project.sources || [],
      readText: async (p, blob) => /\.pptx$/i.test(p) ? (await readPptx(blob)).map(x => `Slide ${x.slide_id}: ${x.title}\n${x.bullets.map(b => `- ${b}`).join('\n')}${x.notes ? `\nNotes: ${x.notes}` : ''}`).join('\n\n') : docxToMd(blob),
    };
    const msg = { role: 'assistant', agent: 'builtin', text: '', steps: [], at: null };
    try {
      const r = await runBuiltin({ env, history, message: text, context, signal: ac.signal, onStep: st => { this.running.steps.push(st); this.renderRunning(); },
        log: res => store.log({ type: 'llm_call', where: 'workspace', stage: 'Agent', agent: 'builtin', model: res.model, status: 'done', tokens: res.usage?.total_tokens, ms: res.durationMs }) });
      Object.assign(msg, { text: r.text, steps: r.steps, changes: [...r.overlay.keys()].map(p => ({ path: p })) });
      if (r.overlay.size) await this.loadReview(await overlayChanges({ overlay: r.overlay, src: this.ws.src, owners: this.ws.owners() }));
    } catch (e) { Object.assign(msg, { steps: this.running.steps, error: e.name === 'AbortError' ? 'Stopped.' : e.message }); }
    finally {
      msg.at = new Date().toISOString(); s.messages.push(msg);
      this.running = null; this.builtinAbort = null; this.ws.setLocks(null); this.sendBtn.disabled = false;
      await this.saveSession(); this.list = await this.chats.list().catch(() => this.list); this.renderAll();
    }
  }
  /** A light edit of the selection in the open .pptx/.docx (built-in agent): the open tab, and its selection chip. */
  liveTarget(context) {
    const t = this.ws.activeTab();
    if (t?.kind !== 'office' || !t.office?.state.opened || t.previewBlob || t.readOnly || t.locked) return null;
    const chip = context.find(c => c.path === t.path && (c.slides?.length || c.paragraphs?.length));
    return chip && context.every(c => c.path === t.path) ? { tab: t, chip } : null;
  }
  async runLive(text, context, { tab, chip }) {
    const s = this.session; const store = this.ctx.store;
    s.messages.push({ role: 'user', text, context, at: new Date().toISOString() });
    this.running = { session: s.id, steps: [], text: '', agent: 'builtin', scope: [] };
    this.renderAll(); this.renderRunning();
    const ac = this.builtinAbort = new AbortController();
    const msg = { role: 'assistant', agent: 'builtin', text: '', steps: [], at: null };
    try {
      const wasDirty = tab.dirty; const owner = this.ws.ownerInfo(tab.path);
      const r = await liveEdit({ office: tab.office, chip, instruction: text, course: store.project.course?.name || store.project.name, where: owner?.where || baseName(tab.path),
        llm: new LLMClient({ ...store.settings, apiKey: store.apiKey }), model: store.settings.model, signal: ac.signal,
        onStep: st => { this.running.steps.push(st); this.renderRunning(); },
        log: res => store.log({ type: 'llm_call', where: 'workspace', stage: 'Agent (live)', agent: 'builtin', model: res.model, status: 'done', tokens: res.usage?.total_tokens, ms: res.durationMs }) });
      Object.assign(msg, { text: `${r.summary || 'Done.'}\n\n${r.lines.map(l => `- ${l}`).join('\n')}`, steps: this.running.steps.slice(), live: { path: tab.path } });
      tab.showLive({ summary: r.summary, snapshot: r.snapshot, wasDirty });
    } catch (e) { Object.assign(msg, { steps: this.running.steps.slice(), error: e.name === 'AbortError' ? 'Stopped.' : e.message }); }
    finally {
      msg.at = new Date().toISOString(); s.messages.push(msg);
      this.running = null; this.builtinAbort = null; this.sendBtn.disabled = false;
      await this.saveSession(); this.list = await this.chats.list().catch(() => this.list); this.renderAll();
    }
  }
  /** Draft an upstream stage from the open file (one model call), then review it like any change. */
  async derive(id) {
    const t = this.ws.activeTab(); const owner = t?.path ? this.ws.ownerInfo(t.path) : null; if (!owner) return;
    const store = this.ctx.store;
    if (!store.apiKey) return toast('Add an API key under Account → Settings', 'error');
    if (this.running) return;
    if (!(await this.dropReview())) return;
    if (!(await this.ws.saveAllFirst())) return;
    try {
      if (!this.session || this.session.agent !== 'builtin') { this.session = await this.chats.create('builtin'); this.agent = 'builtin'; setPref(`last.${this.pid}`, this.session.id); this.session.messages ||= []; }
    } catch (e) { return toast(e.message, 'error'); }
    const s = this.session; const context = [{ path: t.path, label: baseName(t.path) }]; this.lastContext = context;
    s.messages.push({ role: 'user', text: DERIVE[id].title, context, at: new Date().toISOString() });
    this.running = { session: s.id, steps: [], text: '', agent: 'builtin', scope: [] };
    this.renderAll(); this.renderRunning();
    const ac = this.builtinAbort = new AbortController();
    const msg = { role: 'assistant', agent: 'builtin', text: '', steps: [], at: null };
    try {
      const r = await runDerive(id, { owner: { ...owner, path: t.path }, store, llm: new LLMClient({ ...store.settings, apiKey: store.apiKey }), model: store.settings.model, signal: ac.signal,
        onStep: st => { this.running.steps.push(st); this.renderRunning(); },
        log: res => store.log({ type: 'llm_call', where: 'workspace', stage: `Agent (${DERIVE[id].label.toLowerCase()})`, agent: 'builtin', model: res.model, status: 'done', tokens: res.usage?.total_tokens, ms: res.durationMs }) });
      Object.assign(msg, { text: r.summary, steps: this.running.steps.slice(), changes: [...r.overlay.keys()].map(p => ({ path: p })) });
      await this.loadReview(await overlayChanges({ overlay: r.overlay, src: this.ws.src, owners: this.ws.owners(), keys: r.keys, beforeCommit: r.beforeCommit }));
    } catch (e) { Object.assign(msg, { steps: this.running.steps.slice(), error: e.name === 'AbortError' ? 'Stopped.' : e.message }); }
    finally {
      msg.at = new Date().toISOString(); s.messages.push(msg);
      this.running = null; this.builtinAbort = null; this.sendBtn.disabled = false;
      await this.saveSession(); this.list = await this.chats.list().catch(() => this.list); this.renderAll();
    }
  }
  async saveSession() { if (!this.session) return; try { const r = await this.chats.put(this.session.id, { messages: this.session.messages }); if (r?.title) this.session.title = r.title; } catch (e) { console.warn('chat not saved', e); } }

  // ---------------------------------------------------------------- review
  async loadReview(cs) {
    try { await cs.load(); } catch (e) { toast(`Could not read the changes: ${e.message}`, 'error'); return; }
    cs.agent = this.session?.agent;
    const ctx = this.lastContext || [...(this.session?.messages || [])].reverse().find(m => m.role === 'user')?.context || [];
    for (const it of cs.items) {
      if (!/\.(pptx|docx)$/i.test(it.path) || it.status !== 'modified') continue;
      const c = ctx.find(x => x.path === it.path); await cs.check(it, c?.slides || c?.paragraphs || []);
    }
    this.review = cs.items.length ? cs : null;
    if (!this.review && this.session?.id && LOCAL && this.session.agent !== 'builtin') this.chats.discard(this.session.id).catch(() => {});
  }
  renderReview() {
    const cs = this.review; this.reviewBox.hidden = !cs; if (!cs) { this.reviewBox.replaceChildren(); return; }
    const n = cs.pending.filter(it => !it.rejected).length;
    const items = cs.items.map(it => this.renderItem(it));
    this.reviewBox.replaceChildren(
      el('div', { class: 'ag-review-head' }, el('b', {}, `${cs.items.length} changed file${cs.items.length > 1 ? 's' : ''}`), el('span', { class: 'spacer' }),
        button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => this.discard() }),
        button({ label: n ? `Keep ${n}` : 'Keep', icon: 'check', size: 'sm', variant: 'primary', disabled: !n, onClick: () => this.keep() })),
      el('div', { class: 'ag-files' }, ...items));
  }
  renderItem(it) {
    const [letter, label] = STATUS[it.status];
    const toggleAll = on => { it.accepted = it.hunks?.length && it.status === 'modified' ? new Set(on ? it.hunks.map(h => h.id) : []) : on; this.renderReview(); };
    const box = el('input', { type: 'checkbox', checked: this.review.isAccepted(it), disabled: !!it.rejected, 'aria-label': `Keep ${it.path}`, onChange: e => toggleAll(e.target.checked) });
    if (it.accepted instanceof Set && it.accepted.size && it.accepted.size < it.hunks.length) box.indeterminate = true;
    const head = el('div', { class: 'ag-file-head' }, box, el('span', { class: `ag-st ${it.status}`, title: label, 'aria-label': label }, letter),
      el('button', { type: 'button', class: 'ag-path', title: it.path, onClick: () => this.ws.reveal(it.path) }, it.path),
      it.conflict ? el('span', { class: 'ag-flag warn', title: 'Also changed in the project since the agent started' }, 'changed since') : null,
      it.rejected ? el('span', { class: 'ag-flag danger', title: it.rejected }, 'refused') : null);
    const out = el('div', { class: 'ag-file' }, head);
    if (it.rejected) out.append(el('p', { class: 'meta ag-why' }, it.rejected));
    if (it.text && it.status === 'modified' && !it.rejected) {
      for (const h of it.hunks) {
        const on = it.accepted.has(h.id);
        out.append(el('div', { class: `ag-hunk${on ? '' : ' off'}` },
          el('label', { class: 'ag-hunk-head' }, el('input', { type: 'checkbox', checked: on, 'aria-label': `Keep change ${h.id + 1} in ${baseName(it.path)}`, onChange: e => { if (e.target.checked) it.accepted.add(h.id); else it.accepted.delete(h.id); this.renderReview(); } }), el('span', { class: 'meta' }, `line ${h.a + 1}`)),
          el('pre', { class: 'ag-diff' }, ...hunkRows(it.before, h).map(r => el('div', { class: `ag-line ${r.kind === '+' ? 'add' : r.kind === '-' ? 'del' : ''}` }, el('span', { class: 'sign', 'aria-hidden': 'true' }, r.kind), r.text || ' ')))));
      }
    } else if (it.text && it.status === 'added' && !it.rejected) out.append(el('pre', { class: 'ag-diff' }, ...it.after.split('\n').slice(0, 40).map(t => el('div', { class: 'ag-line add' }, el('span', { class: 'sign' }, '+'), t || ' '))));
    if (!it.text && it.afterBlob && /\.(pptx|docx)$/i.test(it.path)) {
      const c = it.check; const unit = /\.pptx$/i.test(it.path) ? 'Slide' : 'Paragraph';
      out.append(el('div', { class: 'ag-office' },
        c?.error ? notice('warn', `Check failed: ${c.error}`) : c ? (c.changedOutside.length ? notice('warn', `${unit}${c.changedOutside.length > 1 ? 's' : ''} ${c.changedOutside.join(', ')} changed outside the selection`) : el('p', { class: 'ag-ok' }, icon('check', 'sm'), c.targets.length ? `Nothing outside ${unit.toLowerCase()}${c.targets.length > 1 ? 's' : ''} ${c.targets.join(', ')} changed` : 'Checked') ) : null,
        c && c.before !== c.after ? el('p', { class: 'meta' }, `${c.before} → ${c.after} ${unit.toLowerCase()}s`) : null,
        this.ws.previewing(it.path) ? button({ label: 'Back to current', size: 'sm', onClick: () => this.ws.endPreview(it.path) }) : button({ label: 'Preview', icon: 'presentation', size: 'sm', onClick: () => this.ws.preview(it.path, it.afterBlob).catch(e => toast(e.message, 'error')) })));
    }
    return out;
  }
  async keep() {
    const cs = this.review; if (!cs) return;
    if (cs.items.some(it => it.conflict && cs.isAccepted(it)) && !(await confirmDialog({ title: 'Overwrite newer edits?', body: 'Some files changed in the project after the agent started. Keeping replaces those edits with the reviewed version.', confirmLabel: 'Keep anyway', danger: true }))) return;
    for (const it of cs.items) if (this.ws.previewing(it.path)) await this.ws.endPreview(it.path, { reload: false });
    try {
      const r = await cs.keep(this.ctx);
      this.review = null;
      this.session.messages.push({ role: 'assistant', text: '', kept: { commit: r.commit, paths: r.paths }, at: new Date().toISOString() });
      await this.saveSession();
      this.ctx.render(); this.ws.refresh(); this.ws.checkTabs(r.paths);
      toast(`Kept ${r.paths.length} file${r.paths.length > 1 ? 's' : ''}`, 'ok');
    } catch (e) { toast(e.message, 'error'); }
    this.renderAll();
  }
  async discard() {
    for (const it of this.review?.items || []) if (this.ws.previewing(it.path)) await this.ws.endPreview(it.path);
    if (LOCAL && this.session && this.session.agent !== 'builtin') await this.chats.discard(this.session.id).catch(() => {});
    this.review = null;
    if (this.session) { this.session.messages.push({ role: 'assistant', text: '', discarded: true, at: new Date().toISOString() }); await this.saveSession(); }
    this.renderAll();
  }
  /** Before something replaces the pending review: ask. */
  async dropReview(switching = false) {
    if (!this.review?.items.length) return true;
    if (!(await confirmDialog({ title: 'Discard the pending changes?', body: switching ? 'They have not been kept yet.' : 'A new message starts from the project as it is now.', confirmLabel: 'Discard changes', danger: true }))) return false;
    await this.discard(); return true;
  }
  async undo(m) {
    if (!(await confirmDialog({ title: 'Undo the kept changes?', body: `${m.kept.paths.join(', ')} go back to how they were before.`, confirmLabel: 'Undo' }))) return;
    try {
      await undoCommit(this.pid, m.kept.commit);
      await backend.sync(this.ctx.store.project); this.ctx.store.emit();
      m.undone = true; await this.saveSession();
      this.ctx.render(); this.ws.refresh(); this.ws.checkTabs(m.kept.paths);
      toast('Undone', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    this.renderLog();
  }
}

