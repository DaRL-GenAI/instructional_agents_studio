// The agent panel: chats on disk, the job copy and what changed in it, hunks, path protection, AGENTS.md, undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir, isolateConfig, sampleProject } from './helpers.mjs';
import { diffLines, applyHunks, hunkRows } from '../js/diff.js';

isolateConfig();
const sessions = await import('../server/agents/sessions.mjs');
const jobs = await import('../server/agents/jobs.mjs');
const { panelCommand, eventOf, panelPrompt } = await import('../server/agents/cli.mjs');
const { MARK } = await import('../server/agents/guide.mjs');
const { Projects } = await import('../server/projects.mjs');
const { startServer } = await import('../server/http.mjs');
const vcs = await import('../server/vcs.mjs');

test('chats are kept per project in .studio/sessions and listed newest first', () => {
  const root = tmpdir();
  const a = sessions.create(root, { agent: 'claude' }); const b = sessions.create(root, { agent: 'builtin' });
  assert.ok(fs.existsSync(path.join(root, '.studio/sessions', `${a.id}.json`)));
  sessions.update(root, a.id, s => { s.messages.push({ role: 'user', text: 'Shorten slide 2', at: 'x' }); s.cli = { claude: 'abc' }; });
  const got = sessions.get(root, a.id); assert.equal(got.title, 'Shorten slide 2'); assert.equal(got.cli.claude, 'abc');
  assert.deepEqual(sessions.list(root).map(x => x.id), [a.id, b.id]);
  sessions.put(root, b.id, { messages: [{ role: 'user', text: 'hi' }, { role: 'system', text: 'nope' }] });
  assert.equal(sessions.get(root, b.id).messages.length, 1);
  assert.throws(() => sessions.get(root, '../../etc'), /Bad session id/);
  assert.throws(() => sessions.create(root, { agent: 'bash' }), /Unknown agent/);
  sessions.remove(root, b.id); assert.equal(sessions.list(root).length, 1);
});

test('hunks: each run of changed lines can be accepted on its own', () => {
  const a = 'one\ntwo\nthree\nfour\nfive\n', b = 'one\nTWO\nthree\nfour\nfive\nsix\n';
  const h = diffLines(a, b); assert.equal(h.length, 2);
  assert.deepEqual([h[0].a, h[0].del, h[0].add], [1, ['two'], ['TWO']]);
  assert.equal(applyHunks(a, h), b);
  assert.equal(applyHunks(a, h, new Set([0])), 'one\nTWO\nthree\nfour\nfive\n');
  assert.equal(applyHunks(a, h, new Set([1])), 'one\ntwo\nthree\nfour\nfive\nsix\n');
  assert.equal(applyHunks(a, h, new Set()), a);
  assert.deepEqual(hunkRows(a, h[0], 1).map(r => r.kind + r.text), [' one', '-two', '+TWO', ' three']);
  assert.deepEqual(diffLines('same', 'same'), []);
  const big = Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n'); const big2 = big.replace('l10\n', 'L10\n').replace('l2990', 'L2990');
  assert.equal(applyHunks(big, diffLines(big, big2)), big2);
});

function project() {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'chapters/01'), { recursive: true }); fs.mkdirSync(path.join(root, 'sources'), { recursive: true }); fs.mkdirSync(path.join(root, 'build'), { recursive: true }); fs.mkdirSync(path.join(root, '.studio/jobs/old'), { recursive: true });
  fs.writeFileSync(path.join(root, 'chapters/01/homework.md'), '# HW\n\n1. a\n'); fs.writeFileSync(path.join(root, 'notes.md'), 'n\n');
  fs.writeFileSync(path.join(root, 'sources/syllabus.pdf'), 'PDF'); fs.writeFileSync(path.join(root, 'build/video.mp4'), 'big');
  fs.writeFileSync(path.join(root, '.studio/meta.json'), '{}'); fs.writeFileSync(path.join(root, '.studio/jobs/old/x'), 'x');
  fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref');
  return root;
}

test('the job copy leaves out git, build and scratch; sources/ is read-only; changes are detected and checked', () => {
  const root = project(); const dir = jobs.jobDir(root, 'abc123');
  const base = jobs.copyProject(root, dir);
  assert.deepEqual(Object.keys(base).sort(), ['.studio/meta.json', 'chapters/01/homework.md', 'notes.md', 'sources/syllabus.pdf']);
  assert.throws(() => fs.writeFileSync(path.join(dir, 'sources/syllabus.pdf'), 'changed'), /EACCES|EPERM/);
  // the agent edits, adds, deletes, writes scratch, replaces a source, links out
  fs.writeFileSync(path.join(dir, 'chapters/01/homework.md'), '# HW\n\n1. a\n2. b\n');
  fs.writeFileSync(path.join(dir, 'chapters/01/lab.md'), '# Lab\n'); fs.rmSync(path.join(dir, 'notes.md'));
  fs.mkdirSync(path.join(dir, '.scratch')); fs.writeFileSync(path.join(dir, '.scratch/tmp.txt'), 't');
  fs.rmSync(path.join(dir, 'sources/syllabus.pdf'), { force: true }); fs.writeFileSync(path.join(dir, 'sources/syllabus.pdf'), 'evil');
  fs.symlinkSync('/etc/passwd', path.join(dir, 'passwd'));
  // meanwhile the instructor edits the same homework in the project
  fs.writeFileSync(path.join(root, 'chapters/01/homework.md'), '# HW!\n\n1. a\n');
  const ch = jobs.changes(root, dir, base);
  const by = Object.fromEntries(ch.map(c => [c.path, c]));
  assert.deepEqual(Object.keys(by).sort(), ['chapters/01/homework.md', 'chapters/01/lab.md', 'notes.md', 'passwd', 'sources/syllabus.pdf']);
  assert.equal(by['chapters/01/homework.md'].status, 'modified'); assert.equal(by['chapters/01/homework.md'].conflict, true);
  assert.equal(by['chapters/01/lab.md'].status, 'added'); assert.equal(by['chapters/01/lab.md'].conflict, false); assert.equal(by['chapters/01/lab.md'].text, true);
  assert.equal(by['notes.md'].status, 'deleted');
  assert.match(by['sources/syllabus.pdf'].rejected, /read-only/); assert.match(by.passwd.rejected, /symbolic/);
  assert.equal(jobs.rejectReason('.studio/meta.json'), 'app files cannot be changed');
  assert.equal(jobs.rejectReason('AGENTS.md', new Set(['AGENTS.md'])), 'managed by the app'); assert.equal(jobs.rejectReason('AGENTS.md'), null);
  jobs.discard(root, 'abc123'); assert.equal(fs.existsSync(dir), false);
});

test('panel command lines: resume for Claude Code and Codex; events carry the CLI session', () => {
  const c = panelCommand('claude', 'claude', 'p', '/j', 'sess-1');
  assert.deepEqual(c.slice(-2), ['--resume', 'sess-1']); assert.equal(c[c.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.deepEqual(panelCommand('codex', 'codex', 'p', '/j'), ['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', '/j', 'p']);
  assert.deepEqual(panelCommand('codex', 'codex', 'p', '/j', 't-1'), ['codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', 't-1', 'p']);
  assert.equal(eventOf('claude', JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })).session, 's1');
  assert.deepEqual(eventOf('claude', JSON.stringify({ type: 'result', result: 'Done.', is_error: false, session_id: 's1' })), { session: 's1', final: true, text: 'Done.' });
  assert.equal(eventOf('codex', JSON.stringify({ type: 'thread.started', thread_id: 't1' })).session, 't1');
  assert.equal(eventOf('codex', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })).text, 'ok');
  assert.match(panelPrompt({ message: 'Fix', context: [{ path: 'a.pptx', slides: [2] }] }), /a\.pptx \(slide 2\)[\s\S]*AGENTS\.md/);
  assert.doesNotMatch(panelPrompt({ message: 'Fix', resumed: true }), /AGENTS\.md/);
});

// a stand-in for Claude Code: edits files in its cwd, reports a session id, and shows the argv it got
const FAKE = `const fs = require('fs'); const args = process.argv.slice(2);
fs.writeFileSync('chapters/01/homework.md', fs.readFileSync('chapters/01/homework.md', 'utf8') + '2. added by the agent\\n');
try { fs.writeFileSync('sources/syllabus.pdf', 'x'); } catch (e) { /* read-only */ }
const out = o => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'cli-' + (args.includes('--resume') ? 'two' : 'one') });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'chapters/01/homework.md' } }] } });
out({ type: 'result', result: 'Added question 2. argv=' + args.filter(a => a.startsWith('--resume') || a.startsWith('cli-')).join(' '), is_error: false, session_id: 'cli-x' });`;
const fakeSpawn = (bin, args, opts) => spawn(process.execPath, ['-e', FAKE, '--', ...args], opts);

test('a panel turn: copy, run, change list; the next turn resumes the CLI session', async () => {
  const root = project(); const s = sessions.create(root, { agent: 'claude' }); const events = [];
  const r = await jobs.run({ id: 'p1', root, session: s.id, message: 'Add a question', context: [{ path: 'chapters/01/homework.md' }], emit: e => events.push(e), spawnFn: fakeSpawn, bin: 'claude' });
  assert.deepEqual(jobs.runningOf('p1').scope, []);
  await r.done;
  const done = events.find(e => e.type === 'done'); assert.ok(done, JSON.stringify(events));
  assert.deepEqual(done.changes.map(c => c.path), ['chapters/01/homework.md']); assert.equal(done.error, null);
  assert.ok(events.some(e => e.type === 'step' && /Edit chapters/.test(e.text)));
  assert.equal(fs.readFileSync(path.join(root, 'chapters/01/homework.md'), 'utf8'), '# HW\n\n1. a\n', 'the project itself is untouched');
  const got = sessions.get(root, s.id); assert.equal(got.cli.claude, 'cli-x'); assert.equal(got.messages.length, 2);
  assert.match(jobs.readJobFile(root, s.id, 'chapters/01/homework.md').toString(), /added by the agent/);
  assert.equal(jobs.pending(root, s.id).changes.length, 1);
  const r2 = await jobs.run({ id: 'p1', root, session: s.id, message: 'again', emit: e => events.push(e), spawnFn: fakeSpawn, bin: 'claude' }); await r2.done;
  assert.match(events.filter(e => e.type === 'done').at(-1).text, /argv=--resume cli-x/);
  jobs.discard(root, s.id); assert.equal(jobs.pending(root, s.id), null);
});

test('AGENTS.md and CLAUDE.md: written with the project, kept up to date, never over the user’s own file', async () => {
  const projects = new Projects({ watch: false }); const dir = path.join(tmpdir(), 'course');
  const r = await projects.create(sampleProject(), dir);
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith(MARK)); assert.match(agents, /\| `design\/syllabus\.md` \| Course design: /); assert.match(agents, /sources\/` is read-only/);
  assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /^@AGENTS\.md$/m);
  assert.match(await vcs.readAt(dir, r.head, 'AGENTS.md').then(String), /Files that back stages/, 'committed');
  const p = r.project; p.chapters.push({ id: 'chccc3333', title: 'Planning', description: '', stages: { homework: { status: 'done', output: '# HW', version: 1, history: [] } } });
  await projects.save(p.id, p, r.head);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /03-planning\/homework\.md/);
  const files = await import('../server/files.mjs'); assert.ok(files.managed(dir).has('AGENTS.md'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# my own notes\n');
  p.chapters.pop(); await projects.save(p.id, p);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# my own notes\n'); assert.ok(!files.managed(dir).has('CLAUDE.md'));
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /03-planning/);
});

test('apply: plain files and the project in one agent commit; sources/ and paths outside are refused; undo reverts it', async () => {
  const dir = tmpdir(); const app = await startServer({ dir: path.join(dir, 'course'), port: 0, editorDir: null, watch: false, quiet: true });
  try {
    const call = async (method, p, body) => { const r = await fetch(`${app.origin}${p}`, { method, headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, json: r.status === 204 ? null : await r.json() }; };
    const created = (await call('POST', '/api/projects', { project: sampleProject() })).json; const id = created.project.id; const root = created.dir;
    const P = `/api/projects/${id}/agent`;
    assert.equal((await call('GET', P)).status, 200);
    const s = (await call('POST', `${P}/sessions`, { agent: 'builtin' })).json; assert.ok(s.id);
    const b64 = t => Buffer.from(t).toString('base64');
    for (const bad of ['sources/a.md', '../escape.md', '.studio/meta.json', '/etc/passwd', 'course.json', 'design/syllabus.md']) {
      const r = await call('POST', `${P}/apply`, { files: [{ path: bad, data: b64('x') }], message: 'agent: x' });
      assert.ok([400, 403, 409].includes(r.status), `${bad}: ${r.status}`);
    }
    const p = created.project; p.foundation.syllabus.output = 'Week 1: agents (revised)'; p.foundation.syllabus.version++;
    const ok = await call('POST', `${P}/apply`, { project: p, base: created.head, files: [{ path: 'notes/agent.md', data: b64('# Notes\n') }], message: 'agent: notes/agent.md, design/syllabus.md', session: s.id });
    assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.ok(ok.json.commit);
    const log = await vcs.log(root, 2); assert.equal(log[0].message, 'agent: notes/agent.md, design/syllabus.md');
    const changed = (await vcs.changedPaths(root, ok.json.commit)).paths; for (const f of ['notes/agent.md', 'design/syllabus.md', '.studio/meta.json']) assert.ok(changed.includes(f), f);
    const undo = await call('POST', `${P}/undo`, { oid: ok.json.commit });
    assert.equal(undo.status, 200, JSON.stringify(undo.json));
    assert.equal(fs.existsSync(path.join(root, 'notes/agent.md')), false); assert.equal(fs.readFileSync(path.join(root, 'design/syllabus.md'), 'utf8'), 'Week 1: agents\nWeek 2: tools');
    assert.match((await vcs.log(root, 1))[0].message, /^agent: undo /);
    assert.equal((await call('POST', `${P}/undo`, { oid: created.head })).status, 400, 'only agent commits');
  } finally { await app.close(); }
});
