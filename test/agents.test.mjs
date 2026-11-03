// Agent runner: the exact command lines, and one revision job end to end with a stand-in agent process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from './helpers.mjs';
import { agentCommand, progressOf } from '../server/agents/cli.mjs';
import * as runner from '../server/agents/runner.mjs';

test('Claude Code and Codex command lines stay inside the project folder', () => {
  const c = agentCommand('claude', 'claude', 'do it', '/p');
  assert.deepEqual(c.slice(0, 3), ['claude', '-p', 'do it']);
  for (const [k, v] of [['--output-format', 'stream-json'], ['--permission-mode', 'acceptEdits'], ['--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash'], ['--disallowedTools', 'WebFetch,WebSearch']]) assert.equal(c[c.indexOf(k) + 1], v, k);
  assert.ok(c.includes('--verbose'));
  const x = agentCommand('codex', 'codex', 'do it', '/p');
  assert.deepEqual(x, ['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', '/p', 'do it']);
});

test('progress lines from both event streams', () => {
  assert.equal(progressOf('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'unzip deck.pptx' } }] } })), '$ unzip deck.pptx');
  assert.deepEqual(progressOf('claude', JSON.stringify({ type: 'result', result: 'ok', is_error: false })), { result: 'ok', error: null });
  assert.equal(progressOf('codex', JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } })), '$ ls');
  assert.deepEqual(progressOf('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'no' } })), { error: 'no' });
  assert.equal(progressOf('claude', 'not json'), null);
});

// a stand-in for the agent: edits the job's deck copy named in the prompt and reports like Claude Code
const FAKE = `const p = process.argv.find(a => a.includes('.studio/jobs/')); const rel = p.match(/(\\.studio\\/jobs\\/[0-9a-f]+\\/deck\\.pptx)/)[1];
const fs = require('fs'); if (!process.env.FAKE_NOOP) { fs.appendFileSync(rel, 'EDITED'); fs.writeFileSync(rel.replace('deck.pptx', 'summary.txt'), 'Changed slide 2.'); }
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'editing' }] } })); console.log(JSON.stringify({ type: 'result', result: 'done', is_error: false }));`;
const fakeSpawn = env => (bin, args, opts) => spawn(process.execPath, ['-e', FAKE, '--', ...args], { ...opts, env: { ...opts.env, ...env } });

test('a revision job: deck copy under .studio/jobs, agent runs in the project folder, edited deck streams back', async () => {
  const root = tmpdir(); const events = [];
  const deck = Buffer.from('PK-fake-deck');
  let cwd; const spawnFn = (b, a, o) => { cwd = o.cwd; return fakeSpawn({})(b, a, o); };
  await runner.revise(root, { agent: 'claude', slides: [2], instruction: 'shorter', chapter: 'Ch', pptx: deck.toString('base64') }, e => events.push(e), { spawnFn });
  assert.equal(cwd, root);
  const done = events.find(e => e.type === 'done'); assert.ok(done, JSON.stringify(events));
  assert.equal(Buffer.from(done.pptx, 'base64').toString(), 'PK-fake-deckEDITED'); assert.equal(done.summary, 'Changed slide 2.');
  assert.ok(events.some(e => e.type === 'progress' && e.text === 'editing'));
  assert.deepEqual(fs.readdirSync(path.join(root, '.studio/jobs')), [], 'the job copy is removed');
  assert.equal(runner.busy(), false);
});

test('an agent that changes nothing is an error, not a new version', async () => {
  const root = tmpdir(); const events = [];
  await runner.revise(root, { agent: 'codex', slides: [1], instruction: 'x', pptx: Buffer.from('PK').toString('base64') }, e => events.push(e), { spawnFn: fakeSpawn({ FAKE_NOOP: '1' }) });
  assert.equal(events.at(-1).type, 'error'); assert.match(events.at(-1).message, /No change|did not change/);
});

test('revise requests are validated', () => {
  assert.match(runner.checkRevise({ agent: 'bash' }), /not installed/);
  const ok = runner.health(); assert.equal(typeof ok.agents.claude, 'boolean');
});
