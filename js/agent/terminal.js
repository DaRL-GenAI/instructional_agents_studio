// agent/terminal.js — Claude Code and Codex in the Workspace exactly as they run in a terminal (server/terminal.mjs:
// a PTY in the course folder, shown here with xterm.js). The page adds only what helps around it: large buttons for
// the keys the agents ask for (Enter, arrows, Esc), adding the open file to the message, text size, and the list of
// files the agent changed (each one opens in the editor; the History view can undo it).
import { el, button, icon, toast, confirmDialog } from '../ui.js';
import { api, onServerEvent } from '../fs/api.js';
import { loadFirst } from '../export.js';

const NAMES = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal' };
const SIGN_IN = { claude: 'claude', codex: 'codex login' };
const INSTALL = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  codex: 'https://developers.openai.com/codex/cli',
};
const LS = 'ia-term.';
const pref = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const INTERNAL = /^(\.studio|\.git|build)(\/|$)|\.tmp(\.[\w.-]+)?$|(^|\/)(~\$|\.~lock\.)/;

let xtermReady = null;
function loadXterm() {
  xtermReady ||= (async () => {
    if (!document.querySelector('link[data-xterm]')) document.head.append(el('link', { rel: 'stylesheet', href: new URL('../../css/xterm.css', import.meta.url).href, 'data-xterm': '1' }));
    await loadFirst([new URL('../vendor/lib/xterm.js', import.meta.url).href], () => !!window.Terminal);
    await loadFirst([new URL('../vendor/lib/xterm-addon-fit.js', import.meta.url).href], () => !!window.FitAddon);
  })().catch(e => { xtermReady = null; throw e; });
  return xtermReady;
}

/** One program's pane: a start screen, then the live terminal with its helper bar. */
export class TerminalPane {
  constructor(ws, program) {
    this.ws = ws; this.program = program; this.pid = ws.id; this.term = null; this.info = null; this.sock = null; this.changed = new Map();
    this.fontSize = pref('font', 16);
    this.body = el('div', { class: 'tm-body' });
    this.changedBox = el('details', { class: 'tm-changed', hidden: true });
    this.el = el('div', { class: 'tm' }, this.body, this.changedBox);
    this.off = onServerEvent(ev => {
      if (ev.type !== 'changed' || ev.id !== this.pid || ev.source !== 'disk' || !this.info) return;
      for (const p of ev.paths || []) if (!INTERNAL.test(p)) this.changed.set(p, new Date());
      this.renderChanged();
    });
  }
  get base() { return `/api/projects/${encodeURIComponent(this.pid)}/terminals`; }

  async show() {
    if (this.term) { this.fit(); this.term.focus(); return; }
    let r; try { r = await api(this.base); } catch (e) { return this.body.replaceChildren(el('p', { class: 'tm-msg' }, e.message)); }
    const running = r.terminals.find(t => t.program === this.program && t.running);
    if (running) return this.attach(running);
    this.startScreen(r);
  }

  startScreen(r) {
    const name = NAMES[this.program];
    if (r.unavailable) return this.body.replaceChildren(el('div', { class: 'tm-start' }, el('h3', {}, name), el('p', {}, r.unavailable)));
    if (!r.available[this.program]) {
      return this.body.replaceChildren(el('div', { class: 'tm-start' },
        el('h3', {}, `${name} is not installed on this computer`),
        el('ol', {},
          el('li', {}, 'Install it: ', el('a', { href: INSTALL[this.program], target: '_blank', rel: 'noopener' }, `how to install ${name}`), '.'),
          el('li', {}, 'Sign in once: open a terminal and type ', el('code', {}, SIGN_IN[this.program]), '.'),
          el('li', {}, 'Restart this app, then come back here.')),
        button({ label: 'Check again', icon: 'refresh', size: 'lg', onClick: () => this.show() })));
    }
    this.body.replaceChildren(el('div', { class: 'tm-start' },
      el('h3', {}, `${name} in this course folder`),
      el('p', {}, `${name} runs here just as it does in a terminal. Tell it what to change in plain words; it reads and edits the files of this course directly.`),
      el('ul', {},
        el('li', {}, 'Every change is saved and can be undone: the list below shows what changed, and History has each version.'),
        el('li', {}, `When ${name} asks a question, use the large buttons under it (Yes / Enter, ↑, ↓, Esc) or your keyboard.`),
        el('li', {}, 'Use “Add open file” to tell it which file you mean.')),
      button({ label: `Start ${name}`, icon: 'play', variant: 'primary', size: 'lg', onClick: () => this.start() })));
  }

  async start() {
    try { await loadXterm(); } catch (e) { return toast(`Could not load the terminal: ${e.message}`, 'error'); }
    this.mount(); await new Promise(r => requestAnimationFrame(() => r())); this.fit(true);
    // the program starts at the size the page shows, so what it draws first is not reflowed afterwards
    let info; try { info = await api(this.base, { method: 'POST', body: { program: this.program, cols: this.term.cols, rows: this.term.rows } }); } catch (e) { this.term?.dispose(); this.term = null; this.show(); return toast(e.message, 'error'); }
    this.changed.clear(); this.renderChanged(); this.info = info; this.connect(); this.term.focus();
  }

  async attach(info) {
    try { await loadXterm(); } catch (e) { return toast(`Could not load the terminal: ${e.message}`, 'error'); }
    if (!this.term) this.mount();
    this.info = info; this.connect(); setTimeout(() => { this.fit(true); this.term?.focus(); }, 50);
  }

  /** The terminal, its tool bar, the choice buttons and the key buttons. */
  mount() {
    const host = el('div', { class: 'tm-screen', 'aria-label': `${NAMES[this.program]} terminal` });
    const fileBtn = button({ label: 'Add open file', icon: 'file', size: 'sm', title: 'Type the open file (and selected slides) into the message', onClick: () => this.addOpenFile() });
    const tools = el('div', { class: 'tm-tools' },
      fileBtn,
      el('span', { class: 'spacer' }),
      button({ label: 'A−', size: 'sm', variant: 'ghost', title: 'Smaller text', attrs: { 'aria-label': 'Smaller text' }, onClick: () => this.zoom(-1) }),
      button({ label: 'A+', size: 'sm', variant: 'ghost', title: 'Larger text', attrs: { 'aria-label': 'Larger text' }, onClick: () => this.zoom(1) }),
      button({ label: 'New conversation', icon: 'plus', size: 'sm', variant: 'ghost', onClick: () => this.restart() }));
    const key = (label, seq, title, extra = {}) => button({ label, size: 'lg', title, ...extra, onClick: () => { this.send(seq); this.term?.focus(); } });
    this.choices = el('div', { class: 'tm-choices', role: 'group', 'aria-label': 'Answer', hidden: true });
    this.ended = el('div', { class: 'tm-ended', hidden: true });
    const keys = el('div', { class: 'tm-keys', role: 'group', 'aria-label': 'Keys' },
      key('Enter', '\r', 'Confirm the highlighted choice (the same as the Enter key)', { icon: 'check' }),
      key('↑', '\x1b[A', 'Move up in a list', { attrs: { 'aria-label': 'Up' } }),
      key('↓', '\x1b[B', 'Move down in a list', { attrs: { 'aria-label': 'Down' } }),
      key('Esc', '\x1b', 'Cancel the question, or stop the agent while it works'));
    // a plain message box: what older users expect, and it keeps its text when an editor elsewhere takes the focus
    this.input = el('textarea', { class: 'tm-input', rows: 2, 'aria-label': `Message to ${NAMES[this.program]}`, placeholder: `Type what ${NAMES[this.program]} should do, then press Send` });
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendMessage(); } });
    const sendRow = el('div', { class: 'tm-send' }, this.input, button({ label: 'Send', icon: 'arrow-up', variant: 'primary', size: 'lg', onClick: () => this.sendMessage() }));
    this.body.replaceChildren(tools, host, this.ended, this.choices, sendRow, keys);
    const term = this.term = new window.Terminal({ fontSize: this.fontSize, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, macOptionClickForcesSelection: true, allowProposedApi: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace',
      theme: { background: '#1d1f21', foreground: '#e8e8e8', cursor: '#e8e8e8', selectionBackground: '#3a5f8f' } });
    this.fitter = new window.FitAddon.FitAddon(); term.loadAddon(this.fitter); term.open(host);
    // copy with Ctrl/⌘+C when text is selected (otherwise Ctrl+C goes to the program, which uses it to stop)
    term.attachCustomKeyEventHandler(e => {
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) { navigator.clipboard?.writeText(term.getSelection()).catch(() => {}); return false; }
      return true;
    });
    term.onData(d => this.send(d));
    term.onWriteParsed(() => { clearTimeout(this._ct); this._ct = setTimeout(() => this.readChoices(), 150); });
    this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(host);
  }

  /** A choice the program shows (a list with ❯ or › before the highlighted line) as large buttons: one click moves to
   *  that line and confirms it. Nothing is answered without a click. */
  readChoices() {
    const buf = this.term?.buffer.active; if (!buf || !this.choices) return;
    const lines = []; for (let y = Math.max(0, buf.length - this.term.rows); y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) || '');
    const MARK = /^(\s*)[❯›>▶]\s+(\S.*)$/;
    const at = lines.findLastIndex(l => MARK.test(l));
    let opts = null, cur = 0, question = '';
    if (at >= 0) {
      const ind = lines[at].match(MARK)[1].length;
      const isOpt = l => l.trim() && !/^\s*(Enter to|Esc to|↑|Press|\? for)/i.test(l) && (MARK.test(l) || (l.length - l.trimStart().length >= ind + 1 && l.length - l.trimStart().length <= ind + 4));
      let a = at, b = at; while (a > 0 && isOpt(lines[a - 1]) && !MARK.test(lines[a - 1])) a--; while (b < lines.length - 1 && isOpt(lines[b + 1])) b++;
      const block = lines.slice(a, b + 1).filter(l => !/^\s{6,}/.test(l) || MARK.test(l)); // continuation lines of a long option are not options
      // a real question: numbered choices, or the "Enter to confirm / Esc to cancel" hint under the list (the input line
      // of Claude Code also starts with ❯ and must not become a button)
      const numbered = block.filter(l => /^\s*(?:[❯›>▶]\s+)?\d+[.)]\s/.test(l)).length >= 2;
      const hinted = lines.slice(b + 1, b + 5).some(l => /enter to (confirm|select)|esc to (cancel|exit)|press enter/i.test(l));
      if (block.length >= 2 && block.length <= 9 && (numbered || hinted) && !block.some(l => /^\s*⎿/.test(l))) {
        opts = block.map(l => l.replace(MARK, '$2').trim().replace(/^\d+[.)]\s*/, '').replace(/\s+\((esc|shift\+tab|tab)\)$/i, ''));
        cur = block.findIndex(l => MARK.test(l));
        const above = lines.slice(Math.max(0, a - 12), a).map(l => l.trim().replace(/^[│|]\s*|\s*[│|]$/g, '')).filter(l => l && !/^[\s─━═│╭╮╰╯-]+$/.test(l));
        // the last sentence that asks something (it may wrap over lines), else the line just above the choices
        const asked = above.join(' ').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(x => x.includes('?')).map(x => x.slice(0, x.lastIndexOf('?') + 1));
        question = (asked.length ? asked.at(-1).trim() : above.at(-1) || '').slice(0, 200);
      }
    }
    const key = opts ? `${question}|${opts.join('|')}` : '';
    if (key === this.choiceKey) { this.choiceCur = cur; return; }
    this.choiceKey = key; this.choiceCur = cur;
    this.choices.hidden = !opts;
    if (!opts) return this.choices.replaceChildren();
    this.choices.replaceChildren(
      el('div', { class: 'tm-q' }, question ? `${NAMES[this.program]} asks: ${question}` : `${NAMES[this.program]} asks you to choose:`),
      ...opts.map((o, i) => button({ label: o, size: 'lg', variant: /^(yes|allow|proceed|continue|approve|trust)/i.test(o) && i <= 1 ? 'primary' : '', onClick: () => {
        const d = i - this.choiceCur; this.send((d > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(d)));
        setTimeout(() => { this.send('\r'); this.term?.focus(); }, 120);
      } })));
  }

  connect() {
    if (!this.info) return;
    const s = this.sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term/${this.info.id}`);
    s.onopen = () => { this.fit(true); };
    s.onmessage = e => {
      const d = String(e.data);
      if (d.startsWith('\x00')) { try { const m = JSON.parse(d.slice(1)); if (m.type === 'exit') this.onExit(); } catch { /* ignore */ } return; }
      this.term?.write(d);
    };
    s.onclose = () => { if (this.sock === s) this.sock = null; };
  }
  onExit() {
    if (this.info) this.info.running = false;
    this.choices.hidden = true;
    this.ended.hidden = false;
    this.ended.replaceChildren(el('span', {}, `${NAMES[this.program]} has stopped.`), button({ label: `Start ${NAMES[this.program]} again`, icon: 'play', variant: 'primary', size: 'lg', onClick: () => this.restart(true) }));
  }
  send(d) { if (this.sock?.readyState === 1) this.sock.send(d); else if (this.info) { this.connect(); toast('Reconnecting to the terminal…', 'info'); } }
  fit(force = false) {
    if (!this.term || !this.fitter) return;
    try { this.fitter.fit(); } catch { return; }
    const { cols, rows } = this.term; if (!force && this.lastSize === `${cols}x${rows}`) return; this.lastSize = `${cols}x${rows}`;
    if (this.sock?.readyState === 1) this.sock.send(`\x00${JSON.stringify({ type: 'resize', cols, rows })}`);
  }
  zoom(d) { this.fontSize = Math.max(11, Math.min(28, this.fontSize + d * 2)); setPref('font', this.fontSize); if (this.term) { this.term.options.fontSize = this.fontSize; this.fit(true); } }

  /** The message box → the program: pasted as one block (line breaks included), then Enter. */
  sendMessage() {
    const text = this.input?.value.trim(); if (!text) { this.input?.focus(); return; }
    if (!this.info || this.info.running === false) return toast(`Start ${NAMES[this.program]} first`, 'info');
    const paste = this.term?.modes?.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' ');
    this.send(paste); setTimeout(() => this.send('\r'), 150);
    this.input.value = ''; this.input.focus();
  }
  insert(t) { if (!this.input) return this.send(t); const i = this.input; const a = i.selectionStart ?? i.value.length; i.value = `${i.value.slice(0, a)}${t}${i.value.slice(i.selectionEnd ?? a)}`; i.focus(); i.selectionStart = i.selectionEnd = a + t.length; }

  /** The open file (and the selected slides or lines) added to the message as the agent expects a file. */
  async addOpenFile() {
    const t = this.ws.activeTab(); if (!t?.path) return toast('Open a file in the editor first', 'info');
    let where = ''; try { const c = await t.context(); if (c?.slides?.length) where = ` (slide${c.slides.length > 1 ? 's' : ''} ${c.slides.join(', ')})`; else if (c?.lines) where = ` (lines ${c.lines[0]}-${c.lines[1]})`; else if (c?.paragraphs?.length) where = ` (paragraph${c.paragraphs.length > 1 ? 's' : ''} ${c.paragraphs.join(', ')})`; } catch { /* no selection */ }
    const ref = this.program === 'claude' ? `@${t.path}` : t.path;
    this.insert(`${ref}${where} `);
  }

  /** A request prepared elsewhere (Fix with agent, Draft targeted update): its files and text, typed but not sent. */
  async prefill({ text = '', chips = [] } = {}) {
    if (!this.info) { await this.start(); await new Promise(r => setTimeout(r, 2500)); }
    const refs = chips.map(c => (this.program === 'claude' ? `@${c.path}` : c.path)).join(' ');
    // one line: a line break would send the message before the instructor has read it
    this.insert(`${refs ? `${refs} ` : ''}${String(text).trim()}`);
  }

  async restart(quiet = false) {
    if (!quiet && this.info?.running && !(await confirmDialog({ title: `Start a new ${NAMES[this.program]} conversation?`, body: 'The current conversation ends. Changes it made stay in the course (and in History).', confirmLabel: 'Start new' }))) return;
    await this.close(); await this.start();
  }
  async close() {
    if (this.info) await api(`${this.base}/${this.info.id}`, { method: 'DELETE' }).catch(() => {});
    this.sock?.close(); this.sock = null; this.ro?.disconnect(); this.term?.dispose(); this.term = null; this.info = null; this.choiceKey = null;
  }

  renderChanged() {
    const list = [...this.changed.keys()];
    this.changedBox.hidden = !list.length;
    if (!list.length) return this.changedBox.replaceChildren();
    const open = this.changedBox.open;
    this.changedBox.replaceChildren(
      el('summary', {}, `Changed in this conversation (${list.length})`),
      el('ul', {}, ...list.map(p => el('li', {},
        el('button', { type: 'button', class: 'linkish', title: 'Open in the editor', onClick: () => this.ws.reveal(p) }, icon('file', 'sm'), p),
        el('span', { class: 'meta' }, this.changed.get(p).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))))),
      el('p', { class: 'meta' }, 'Each change is saved as a version. To undo one, open the file and use History.'));
    this.changedBox.open = open || list.length <= 6;
  }
  destroy() { this.off(); this.sock?.close(); this.ro?.disconnect(); this.term?.dispose(); }
}

/** The panel's top: large tabs for Claude Code, Codex and the built-in assistant. */
export class AgentDock {
  constructor(ws, makeBuiltin) {
    this.ws = ws; this.makeBuiltin = makeBuiltin; this.panes = {}; this.current = null;
    this.tabs = el('div', { class: 'dock-tabs', role: 'tablist', 'aria-label': 'Assistant' });
    this.body = el('div', { class: 'dock-body' });
    this.el = el('div', { class: 'dock' }, this.tabs, this.body);
    this.show(pref('tab', 'claude'));
  }
  get builtin() { return this.panes.builtin || (this.panes.builtin = this.makeBuiltin()); }
  show(id) {
    this.current = id; setPref('tab', id);
    this.tabs.replaceChildren(...[['claude', 'Claude Code'], ['codex', 'Codex'], ['builtin', 'Assistant']].map(([k, label]) =>
      el('button', { type: 'button', role: 'tab', class: 'dock-tab', 'aria-selected': String(k === id), title: k === 'builtin' ? 'The built-in assistant (your API model): small edits you review before they are saved' : `${label} on this computer`, onClick: () => this.show(k) }, label)));
    const pane = id === 'builtin' ? this.builtin : (this.panes[id] ||= new TerminalPane(this.ws, id));
    this.body.replaceChildren(pane.el);
    if (id !== 'builtin') pane.show(); else pane.refreshContext?.();
  }
  pane() { return this.current === 'builtin' ? this.builtin : this.panes[this.current]; }
  destroy() { for (const p of Object.values(this.panes)) p.destroy(); }
}
