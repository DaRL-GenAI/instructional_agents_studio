// Any folder opens as a course: empty folders, folders with files (kept in place, recorded as sources, read-only for
// agents), folders that are git repositories already, and the folders that are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir, isolateConfig } from './helpers.mjs';
import { newProject } from '../js/model.js';

isolateConfig();
const { Projects } = await import('../server/projects.mjs');
const folders = await import('../server/folders.mjs');
const vcs = await import('../server/vcs.mjs');
const jobs = await import('../server/agents/jobs.mjs');
const { sourcesOf } = await import('../server/workspace.mjs');
const { startServer } = await import('../server/http.mjs');

const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const put = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
const course = name => newProject({ course: { name } });
const hashes = dir => Object.fromEntries(['notes.md', 'lectures/week1.md', 'lectures/week2.txt', '.hidden'].filter(f => fs.existsSync(path.join(dir, f))).map(f => [f, hash(path.join(dir, f))]));

test('an empty folder becomes a course (a new repository with one commit)', async () => {
  const dir = path.join(tmpdir(), 'Empty Course'); fs.mkdirSync(dir); put(dir, '.DS_Store', 'x');
  const info = folders.inspect(dir);
  assert.equal(info.empty, true); assert.equal(info.name, 'Empty Course'); assert.equal(info.git, false);
  const projects = new Projects({ watch: false });
  const r = await projects.adopt(course('Empty Course'), dir);
  assert.equal(r.repo, 'new'); assert.deepEqual(r.files, []);
  assert.ok(fs.existsSync(path.join(dir, '.studio/meta.json')));
  const log = await vcs.log(dir); assert.equal(log.length, 1); assert.match(log[0].message, /^init: Empty Course/);
  assert.equal(r.project.repo, undefined);
  // a nonexistent folder (instructional-agents <new dir>) is an empty one
  const fresh = path.join(tmpdir(), 'not-yet');
  assert.equal(folders.inspect(fresh).exists, false);
  assert.equal((await projects.adopt(course('Fresh'), fresh)).repo, 'new');
});

test('a folder with files: course in place, nothing copied, first commit holds the files as they are', async () => {
  const dir = path.join(tmpdir(), 'ml-course');
  put(dir, 'notes.md', '# Notes\n'); put(dir, 'lectures/week1.md', '# Week 1\n- agents\n'); put(dir, 'lectures/week2.txt', 'week two');
  put(dir, '.hidden', 'h'); put(dir, 'node_modules/pkg/index.js', 'x'); put(dir, '.venv/lib/site.py', 'x');
  fs.symlinkSync('/usr/share', path.join(dir, 'link'));
  const before = hashes(dir);
  const info = folders.inspect(dir);
  assert.equal(info.empty, false); assert.equal(info.count, 3); assert.deepEqual(info.kinds, [['Text', 3]]); assert.deepEqual(info.top, ['lectures', 'notes.md']);
  const projects = new Projects({ watch: false });
  const r = await projects.adopt(course('ML'), dir);
  assert.deepEqual(r.files.map(f => f.path), ['lectures/week1.md', 'lectures/week2.txt', 'notes.md']);
  assert.deepEqual(hashes(dir), before, 'files unchanged');
  assert.ok(!fs.existsSync(path.join(dir, 'sources')), 'nothing copied into sources/');
  const tracked = git(dir, 'ls-files').split('\n').filter(Boolean);
  for (const f of ['notes.md', 'lectures/week1.md', 'lectures/week2.txt', '.hidden', '.studio/meta.json', 'course.json', 'AGENTS.md']) assert.ok(tracked.includes(f), `${f} committed`);
  assert.ok(!tracked.some(f => /node_modules|\.venv|^link/.test(f)), 'dependencies and links stay out');
  assert.equal(git(dir, 'status', '--porcelain'), '?? link\n', 'clean after the first commit (links are not committed)');

  // the import records the files it used: meta.sources; they are read-only for agents and listed in AGENTS.md
  const p = r.project; p.sources = ['lectures/week1.md', 'notes.md'];
  await projects.save(p.id, p, r.head, { message: 'import: 2 files → sources' });
  const meta = JSON.parse(fs.readFileSync(path.join(dir, '.studio/meta.json'), 'utf8'));
  assert.deepEqual(meta.sources, ['lectures/week1.md', 'notes.md']); assert.equal(meta.project.sources, undefined);
  assert.deepEqual((await projects.load(p.id)).project.sources, ['lectures/week1.md', 'notes.md']);
  assert.deepEqual([...sourcesOf(dir)], ['lectures/week1.md', 'notes.md']);
  assert.equal(jobs.rejectReason('notes.md', new Set(), sourcesOf(dir)), 'source material is read-only');
  assert.equal(jobs.rejectReason('lectures/week2.txt', new Set(), sourcesOf(dir)), null, 'files the import left alone are not recorded');
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /kept where they were.*`lectures\/week1\.md`, `notes\.md`/);
  // an agent's copy has them read-only, and a change to them is refused
  const job = path.join(tmpdir(), 'job'); const base = jobs.copyProject(dir, job);
  assert.equal(fs.statSync(path.join(job, 'notes.md')).mode & 0o222, 0);
  fs.chmodSync(path.join(job, 'notes.md'), 0o644); fs.writeFileSync(path.join(job, 'notes.md'), 'changed');
  const ch = jobs.changes(dir, job, base); assert.equal(ch.find(c => c.path === 'notes.md').rejected, 'source material is read-only');
  assert.deepEqual(hashes(dir), before, 'still unchanged');
});

test('a git repository already: no re-init, only the app’s files are committed, the user’s staged and unstaged work is left alone', async () => {
  const dir = path.join(tmpdir(), 'repo-course'); fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'teaching');
  put(dir, '.gitignore', 'secret.txt\n'); put(dir, 'notes.md', '# Notes\n'); put(dir, 'lectures/week1.md', '# W1\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'mine');
  const mine = git(dir, 'rev-parse', 'HEAD').trim();
  put(dir, 'notes.md', '# Notes (unsaved work)\n'); put(dir, 'staged.md', 'staged'); git(dir, 'add', 'staged.md'); put(dir, 'secret.txt', 's');
  const before = hashes(dir); const ignoreBefore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(folders.inspect(dir).git, true);

  const projects = new Projects({ watch: false });
  const r = await projects.adopt(course('Repo course'), dir);
  assert.equal(r.repo, 'existing'); assert.equal(r.project.repo, 'existing');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'teaching', 'same branch');
  assert.equal(git(dir, 'rev-parse', 'HEAD~1').trim(), mine, 'one commit on top of the user’s');
  const added = git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
  assert.ok(added.includes('.studio/meta.json') && added.includes('course.json') && added.includes('.studio/.gitignore') && added.includes('AGENTS.md'));
  assert.ok(!added.some(f => ['notes.md', 'staged.md', 'secret.txt', '.gitignore'].includes(f) || f.startsWith('lectures/')), `only app files: ${added}`);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), ignoreBefore, '.gitignore untouched');
  assert.deepEqual(hashes(dir), before);
  const status = git(dir, 'status', '--porcelain');
  assert.match(status, /^A  staged\.md$/m, 'still staged, not committed'); assert.match(status, /^ M notes\.md$/m, 'still modified, not committed');
  assert.doesNotMatch(status, /\.studio|course\.json|secret/);

  // later saves and edits made on disk commit only the app's files
  const p = r.project; p.sources = ['notes.md']; p.foundation.syllabus = { status: 'done', output: 'Week 1: agents\n', version: 1 };
  const s1 = await projects.save(p.id, p, r.head);
  assert.ok(git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean).every(f => f.startsWith('.studio/') || f.startsWith('design/') || f === 'AGENTS.md'));
  put(dir, 'lectures/week1.md', '# W1 edited\n'); put(dir, 'design/syllabus.md', 'Week 1: tools\n');
  const s = projects.state(p.id); s.pending.add('lectures/week1.md'); s.pending.add('design/syllabus.md'); await projects.adoptExternal(s);
  const last = git(dir, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n').filter(Boolean);
  assert.notEqual(git(dir, 'rev-parse', 'HEAD').trim(), s1.head); assert.ok(last.includes('design/syllabus.md')); assert.ok(!last.includes('lectures/week1.md'));
  assert.match(git(dir, 'status', '--porcelain'), /^ M lectures\/week1\.md$/m);
  assert.match(git(dir, 'status', '--porcelain'), /^A  staged\.md$/m);
});

test('refused: the home folder and other allowed roots themselves, folders outside them, files, courses', () => {
  for (const d of [os.homedir(), os.tmpdir()]) assert.throws(() => folders.inspect(d), e => e.status === 400 && /inside your home folder, not the home folder itself/.test(e.message));
  assert.throws(() => folders.inspect('/etc'), e => e.status === 403);
  const dir = tmpdir(); put(dir, 'a.txt', 'x');
  assert.throws(() => folders.inspect(path.join(dir, 'a.txt')), e => e.status === 400 && /Not a folder/.test(e.message));
  fs.mkdirSync(path.join(dir, '.studio')); fs.writeFileSync(path.join(dir, '.studio/meta.json'), '{}');
  assert.throws(() => folders.inspect(dir), e => e.status === 409);
});

test('size limits: more than 2000 files or 500 MB is refused (symlinks not followed, dependency folders skipped)', async () => {
  const many = tmpdir();
  for (let i = 0; i <= 2000; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), '');
  assert.throws(() => folders.inspect(many), e => e.status === 413 && /more than 2000 files.*subfolder/.test(e.message));
  const big = tmpdir(); fs.writeFileSync(path.join(big, 'a.pdf'), ''); fs.truncateSync(path.join(big, 'a.pdf'), 501 * 1024 * 1024); // sparse
  assert.throws(() => folders.inspect(big), e => e.status === 413 && /500 MB.*subfolder/.test(e.message));
  const ok = tmpdir(); put(ok, 'slides.pptx', 'x');
  fs.symlinkSync(many, path.join(ok, 'elsewhere')); fs.symlinkSync(big, path.join(ok, 'big'));
  fs.mkdirSync(path.join(ok, 'node_modules')); for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(ok, 'node_modules', `m${i}.js`), '');
  const info = folders.inspect(ok); assert.equal(info.count, 1); assert.deepEqual(info.kinds, [['Slides', 1]]);
  assert.equal(folders.scan(ok, { limits: { files: 0, bytes: 1e9 } }).over, 'files');
  await assert.rejects(new Projects({ watch: false }).adopt(course('Too many'), many), e => e.status === 413);
  assert.ok(!fs.existsSync(path.join(many, '.git')), 'refused before anything is written');
});

test('commit(): only the given paths go in, nested trees are rebuilt, deletions work, the index follows', async () => {
  const dir = tmpdir(); await vcs.init(dir);
  put(dir, 'a/b/c.md', 'c'); put(dir, 'a/d.md', 'd'); put(dir, 'top.md', 't'); put(dir, 'other.md', 'o');
  const h1 = await vcs.commit(dir, ['a/b/c.md', 'a/d.md', 'top.md'], 'one');
  assert.deepEqual(git(dir, 'ls-tree', '-r', '--name-only', h1).split('\n').filter(Boolean), ['a/b/c.md', 'a/d.md', 'top.md']);
  fs.rmSync(path.join(dir, 'a/b/c.md')); put(dir, 'a/d.md', 'd2');
  const h2 = await vcs.commit(dir, ['a/b/c.md', 'a/d.md'], 'two');
  assert.deepEqual(git(dir, 'ls-tree', '-r', '--name-only', h2).split('\n').filter(Boolean), ['a/d.md', 'top.md']);
  assert.equal(await vcs.commit(dir, ['a/d.md'], 'same'), h2, 'no empty commits');
  assert.match(git(dir, 'status', '--porcelain'), /^\?\? other\.md$/m); assert.doesNotMatch(git(dir, 'status', '--porcelain'), /a\/d\.md|c\.md/);
});

test('HTTP: opening a plain folder describes it, adopt makes it a course, the folder picker marks courses', async () => {
  const root = tmpdir(); const dir = path.join(root, 'stats'); put(dir, 'hw1.docx', 'x'); put(dir, 'week1.pptx', 'y');
  const app = await startServer({ port: 0, editorDir: null, watch: false, quiet: true });
  const call = (p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: app.port, method: body ? 'POST' : 'GET', path: p, headers: { Host: `127.0.0.1:${app.port}`, Authorization: `Bearer ${app.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString() || 'null') })); });
    r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
  });
  try {
    const o = await call('/api/projects/open', { dir });
    assert.equal(o.status, 200); assert.equal(o.body.folder.name, 'stats'); assert.equal(o.body.folder.count, 2); assert.deepEqual(o.body.folder.kinds.map(k => k[0]).sort(), ['Slides', 'Word']);
    assert.equal((await call('/api/projects/open', { dir: os.homedir() })).status, 400);
    const a = await call('/api/projects/adopt', { dir, project: course('Stats') });
    assert.equal(a.status, 200); assert.deepEqual(a.body.files.map(f => f.path), ['hw1.docx', 'week1.pptx']);
    const again = await call('/api/projects/open', { dir }); assert.equal(again.body.project.id, a.body.project.id);
    const b = await call(`/api/fs/dirs?path=${encodeURIComponent(root)}`); assert.deepEqual(b.body.dirs, [{ name: 'stats', isProject: true }]);
    // agents cannot change an in-place source
    const p = a.body.project; p.sources = ['week1.pptx'];
    const sv = await new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: app.port, method: 'PUT', path: `/api/projects/${p.id}`, headers: { Host: `127.0.0.1:${app.port}`, Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); r.on('error', reject); r.write(JSON.stringify({ project: p, base: a.body.head })); r.end(); });
    assert.equal(sv, 200);
    const ap = await call(`/api/projects/${p.id}/agent/apply`, { files: [{ path: 'week1.pptx', data: Buffer.from('z').toString('base64') }], message: 'agent: x' });
    assert.equal(ap.status, 403); assert.match(ap.body.error, /source material is read-only/);
    assert.equal(fs.readFileSync(path.join(dir, 'week1.pptx'), 'utf8'), 'y');
  } finally { await app.close(); }
});
