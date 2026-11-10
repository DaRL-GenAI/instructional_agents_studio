// Signing in to the coding agents: which failures need it, the login process, and what reaches the CLI's environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir, isolateConfig } from './helpers.mjs';
import { needsSignIn } from '../js/agent/signin.js';
import { agentEnv, eventOf, progressOf } from '../server/agents/cli.mjs';
import * as login from '../server/agents/login.mjs';
import * as jobs from '../server/agents/jobs.mjs';
import * as sessions from '../server/agents/sessions.mjs';
import { startServer } from '../server/http.mjs';

const script = code => (bin, args, opts) => spawn(process.execPath, ['-e', code], opts);
const waitFor = (events, status) => new Promise(res => { const t = setInterval(() => { const e = events.find(x => x.status === status); if (e) { clearInterval(t); res(e); } }, 5); });

test('the sign-in failures the CLIs really print are recognised, others are not', () => {
  for (const m of ['Failed to authenticate: OAuth session expired and could not be refreshed', 'Not logged in · Please run /login']) assert.ok(needsSignIn('claude', m), m);
  for (const m of ['Your access token could not be refreshed. Please log out and sign in again.', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header']) assert.ok(needsSignIn('codex', m), m);
  for (const m of ['Invalid API key · Fix external API key', 'Stopped.', 'The agent exited with code 1.', '', undefined]) assert.equal(needsSignIn('claude', m), false, String(m));
  assert.equal(needsSignIn('builtin', 'Failed to authenticate'), false);
});

test('an API key in the environment reaches Claude Code only when chosen', () => {
  process.env.ANTHROPIC_API_KEY = 'stale'; process.env.ANTHROPIC_AUTH_TOKEN = 'stale';
  try {
    const off = agentEnv({ X: '1' }, false); assert.equal(off.ANTHROPIC_API_KEY, undefined); assert.equal(off.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(off.X, '1');
    assert.equal(agentEnv({}, true).ANTHROPIC_API_KEY, 'stale');
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; }
});

test('Codex reconnect attempts are progress, the final failure is the error', () => {
  const retry = JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (unexpected status 401 Unauthorized)' });
  assert.match(progressOf('codex', retry), /^Reconnecting/);
  assert.equal(eventOf('codex', retry).error, undefined);
  assert.match(eventOf('codex', JSON.stringify({ type: 'error', message: 'unexpected status 401 Unauthorized' })).error, /401/);
});

test('sign-in: success, failure, one at a time, cancel, timeout', async () => {
  let ev = []; let args;
  login.start('claude', e => ev.push(e), { bin: 'claude', spawnFn: (b, a, o) => { args = a; return script('process.exit(0)')(b, a, o); } });
  assert.deepEqual(args, ['auth', 'login']); assert.deepEqual(login.state(), { agent: 'claude' });
  await waitFor(ev, 'ok'); assert.equal(login.state(), null); assert.equal(ev[0].status, 'started');

  ev = []; login.start('codex', e => ev.push(e), { bin: 'codex', spawnFn: script('console.error("port 1455 in use"); process.exit(1)') });
  const failed = await waitFor(ev, 'failed'); assert.match(failed.error, /port 1455 in use/); assert.match(failed.error, /codex login/);

  ev = []; const wait = script('setTimeout(() => {}, 60000)');
  login.start('claude', e => ev.push(e), { bin: 'claude', spawnFn: wait });
  assert.deepEqual(login.start('claude', () => {}, { bin: 'claude', spawnFn: wait }), { agent: 'claude' }, 'the same sign-in is not started twice');
  assert.throws(() => login.start('codex', () => {}, { bin: 'codex', spawnFn: wait }), /in progress/);
  assert.equal(login.cancel(), true); const stopped = await waitFor(ev, 'stopped'); assert.equal(stopped.error, undefined);

  ev = []; login.start('codex', e => ev.push(e), { bin: 'codex', spawnFn: wait, timeoutMs: 20 });
  assert.match((await waitFor(ev, 'stopped')).error, /timed out/);
  assert.throws(() => login.start('bash', () => {}), /Unknown agent/);
});

test('a turn that failed at sign-in leaves no session to resume, and keeps an earlier one', async () => {
  isolateConfig(); const root = tmpdir(); const s = sessions.create(root, { agent: 'claude' });
  const FAIL = `console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'dead' })); console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed', session_id: 'dead' }));`;
  const turn = async () => { const r = await jobs.run({ id: 'signin', root, session: s.id, message: 'hi', emit: () => {}, spawnFn: script(FAIL), bin: 'claude' }); await r.done; return sessions.get(root, s.id); };
  let got = await turn();
  assert.match(got.messages.at(-1).error, /OAuth session expired/); assert.equal(got.cli.claude, undefined);
  sessions.update(root, s.id, x => { x.cli = { claude: 'good' }; });
  got = await turn(); assert.equal(got.cli.claude, 'good');
});

test('the sign-in route needs the page on this computer and a known agent', async () => {
  isolateConfig(); const app = await startServer({ port: 0, token: 't', editorDir: null, watch: false, quiet: true, allowHosts: ['demo.example.ms'] });
  try {
    const post = (host, body) => new Promise((res, rej) => import('node:http').then(({ default: http }) => { const r = http.request({ port: app.port, host: '127.0.0.1', path: '/api/agents/login', method: 'POST', headers: { host, authorization: 'Bearer t', 'content-type': 'application/json' } }, x => { let d = ''; x.on('data', c => d += c); x.on('end', () => res({ status: x.statusCode, body: JSON.parse(d) })); }); r.on('error', rej); r.end(JSON.stringify(body)); }));
    const remote = await post('demo.example.ms', { agent: 'claude' }); assert.equal(remote.status, 400); assert.match(remote.body.error, /terminal/);
    assert.equal((await post(`127.0.0.1:${app.port}`, { agent: 'nope' })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/agents/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"agent":"claude"}' })).status, 401);
  } finally { await app.close(); }
});
