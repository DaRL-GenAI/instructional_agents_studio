// agents/runner.mjs — one agent job at a time. The deck is copied into <project>/.studio/jobs/<id>/ (ignored by git
// and by the watcher), the agent runs with the project folder as its working directory, and the edited copy streams
// back as NDJSON events: { type: progress | error | done }.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { available, agentCommand, progressOf, revisePrompt, searchPath } from './cli.mjs';

const JOB_TIMEOUT_MS = 15 * 60 * 1000;
let current = null; // { id, child, cancelled }

export const busy = () => !!current;
export const health = () => { const a = available(); return { ok: true, version: 2, busy: busy(), agents: { claude: !!a.claude, codex: !!a.codex } }; };

/** Validate a revise request body; returns an error message or null. */
export function checkRevise(body) {
  const a = available();
  if (!['claude', 'codex'].includes(body?.agent) || !a[body.agent]) return `${body?.agent} is not installed on this machine`;
  if (!Array.isArray(body.slides) || !body.slides.length || !body.slides.every(n => Number.isInteger(n) && n > 0)) return 'slides must be slide numbers';
  if (typeof body.instruction !== 'string' || !body.instruction.trim() || typeof body.pptx !== 'string') return 'instruction and pptx are required';
  return null;
}

export async function revise(root, body, send, { spawnFn = spawn } = {}) {
  if (current) return send({ type: 'error', message: 'Another revision is running' });
  const id = crypto.randomBytes(6).toString('hex'); const rel = `.studio/jobs/${id}/deck.pptx`; const jobDir = path.join(root, '.studio', 'jobs', id);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const input = Buffer.from(body.pptx, 'base64'); fs.writeFileSync(path.join(jobDir, 'deck.pptx'), input);
  const bin = available()[body.agent];
  const cmd = agentCommand(body.agent, bin, revisePrompt({ slides: body.slides, instruction: body.instruction.slice(0, 4000), chapter: String(body.chapter || '').slice(0, 200) }, rel), root);
  // own process group, so cancel stops the agent and everything it started
  const child = spawnFn(cmd[0], cmd.slice(1), { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: searchPath() } });
  current = { id, child, cancelled: false };
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
  const code = await new Promise(r => { child.on('close', r); child.on('error', e => { stderr += e.message; r(-1); }); });
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

export function cancel(reason = true) {
  if (!current) return false;
  current.cancelled = reason;
  try { process.kill(-current.child.pid, 'SIGTERM'); } catch { try { current.child.kill('SIGTERM'); } catch { /* gone */ } }
  return true;
}
