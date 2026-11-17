// terminal.mjs — Claude Code and Codex as they are: their own interactive terminal (a PTY on this computer, in the
// course folder), shown in the browser with xterm.js over a WebSocket (/ws/term/<id>). Nothing is copied or wrapped:
// the agent reads and edits the course folder directly, asks its own permission questions, and the folder watcher
// (projects.mjs) turns what it changes into commits, as for any editor. A terminal outlives the page (reload, another
// tab) and keeps the last output so it can be shown again; it ends when its program exits or is closed.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { available, agentEnv } from './agents/cli.mjs';
import { command, isWin } from './platform.mjs';
import { HttpError } from './projects.mjs';

const SCROLLBACK = 400_000; // bytes of output kept for a page that (re)attaches
const MAX = 6;
// modes the replay must restore when their setting scrolled out of the kept output (full screen, mouse, paste, …)
const MODE_RE = /\x1bc|\x1b\[\?([\d;]+)([hl])/g;
const TRACKED = new Set(['1', '25', '47', '1000', '1002', '1003', '1004', '1005', '1006', '1015', '1047', '1049', '2004', '2031']);
export const PROGRAMS = { claude: 'Claude Code', codex: 'Codex', shell: 'Terminal' };

let pty = null, ptyError = null;
/** node-pty (an optional dependency with a native part): null, with the reason, when it could not be installed. */
export function loadPty() {
  if (pty || ptyError) return pty;
  const req = createRequire(import.meta.url);
  // node-pty's macOS builds start programs through a helper that npm can unpack without its execute bit
  if (process.platform === 'darwin') {
    try { const d = path.join(path.dirname(req.resolve('node-pty/package.json')), 'prebuilds'); for (const a of fs.readdirSync(d)) { const h = path.join(d, a, 'spawn-helper'); if (fs.existsSync(h)) fs.chmodSync(h, 0o755); } } catch { /* not installed, or not ours to change */ }
  }
  try { pty = req('node-pty'); } catch (e) { ptyError = e.message; }
  return pty;
}
export const unavailable = () => (loadPty() ? null : `The terminal component (node-pty) is not installed${ptyError ? `: ${ptyError.split('\n')[0]}` : ''}. Reinstall the app${process.platform === 'linux' ? ' (on Linux it needs a C++ compiler: sudo apt install build-essential python3)' : ''}.`);

const terms = new Map(); // id → Term

class Term {
  constructor({ project, dir, program, cols = 100, rows = 30 }) {
    this.id = crypto.randomBytes(6).toString('hex'); this.project = project; this.dir = dir; this.program = program;
    this.startedAt = new Date().toISOString(); this.clients = new Set(); this.buf = []; this.bytes = 0; this.truncated = false;
    this.modes = new Map(); this.title = PROGRAMS[program]; this.exit = null; this.size = [cols, rows];
    const env = { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' };
    delete env.NO_COLOR;
    let file, args;
    if (program === 'shell') { file = isWin ? (process.env.ComSpec || 'powershell.exe') : (process.env.SHELL || '/bin/bash'); args = []; }
    else {
      const bin = available()[program]; if (!bin) throw new HttpError(400, `${PROGRAMS[program]} is not installed on this computer. Install it, sign in once in a terminal, then try again.`);
      // Codex asks at start whether to update itself (a global npm install, which often needs an administrator): not here
      [file, args] = command(bin, program === 'codex' ? ['-c', 'check_for_update_on_startup=false'] : []);
    }
    this.proc = loadPty().spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: dir, env, useConpty: true });
    this.proc.onData(d => this.output(d));
    this.proc.onExit(({ exitCode }) => { this.exit = exitCode; this.output(`\r\n\x1b[2m[${PROGRAMS[program]} ended${exitCode ? ` with code ${exitCode}` : ''}. Close this tab or start a new one.]\x1b[0m\r\n`); this.send({ type: 'exit', code: exitCode }); });
  }
  output(d) {
    const s = String(d);
    for (const m of s.matchAll(MODE_RE)) { if (m[1] === undefined) { this.modes.clear(); continue; } for (const n of m[1].split(';')) if (TRACKED.has(n)) this.modes.set(n, m[2]); }
    const t = s.match(/\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/); if (t && t[1].trim()) this.title = t[1].trim().slice(0, 80);
    this.buf.push(s); this.bytes += s.length;
    while (this.bytes > SCROLLBACK && this.buf.length > 1) { this.bytes -= this.buf.shift().length; this.truncated = true; }
    for (const c of this.clients) if (c.readyState === 1) c.send(s);
  }
  send(obj) { const j = `\x00${JSON.stringify(obj)}`; for (const c of this.clients) if (c.readyState === 1) c.send(j); }
  attach(ws) {
    let backlog = this.buf.join('');
    if (this.truncated) backlog = [...this.modes].sort(([a]) => (a === '1049' ? -1 : 1)).map(([n, v]) => `\x1b[?${n}${v}`).join('') + backlog.slice(Math.max(backlog.indexOf('\x1b'), 0));
    if (backlog) ws.send(backlog);
    this.clients.add(ws);
    ws.on('message', (raw, isBinary) => {
      const s = raw.toString('utf8');
      if (!isBinary && s.startsWith('\x00')) { let m; try { m = JSON.parse(s.slice(1)); } catch { return; } if (m.type === 'resize') this.resize(m.cols, m.rows); return; }
      if (this.exit === null) this.proc.write(s);
    });
    ws.on('close', () => this.clients.delete(ws));
    // the program redraws its whole screen when the size changes: a page that attaches gets a fresh picture
    this.repaint();
  }
  resize(cols, rows) {
    cols = Math.max(20, Math.min(Number(cols) || 100, 500)); rows = Math.max(5, Math.min(Number(rows) || 30, 300));
    this.size = [cols, rows]; if (this.exit === null) try { this.proc.resize(cols, rows); } catch { /* exited */ }
  }
  repaint() {
    if (this.exit !== null) return; const [c, r] = this.size;
    try { this.proc.resize(c, r > 5 ? r - 1 : r + 1); setTimeout(() => { try { this.proc.resize(c, r); } catch { /* exited */ } }, 120); } catch { /* exited */ }
  }
  info() { return { id: this.id, program: this.program, name: PROGRAMS[this.program], title: this.title, startedAt: this.startedAt, running: this.exit === null }; }
  close() { try { this.proc.kill(); } catch { /* gone */ } for (const c of this.clients) try { c.close(); } catch { /* gone */ } terms.delete(this.id); }
}

export function list(project) { return [...terms.values()].filter(t => t.project === project).map(t => t.info()); }
export function open({ project, dir, program, cols, rows }) {
  if (!Object.hasOwn(PROGRAMS, program)) throw new HttpError(400, 'Unknown program');
  const why = unavailable(); if (why) throw new HttpError(501, why);
  if (terms.size >= MAX) throw new HttpError(409, `At most ${MAX} terminals can be open. Close one first.`);
  const t = new Term({ project, dir, program, cols, rows }); terms.set(t.id, t); return t.info();
}
export const get = id => terms.get(id) || null;
export function close(id) { const t = terms.get(id); if (!t) return false; t.close(); return true; }
export function closeAll() { for (const t of [...terms.values()]) t.close(); }
export const home = () => os.homedir();
