// The Workspace API (tree, plain-file writes with conflict checks, folders, rename, delete into the trash, search,
// git summary), stages kept as Word documents, and the Markdown ⇄ Word conversion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir, isolateConfig, sampleProject } from './helpers.mjs';

isolateConfig();
const { startServer } = await import('../server/http.mjs');
const vcs = await import('../server/vcs.mjs');
const { mdToDocx, docxToMd } = await import('../js/docconv.js');

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* raw */ } resolve({ status: res.statusCode, headers: res.headers, buf, json }); }); });
    r.on('error', reject); if (body !== undefined) r.write(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)); r.end();
  });
}
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

const root = tmpdir();
const app = await startServer({ dir: path.join(root, 'course'), port: 0, editorDir: null, watch: false, quiet: true });
test.after(() => app.close());
const auth = { Authorization: `Bearer ${app.token}` };
const J = { ...auth, 'Content-Type': 'application/json' };
const created = (await req(app.port, { method: 'POST', path: '/api/projects', headers: J, body: { project: sampleProject() } })).json;
const P = `/api/projects/${created.project.id}`; const dir = created.dir;
const put = (f, data, q = '') => req(app.port, { method: 'PUT', path: `${P}/files/${f}${q}`, headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: data });
const post = (op, body) => req(app.port, { method: 'POST', path: `${P}/fs/${op}`, headers: J, body });
const lastMessage = async () => (await vcs.log(dir, 1))[0].message;

test('the tree lists the folder without .git; managed files are marked', async () => {
  const r = await req(app.port, { path: `${P}/tree`, headers: auth });
  assert.equal(r.status, 200);
  const paths = r.json.entries.map(e => e.path);
  assert.ok(paths.includes('design/learning_objectives.md') && paths.includes('.studio/meta.json') && paths.includes('.studio') && paths.includes('design'));
  assert.ok(!paths.some(p => p === '.git' || p.startsWith('.git/')));
  assert.ok(r.json.entries.find(e => e.path === 'design').dir);
  assert.ok(r.json.managed.includes('design/learning_objectives.md') && r.json.managed.includes('course.json'));
});

test('plain files: create, conflict on a stale base, overwrite on the right one; one commit each', async () => {
  let r = await put('notes/todo.md', '# Todo\n', '?base=new');
  assert.equal(r.status, 200); assert.equal(r.json.sha, sha('# Todo\n'));
  assert.equal(fs.readFileSync(path.join(dir, 'notes/todo.md'), 'utf8'), '# Todo\n');
  assert.equal(await lastMessage(), 'edit: notes/todo.md');
  assert.equal((await put('notes/todo.md', 'x', '?base=new')).status, 409, 'exists');
  const got = await req(app.port, { path: `${P}/files/notes/todo.md`, headers: auth });
  assert.equal(got.headers.etag, `"${sha('# Todo\n')}"`);
  r = await put('notes/todo.md', 'mine', `?base=${sha('something else')}`);
  assert.equal(r.status, 409); assert.equal(r.json.sha, sha('# Todo\n'));
  r = await put('notes/todo.md', '# Todo\n\n- one\n', `?base=${sha('# Todo\n')}`); assert.equal(r.status, 200);
  r = await put('sources/paper.pdf', Buffer.from('%PDF-1.4'), '?base=new&kind=import'); assert.equal(r.status, 200);
  assert.equal(await lastMessage(), 'import: sources/paper.pdf');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
});

test('files that belong to a stage or to the app are not written as plain files', async () => {
  const r = await put('design/learning_objectives.md', 'x'); assert.equal(r.status, 409); assert.equal(r.json.managed, true);
  assert.equal((await put('course.json', '{}')).status, 409);
  assert.equal((await put('.studio/meta.json', '{}')).status, 403);
  assert.equal((await put('.git/config', 'x')).status, 403);
  assert.equal((await put('..%2Fescape.md', 'x')).status, 400);
});

test('folders, rename and delete into .studio/trash', async () => {
  assert.equal((await post('mkdir', { path: 'drafts' })).status, 200);
  assert.ok(fs.statSync(path.join(dir, 'drafts')).isDirectory());
  assert.equal((await post('mkdir', { path: 'drafts' })).status, 409);
  let r = await post('rename', { from: 'notes/todo.md', to: 'drafts/todo.md' }); assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(dir, 'drafts/todo.md')) && !fs.existsSync(path.join(dir, 'notes/todo.md')));
  assert.match(await lastMessage(), /^edit: rename notes\/todo\.md → drafts\/todo\.md/);
  assert.equal((await post('rename', { from: 'design/learning_objectives.md', to: 'x.md' })).status, 409, 'a stage file stays where the stage expects it');
  assert.equal((await post('rename', { from: 'design', to: 'plan' })).status, 409, 'nor a folder holding one');
  assert.equal((await post('rename', { from: 'sources/paper.pdf', to: 'drafts/todo.md' })).status, 409, 'no overwrite');
  r = await post('delete', { path: 'drafts' }); assert.equal(r.status, 200);
  assert.match(r.json.trashed, /^\.studio\/trash\/.+\/drafts$/);
  assert.ok(fs.existsSync(path.join(dir, r.json.trashed, 'todo.md')) && !fs.existsSync(path.join(dir, 'drafts')));
  assert.equal(await lastMessage(), 'edit: delete drafts');
  assert.equal(execFileSync('git', ['ls-files', 'drafts'], { cwd: dir, encoding: 'utf8' }), '', 'gone from git too');
  assert.equal((await post('delete', { path: 'design/syllabus.md' })).status, 409);
  assert.equal((await post('delete', { path: '.studio/meta.json' })).status, 409);
  assert.equal((await post('delete', { path: '../x' })).status, 400);
});

test('search and the git summary', async () => {
  const r = await req(app.port, { path: `${P}/search?q=week%202`, headers: auth });
  assert.deepEqual(r.json.matches.map(m => [m.path, m.line]), [['design/syllabus.md', 2]]);
  const v = await req(app.port, { path: `${P}/vcs`, headers: auth });
  assert.equal(v.json.branch, 'main'); assert.equal(v.json.head, (await vcs.log(dir, 1))[0].oid);
});

test('a stage kept as a Word document: the .docx is written, versions live in .studio/decks, a fresh clone still finds it', async () => {
  const bytes = Buffer.from(await mdToDocx('# Homework\n\n1. First\n2. Second\n'));
  const s = sha(bytes); const key = encodeURIComponent(`chaaa1111:doc:${s}`);
  const PPTX_HEAD = JSON.stringify({ v: 1, skel: { $bin: 0 }, parts: [{ as: 'blob', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', len: bytes.length }] }) + '\n';
  assert.equal((await req(app.port, { method: 'PUT', path: `${P}/media/${key}`, headers: { ...auth, 'Content-Type': 'application/x-ia-bundle' }, body: Buffer.concat([Buffer.from(PPTX_HEAD), bytes]) })).status, 204);
  assert.ok(fs.existsSync(path.join(dir, `.studio/decks/chaaa1111/${s}.docx`)));
  const cur = (await req(app.port, { path: P, headers: auth })).json;
  const p = cur.project; p.chapters[0].stages.homework = { ...p.chapters[0].stages.script, output: JSON.stringify({ format: 'docx', sha: s, name: 'homework.docx', bytes: bytes.length, text: '# Homework\n' }) };
  p.audit.push({ id: p.audit.length + 1, type: 'convert', stage: 'Homework' });
  const saved = await req(app.port, { method: 'PUT', path: P, headers: J, body: { project: p, base: cur.head } });
  assert.equal(saved.status, 200);
  const f = path.join(dir, 'chapters/01-what-is-an-agent/homework.docx');
  assert.equal(sha(fs.readFileSync(f)), s);
  assert.ok(execFileSync('git', ['ls-files', 'chapters'], { cwd: dir, encoding: 'utf8' }).includes('homework.docx'));
  fs.rmSync(path.join(dir, '.studio/decks/chaaa1111'), { recursive: true });
  const back = await req(app.port, { path: `${P}/media/${key}`, headers: auth });
  assert.equal(back.status, 200); assert.equal(sha(back.buf.subarray(back.buf.indexOf(10) + 1)), s);
  const keys = (await req(app.port, { path: `${P}/media`, headers: auth })).json.keys;
  assert.ok(keys.includes(`chaaa1111:doc:${s}`));
});

test('Markdown → Word → Markdown keeps headings, emphasis and lists', async () => {
  const md = '# Homework 1\n\nAnswer **all** questions.\n\n1. First\n2. Second\n\n## Part B\n\n- a point\n';
  const docx = await mdToDocx(md);
  assert.equal(Buffer.from(docx).subarray(0, 2).toString(), 'PK');
  const back = await docxToMd(docx);
  for (const s of ['# Homework 1', 'Answer **all** questions.', '1. First', '2. Second', '## Part B', '- a point']) assert.ok(back.includes(s), `${s} in:\n${back}`);
});

test('import: dropped materials land in sources/ as one commit; a save can name its commit', async () => {
  const files = [['course-src/hw1.docx', Buffer.from('PK fake docx')], ['course-src/week1/intro.pptx', Buffer.from('PK fake pptx')], ['course-src/notes.md', Buffer.from('# Notes\n')]];
  const header = { v: 1, skel: { files: files.map(([p], i) => ({ path: p, data: { $bin: i } })) }, parts: files.map(([, b]) => ({ as: 'blob', type: '', len: b.length })) };
  const body = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), ...files.map(([, b]) => b)]);
  const bundle = { ...auth, 'Content-Type': 'application/x-ia-bundle' };
  const before = (await vcs.log(dir)).length;
  let r = await req(app.port, { method: 'POST', path: `${P}/sources`, headers: bundle, body });
  assert.equal(r.status, 200); assert.deepEqual(r.json.paths, ['sources/course-src/hw1.docx', 'sources/course-src/week1/intro.pptx', 'sources/course-src/notes.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'sources/course-src/notes.md'), 'utf8'), '# Notes\n');
  assert.equal((await vcs.log(dir)).length, before + 1, 'one commit');
  assert.equal(await lastMessage(), 'import: sources/course-src (3 files)');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
  // paths stay inside sources/
  for (const bad of ['../x.md', 'a/../../x.md', '.git/config', 'a/.studio/x']) {
    const h = { v: 1, skel: { files: [{ path: bad, data: { $bin: 0 } }] }, parts: [{ as: 'blob', type: '', len: 1 }] };
    r = await req(app.port, { method: 'POST', path: `${P}/sources`, headers: bundle, body: Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), Buffer.from('x')]) });
    assert.equal(r.status, 400, bad);
  }
  // the project save that follows names its commit (import:/edit:/gen: only)
  const cur = (await req(app.port, { path: P, headers: auth })).json;
  cur.project.foundation.objectives.output = '# Objectives\n\n- imported\n';
  r = await req(app.port, { method: 'PUT', path: P, headers: J, body: { project: cur.project, base: cur.head, message: 'import: 3 files → objectives' } });
  assert.equal(r.status, 200); assert.equal(await lastMessage(), 'import: 3 files → objectives');
  const again = (await req(app.port, { path: P, headers: auth })).json;
  again.project.foundation.objectives.output = '# Objectives\n\n- two\n';
  r = await req(app.port, { method: 'PUT', path: P, headers: J, body: { project: again.project, base: again.head, message: 'agent: sneaky' } });
  assert.equal(r.status, 200); assert.notEqual(await lastMessage(), 'agent: sneaky', 'other prefixes are not taken');
});
