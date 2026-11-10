// agents/jobs.mjs — agent panel turns. Each chat has a job folder, .studio/jobs/s-<session>/: before every turn it
// becomes a fresh copy of the project (no .git, build/ or app scratch; sources/ and .studio/ read-only), the CLI
// agent runs there (the same folder every turn, so Claude Code's --resume finds its conversation), and afterwards
// the copy is compared with the snapshot taken at the start: that is the change list the instructor reviews.
// Nothing reaches the project until the browser applies the accepted changes (http.mjs → /agent/apply).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sha256, resolveInside, sourcesOf } from '../workspace.mjs';
import { available, panelCommand, panelPrompt, eventOf, agentEnv } from './cli.mjs';
import { needsSignIn } from '../../js/agent/signin.js';
import { GUIDE_FILES } from './guide.mjs';
import * as sessions from './sessions.mjs';

const JOB_TIMEOUT_MS = 20 * 60 * 1000;
// relative paths that are not copied (and not compared)
export const SKIP = /^(\.git|node_modules|build|\.scratch|\.studio\/(jobs|trash|backup|decks|sessions))(\/|$)|(^|\/)(__pycache__|\.DS_Store)(\/|$)|\.pyc$/;
export const READ_ONLY = /^(sources|\.studio)(\/|$)/;
const TEXT_EXT = /\.(md|markdown|txt|json|jsonl|ya?ml|tex|bib|sty|cls|csv|tsv|html?|css|m?js|py|sh|toml|xml|svg|gitignore)$/i;
export const isText = (p, buf) => (TEXT_EXT.test(p) || !/\.[^/]+$/.test(p)) && !(buf && buf.subarray(0, 8000).includes(0));

export const jobDir = (root, session) => path.join(root, '.studio', 'jobs', `s-${session}`);
const metaFile = (root, session) => path.join(root, '.studio', 'jobs', `s-${session}.json`);

/** Every file under dir (relative paths, no symlinks, SKIP applied): Map path → abs. Symlinks are listed in `links`. */
export function walk(dir, { links = [] } = {}) {
  const out = new Map();
  const rec = rel => {
    let ents; try { ents = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      const p = rel ? `${rel}/${d.name}` : d.name; if (SKIP.test(p)) continue;
      if (d.isSymbolicLink()) { links.push(p); continue; }
      if (d.isDirectory()) rec(p); else if (d.isFile()) out.set(p, path.join(dir, p));
    }
  };
  rec(''); return out;
}

function rmJob(dir) {
  if (!fs.existsSync(dir)) return;
  const fix = d => { try { fs.chmodSync(d, 0o755); } catch { /* gone */ } for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && !e.isSymbolicLink()) fix(p); else if (!e.isSymbolicLink()) try { fs.chmodSync(p, 0o644); } catch { /* gone */ } } };
  try { fix(dir); } catch { /* best effort */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Copy the project into dir. Returns the snapshot: { path: sha256 }. */
export function copyProject(root, dir) {
  rmJob(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = {}; const sources = sourcesOf(root);
  for (const [rel, abs] of walk(root)) {
    const buf = fs.readFileSync(abs); const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, buf);
    if (READ_ONLY.test(rel) || sources.has(rel)) fs.chmodSync(to, 0o444);
    base[rel] = sha256(buf);
  }
  return base;
}

/** Why a change to `rel` cannot be applied (or null). sources: the in-place source files (workspace.sourcesOf). */
export function rejectReason(rel, managed = new Set(), sources = new Set()) {
  if (/^sources(\/|$)/.test(rel)) return 'sources/ is read-only';
  if (sources.has(rel)) return 'source material is read-only';
  if (/^\.studio(\/|$)|^\.git(\/|$)/.test(rel)) return 'app files cannot be changed';
  if (GUIDE_FILES.includes(rel) && managed.has(rel)) return 'managed by the app';
  if (rel === 'course.json') return 'managed by the app';
  return null;
}

/** The job copy vs. its snapshot: [{ path, status: added|modified|deleted, text, sha, conflict, rejected }].
 *  conflict: the project file changed since the copy was made; managed: files the app owns (see files.managed). */
export function changes(root, dir, base, { managed = new Set(), sources = sourcesOf(root) } = {}) {
  const links = []; const now = walk(dir, { links }); const out = [];
  for (const [rel, abs] of now) {
    const buf = fs.readFileSync(abs); const sha = sha256(buf);
    if (base[rel] === sha) continue;
    out.push({ path: rel, status: rel in base ? 'modified' : 'added', sha, size: buf.length, text: isText(rel, buf) });
  }
  for (const rel of Object.keys(base)) if (!now.has(rel) && !links.includes(rel)) out.push({ path: rel, status: 'deleted', sha: null, text: isText(rel) });
  for (const rel of links) out.push({ path: rel, status: rel in base ? 'modified' : 'added', sha: null, text: false, rejected: 'symbolic links are not allowed' });
  for (const c of out) {
    c.rejected ||= rejectReason(c.path, managed, sources);
    let cur = null; try { cur = sha256(fs.readFileSync(resolveInside(root, c.path))); } catch { cur = null; }
    c.conflict = (base[c.path] || null) !== cur;
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- running a turn
const running = new Map(); // project id → { session, child, cancelled, scope }
export const runningOf = id => { const r = running.get(id); return r ? { session: r.session, agent: r.agent, scope: r.scope, startedAt: r.startedAt } : null; };

/** Start one turn of a CLI agent. emit(ev) gets { type: step | text | done | error, ... } as the agent works. */
export async function run({ id, root, session, message, context = [], scope = [], managed, emit, spawnFn = spawn, bin: binOverride }) {
  if (running.has(id)) throw Object.assign(new Error('An agent is already running in this project'), { status: 409 });
  const s = sessions.get(root, session);
  if (!['claude', 'codex'].includes(s.agent)) throw Object.assign(new Error('This chat uses the built-in agent'), { status: 400 });
  const bin = binOverride || available()[s.agent]; if (!bin) throw Object.assign(new Error(`${s.agent === 'claude' ? 'Claude Code' : 'Codex'} is not installed on this machine`), { status: 400 });
  const dir = jobDir(root, session);
  const r = { session, agent: s.agent, scope, child: null, cancelled: false, startedAt: new Date().toISOString() };
  running.set(id, r);
  let base;
  try { base = copyProject(root, dir); } catch (e) { running.delete(id); rmJob(dir); throw e; }
  fs.writeFileSync(metaFile(root, session), JSON.stringify({ base, startedAt: r.startedAt, agent: s.agent }));
  const resume = s.cli?.[s.agent] || null;
  sessions.update(root, session, x => { x.messages.push({ role: 'user', text: String(message).slice(0, 20000), context: context.slice(0, 20), at: r.startedAt }); });
  const cmd = panelCommand(s.agent, bin, panelPrompt({ message, context, resumed: !!resume }), dir, resume);
  // own process group (cancel stops everything it started); git must not climb out of the copy into the project's repository
  const child = r.child = spawnFn(cmd[0], cmd.slice(1), { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv({ GIT_CEILING_DIRECTORIES: path.dirname(dir) }) });
  const timer = setTimeout(() => cancel(id, 'timed out after 20 minutes'), JOB_TIMEOUT_MS);
  emit({ type: 'start', session, agent: s.agent, scope });
  const steps = []; let text = '', error = null, cliSession = null, buf = '', stderr = '';
  child.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = eventOf(s.agent, buf.slice(0, i)); buf = buf.slice(i + 1); if (!ev) continue;
      if (ev.session) cliSession = ev.session;
      if (ev.step) { steps.push(ev.step); if (steps.length > 300) steps.shift(); emit({ type: 'step', session, text: ev.step }); }
      if (ev.text) { text = ev.text; emit({ type: 'text', session, text }); }
      if (ev.error) error = ev.error;
    }
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const done = new Promise(res => { child.on('close', res); child.on('error', e => { stderr += e.message; res(-1); }); }).then(async code => {
    clearTimeout(timer); running.delete(id);
    let list = [];
    try { list = changes(root, dir, base, { managed: managed?.() }); } catch (e) { error ||= `Could not compare the copy: ${e.message}`; }
    const stopped = r.cancelled ? `Stopped${typeof r.cancelled === 'string' ? `: ${r.cancelled}` : ''}.` : null;
    if (!stopped && !error && code !== 0) error = `The agent exited with code ${code}. ${stderr.trim().split('\n').slice(-3).join(' ')}`.trim();
    const at = new Date().toISOString();
    const msg = { role: 'assistant', agent: s.agent, text: text || '', steps, at, error: stopped || error || undefined, changes: list.map(c => ({ path: c.path, status: c.status })) };
    // a turn that never reached the model is not a session to resume; an earlier good one stays
    if (needsSignIn(s.agent, error)) cliSession = null;
    sessions.update(root, session, x => { if (cliSession) x.cli = { ...(x.cli || {}), [s.agent]: cliSession }; x.messages.push(msg); });
    if (!list.length) { rmJob(dir); fs.rmSync(metaFile(root, session), { force: true }); }
    else fs.writeFileSync(metaFile(root, session), JSON.stringify({ base, startedAt: r.startedAt, finishedAt: at, agent: s.agent }));
    emit({ type: 'done', session, text, error: stopped || error, changes: list, cliSession });
  });
  return { session, agent: s.agent, done };
}

export function cancel(id, reason = true) {
  const r = running.get(id); if (!r?.child) return false;
  r.cancelled = reason;
  try { process.kill(-r.child.pid, 'SIGTERM'); } catch { try { r.child.kill('SIGTERM'); } catch { /* gone */ } }
  return true;
}
export function cancelAll(reason) { for (const id of running.keys()) cancel(id, reason); }

/** The pending changes of a chat's last turn (null when there is none). */
export function pending(root, session, opts) {
  let m; try { m = JSON.parse(fs.readFileSync(metaFile(root, session), 'utf8')); } catch { return null; }
  const dir = jobDir(root, session); if (!fs.existsSync(dir)) return null;
  return { startedAt: m.startedAt, finishedAt: m.finishedAt, agent: m.agent, changes: changes(root, dir, m.base, opts) };
}
/** A file of the job copy. */
export function readJobFile(root, session, rel) { return fs.readFileSync(resolveInside(jobDir(root, session), rel)); }
export function discard(root, session) { rmJob(jobDir(root, session)); fs.rmSync(metaFile(root, session), { force: true }); }
