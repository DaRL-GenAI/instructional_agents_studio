#!/usr/bin/env node
// studio-bridge — lets Instructional Agents Studio hand a chapter deck to Claude Code or Codex on this machine.
// The browser posts the .pptx, the slide numbers and the instruction; the agent edits a copy in a throwaway job
// directory inside a bubblewrap sandbox (empty home, no access outside the job directory except its own config)
// and the edited file streams back. Studio checks the result and asks the user before keeping it.
//
//   node bridge/studio-bridge.mjs [--port 8794] [--origin https://studio.example] [--python /path/python3] [--print-token]
//
// Every request needs the token (Authorization: Bearer …) printed on start and kept in
// ~/.config/studio-bridge/config.json; only the listed origins may call it from a browser.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const HOME = os.homedir();
const CONFIG = path.join(HOME, '.config', 'studio-bridge', 'config.json');
const JOBS = path.join(HOME, '.cache', 'studio-bridge', 'jobs');
const DEFAULT_ORIGINS = ['http://127.0.0.1:8792', 'http://localhost:8792', 'https://darl-genai.github.io'];
const MAX_BODY = 80 * 1024 * 1024;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;

const argv = process.argv.slice(2);
const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(arg('--port') || 8794);

const config = (() => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } })();
config.token ||= crypto.randomBytes(24).toString('base64url');
config.origins = [...new Set([...(config.origins || DEFAULT_ORIGINS), ...argv.flatMap((a, i) => a === '--origin' ? [argv[i + 1].replace(/\/+$/, '')] : [])])];
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });

// Services start with a bare PATH; the agent CLIs usually install into ~/.local/bin.
process.env.PATH = [process.env.PATH, path.join(HOME, '.local', 'bin'), '/usr/local/bin'].filter(Boolean).join(':');
const hasPptx = py => py && spawnSync(py, ['-c', 'import pptx'], { stdio: 'ignore' }).status === 0;
// A Python with python-pptx: --python, then conda / venv installs in $HOME, then PATH.
const findPython = () => [arg('--python'), path.join(HOME, 'miniconda3', 'bin', 'python3'), path.join(HOME, 'anaconda3', 'bin', 'python3'), path.join(HOME, '.venv', 'bin', 'python3'), which('python3')].find(hasPptx) || which('python3');
const which = bin => { const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const BIN = { claude: which('claude'), codex: which('codex'), bwrap: which('bwrap'), python: findPython(), systemdRun: which('systemd-run') };

// ---------------------------------------------------------------- sandbox
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const under = (p, root) => p && (p === root || p.startsWith(root + path.sep));

const PY_PREFIX = BIN.python ? spawnSync(BIN.python, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' }).stdout.trim() : null;
// Only the credentials go in: the rest of ~/.claude and ~/.codex holds other sessions' transcripts.
const SECRETS = { claude: ['.claude/.credentials.json'], codex: ['.codex/auth.json', '.codex/config.toml'] };

/** bwrap argv: read-only system, an empty $HOME holding only the agent's credentials, and the job directory. */
function sandbox(agent, jobDir) {
  const binds = []; const dirs = new Set();
  const bind = (flag, p) => { const r = real(p); if (r) binds.push(flag, r, r); };
  for (const p of [real(BIN[agent]), PY_PREFIX]) if (under(p, HOME)) bind('--ro-bind', p);
  for (const rel of SECRETS[agent]) { const f = path.join(HOME, rel); if (!fs.existsSync(f)) continue; dirs.add(path.dirname(f)); binds.push('--bind', f, f); }
  return ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', HOME, ...[...dirs].flatMap(d => ['--dir', d]), ...binds,
    '--bind', jobDir, jobDir, '--chdir', jobDir, '--unshare-pid', '--die-with-parent', '--setenv', 'HOME', HOME, '--setenv', 'TMPDIR', '/tmp'];
}

function agentPrompt({ slides, instruction, chapter }, dir) {
  return `You are editing the lecture slide deck ${dir}/deck.pptx${chapter ? ` (chapter: ${chapter})` : ''}.
Task: ${instruction}
Slides in scope (1-based, current order): ${slides.join(', ')}.
- Change only the slides in scope. You may add, delete or reorder slides when the task calls for it; leave every other slide untouched.
- Keep the deck's design: reuse its layouts, fonts, colors and positions; keep text inside its boxes; update the speaker notes of slides whose content changes.
- Use python3 with python-pptx (installed). Save the result over ${dir}/deck.pptx.
- Finally write one sentence describing what you changed to ${dir}/summary.txt.
- Work only inside ${dir}. No network access is needed.`;
}

function agentCommand(agent, prompt, dir) {
  if (agent === 'claude') return [real(BIN.claude), '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash', '--disallowedTools', 'WebFetch,WebSearch'];
  // bwrap is the sandbox; Codex's own one cannot nest inside it.
  return [real(BIN.codex), 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', dir, prompt];
}

/** One line of agent output → a short progress line for the panel (or null). */
function progressOf(agent, line) {
  let j; try { j = JSON.parse(line); } catch { return null; }
  const clip = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (agent === 'claude') {
    if (j.type === 'assistant') for (const c of j.message?.content || []) {
      if (c.type === 'tool_use') return c.name === 'Bash' ? `$ ${clip(c.input?.description || c.input?.command)}` : `${c.name} ${clip(c.input?.file_path || c.input?.pattern || '')}`;
      if (c.type === 'text' && c.text.trim()) return clip(c.text);
    }
    if (j.type === 'result') return { result: j.result || '', error: j.is_error ? (j.result || j.subtype) : null };
    return null;
  }
  const item = j.item || j.msg || {};
  if (/item\.(started|completed)/.test(j.type || '')) {
    if (item.type === 'command_execution' && j.type === 'item.started') return `$ ${clip(item.command)}`;
    if (item.type === 'agent_message' && j.type === 'item.completed') return clip(item.text);
  }
  if (j.type === 'turn.failed' || j.type === 'error') return { error: clip(j.error?.message || j.message || 'Codex failed') };
  return null;
}

// ---------------------------------------------------------------- jobs
let current = null; // { id, unit, child, cancelled }

async function runJob(body, send) {
  const id = crypto.randomBytes(6).toString('hex'); const jobDir = path.join(JOBS, id);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const input = Buffer.from(body.pptx, 'base64'); fs.writeFileSync(path.join(jobDir, 'deck.pptx'), input);
  const unit = `exp-studio-agent-${id}`;
  const cmd = [BIN.bwrap, ...sandbox(body.agent, jobDir), ...agentCommand(body.agent, agentPrompt(body, jobDir), jobDir)];
  // A unit of its own in exp.slice: memory-capped, and stoppable as a whole on cancel.
  const full = BIN.systemdRun ? [BIN.systemdRun, '--user', '--quiet', '--collect', '--pipe', '--wait', `--unit=${unit}`, '--slice=exp.slice', '-p', 'MemoryMax=4G', '-p', 'MemorySwapMax=0', `--working-directory=${jobDir}`, '-E', `PATH=${[PY_PREFIX && path.join(PY_PREFIX, 'bin'), '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':')}`, ...cmd] : cmd;
  const child = spawn(full[0], full.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  current = { id, unit, child, cancelled: false };
  const timer = setTimeout(() => cancel('timed out after 15 minutes'), JOB_TIMEOUT_MS);
  send({ type: 'progress', text: `${body.agent === 'claude' ? 'Claude Code' : 'Codex'} started` });
  let buf = '', result = '', agentError = null, stderr = '';
  child.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const p = progressOf(body.agent, buf.slice(0, i)); buf = buf.slice(i + 1);
      if (typeof p === 'string') send({ type: 'progress', text: p });
      else if (p) { if (p.result) result = p.result; if (p.error) agentError = p.error; }
    }
  });
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const code = await new Promise(r => child.on('close', r));
  clearTimeout(timer);
  try {
    if (current.cancelled) return send({ type: 'error', message: `Stopped${typeof current.cancelled === 'string' ? `: ${current.cancelled}` : ''}.` });
    if (code !== 0 || agentError) return send({ type: 'error', message: agentError || `The agent exited with code ${code}. ${stderr.trim().split('\n').slice(-3).join(' ')}` });
    const out = fs.readFileSync(path.join(jobDir, 'deck.pptx'));
    if (out.equals(input)) return send({ type: 'error', message: result ? `No change to the deck. ${result.slice(0, 300)}` : 'The agent did not change the deck.' });
    let summary = ''; try { summary = fs.readFileSync(path.join(jobDir, 'summary.txt'), 'utf8').trim().slice(0, 600); } catch { summary = result.trim().slice(0, 600); }
    send({ type: 'done', summary, pptx: out.toString('base64') });
  } finally {
    current = null; fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

function cancel(reason = true) {
  if (!current) return false;
  current.cancelled = reason;
  if (BIN.systemdRun) spawnSync('systemctl', ['--user', 'stop', `${current.unit}.service`]); else current.child.kill('SIGTERM');
  return true;
}

// ---------------------------------------------------------------- http
const tokenOk = req => { const h = String(req.headers.authorization || ''); const a = Buffer.from(h), b = Buffer.from(`Bearer ${config.token}`); return a.length === b.length && crypto.timingSafeEqual(a, b); };

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const allowed = !origin || config.origins.includes(origin);
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin), res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    if (!allowed) { res.writeHead(403); return res.end(); }
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  if (!allowed) { console.warn(`refused origin ${origin} (add it with --origin)`); return json(403, { error: `Origin ${origin} is not allowed. Restart the bridge with --origin ${origin}` }); }
  if (!tokenOk(req)) return json(401, { error: 'Wrong or missing bridge token' });
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, version: 1, busy: !!current, agents: { claude: !!BIN.claude, codex: !!BIN.codex }, sandbox: !!BIN.bwrap });
  if (req.method === 'POST' && url.pathname === '/cancel') return json(200, { cancelled: cancel() });
  if (req.method !== 'POST' || url.pathname !== '/revise') return json(404, { error: 'Not found' });

  if (current) return json(409, { error: 'Another revision is running' });
  if (!BIN.bwrap) return json(500, { error: 'bubblewrap (bwrap) is required to sandbox the agent' });
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return json(413, { error: 'Deck too large' }); chunks.push(c); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'Bad JSON' }); }
  if (!['claude', 'codex'].includes(body.agent) || !BIN[body.agent]) return json(400, { error: `${body.agent} is not available on this machine` });
  if (!Array.isArray(body.slides) || !body.slides.length || !body.slides.every(n => Number.isInteger(n) && n > 0)) return json(400, { error: 'slides must be slide numbers' });
  if (typeof body.instruction !== 'string' || !body.instruction.trim() || typeof body.pptx !== 'string') return json(400, { error: 'instruction and pptx are required' });
  body.instruction = body.instruction.slice(0, 4000); body.chapter = String(body.chapter || '').slice(0, 200);

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const send = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
  res.on('close', () => { if (!res.writableFinished) cancel('the browser disconnected'); });
  try { await runJob(body, send); } catch (e) { send({ type: 'error', message: String(e.message || e) }); }
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`studio-bridge on http://127.0.0.1:${port}`);
  console.log(`agents: claude=${BIN.claude ? 'yes' : 'no'} codex=${BIN.codex ? 'yes' : 'no'} sandbox=${BIN.bwrap ? 'bwrap' : 'MISSING'} python-pptx=${hasPptx(BIN.python) ? BIN.python : 'MISSING'}`);
  console.log(`origins: ${config.origins.join(', ')}`);
  if (argv.includes('--print-token')) console.log(`token: ${config.token}`);
  else console.log(`token: in ${CONFIG}`);
});
