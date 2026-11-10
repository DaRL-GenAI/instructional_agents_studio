// agents/login.mjs — signing in to Claude Code or Codex from the app. A turn runs the CLI without a terminal, so it
// cannot ask for a login itself. Here the CLI's own login command runs: it opens the browser and waits for the
// callback on localhost. One at a time; events: { type: 'agent-login', agent, status: started | ok | failed | stopped, error? }.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { HttpError } from '../projects.mjs';
import { available, agentEnv } from './cli.mjs';
import { SIGN_IN_COMMAND } from '../../js/agent/signin.js';

const TIMEOUT_MS = 5 * 60 * 1000;
export const LOGIN_ARGS = { claude: ['auth', 'login'], codex: ['login'] };
let current = null; // { agent, child, stopped }

export const state = () => (current ? { agent: current.agent } : null);

export function start(agent, emit, { spawnFn = spawn, bin, timeoutMs = TIMEOUT_MS } = {}) {
  if (!Object.hasOwn(LOGIN_ARGS, agent)) throw new HttpError(400, 'Unknown agent');
  if (current) { if (current.agent === agent) return state(); throw new HttpError(409, 'Another sign-in is in progress'); }
  const exe = bin || available()[agent]; if (!exe) throw new HttpError(400, `${agent} is not installed on this machine`);
  const child = spawnFn(exe, LOGIN_ARGS[agent], { cwd: os.homedir(), detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: agentEnv() });
  const me = current = { agent, child, stopped: null };
  const timer = setTimeout(() => cancel('Sign-in timed out'), timeoutMs);
  let output = '', finished = false;
  const keep = d => { output = (output + d).slice(-1000); };
  child.stdout?.on('data', keep); child.stderr?.on('data', keep);
  const finish = code => {
    if (finished) return; finished = true; clearTimeout(timer); if (current === me) current = null;
    if (me.stopped) return emit({ type: 'agent-login', agent, status: 'stopped', error: typeof me.stopped === 'string' ? me.stopped : undefined });
    if (code === 0) return emit({ type: 'agent-login', agent, status: 'ok' });
    const last = output.trim().split('\n').slice(-2).join(' ');
    emit({ type: 'agent-login', agent, status: 'failed', error: `Sign-in did not finish${last ? `: ${last}` : ''}. Try \`${SIGN_IN_COMMAND[agent]}\` in a terminal.` });
  };
  child.on('error', e => { output += e.message; finish(-1); });
  child.on('close', finish);
  emit({ type: 'agent-login', agent, status: 'started' });
  return state();
}

export function cancel(reason = true) {
  if (!current) return false;
  current.stopped = reason;
  try { process.kill(-current.child.pid, 'SIGTERM'); } catch { try { current.child.kill('SIGTERM'); } catch { /* gone */ } }
  return true;
}
