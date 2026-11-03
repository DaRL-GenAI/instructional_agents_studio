// The local server: who may call it, and paths that try to leave the project folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tmpdir, isolateConfig, sampleProject } from './helpers.mjs';

isolateConfig();
const { startServer } = await import('../server/http.mjs');

/** Raw request (fetch cannot set Host / Origin / Sec-Fetch-Site freely). */
function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') })); });
    r.on('error', reject); if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body)); r.end();
  });
}

const dir = tmpdir();
const app = await startServer({ dir: path.join(dir, 'course'), port: 0, editorDir: null, watch: false, quiet: true });
const auth = { Authorization: `Bearer ${app.token}` };
test.after(() => app.close());

test('the token in the URL becomes an HttpOnly SameSite=Strict cookie', async () => {
  const r = await req(app.port, { path: `/?token=${app.token}` });
  assert.equal(r.status, 302); assert.match(r.headers['set-cookie'][0], /ia_token=.+; HttpOnly; SameSite=Strict/); assert.equal(r.headers.location, '/');
  const page = await req(app.port, { path: '/', headers: { Cookie: `ia_token=${app.token}` } });
  assert.equal(page.status, 200); assert.match(page.body, /window\.__IA_LOCAL__=/);
});

test('a wrong or missing token is refused', async () => {
  assert.equal((await req(app.port, { path: '/?token=nope' })).status, 403);
  assert.equal((await req(app.port, { path: '/' })).status, 401);
  assert.equal((await req(app.port, { path: '/api/projects' })).status, 401);
  assert.equal((await req(app.port, { path: '/api/projects', headers: { Cookie: 'ia_token=nope' } })).status, 401);
  assert.equal((await req(app.port, { path: '/api/projects', headers: auth })).status, 200);
});

test('a foreign Host (DNS rebinding) is refused', async () => {
  assert.equal((await req(app.port, { path: '/api/projects', headers: { ...auth, Host: 'evil.example:80' } })).status, 421);
  assert.equal((await req(app.port, { path: '/', headers: { Host: `attacker.test:${app.port}` } })).status, 421);
});

test('another origin (even another port on localhost) cannot call the API', async () => {
  const cookie = { Cookie: `ia_token=${app.token}` };
  for (const origin of ['http://127.0.0.1:9999', 'http://localhost:1234', 'https://darl-genai.github.io', 'null']) assert.equal((await req(app.port, { method: 'POST', path: '/api/projects', headers: { ...cookie, Origin: origin, 'Content-Type': 'application/json' }, body: {} })).status, 403, origin);
  assert.equal((await req(app.port, { path: '/api/projects', headers: { ...cookie, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await req(app.port, { path: '/api/projects', headers: { ...cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await req(app.port, { path: '/api/projects', headers: { ...cookie, Origin: app.origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

test('the WebSocket needs the cookie and the same origin', async () => {
  const { WebSocket } = await import('ws');
  const open = headers => new Promise(res => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers }); ws.on('open', () => { ws.close(); res('open'); }); ws.on('error', () => res('refused')); ws.on('unexpected-response', () => res('refused')); });
  assert.equal(await open({ Cookie: `ia_token=${app.token}`, Origin: app.origin }), 'open');
  assert.equal(await open({ Cookie: `ia_token=${app.token}`, Origin: 'http://127.0.0.1:9999' }), 'refused');
  assert.equal(await open({ Origin: app.origin }), 'refused');
});

test('static files only from the front end; server code and dotfiles are not served', async () => {
  assert.equal((await req(app.port, { path: '/js/app.js' })).status, 200);
  for (const p of ['/server/http.mjs', '/package.json', '/bin/cli.mjs', '/.git/config', '/test/helpers.mjs', '/node_modules/ws/package.json', '/js/../server/http.mjs', '/js/%2e%2e/server/http.mjs', '/css/..%2f..%2fpackage.json']) assert.equal((await req(app.port, { path: p })).status, 404, p);
});

test('project paths cannot leave the folder', async () => {
  const created = JSON.parse((await req(app.port, { method: 'POST', path: '/api/projects', headers: { ...auth, 'Content-Type': 'application/json' }, body: { project: sampleProject() } })).body);
  assert.equal(created.dir, path.join(dir, 'course'), 'the folder the app was started in');
  const id = created.project.id; const P = `/api/projects/${id}`;
  assert.equal((await req(app.port, { path: `${P}/files/course.json`, headers: auth })).status, 200);
  fs.symlinkSync('/etc', path.join(created.dir, 'escape'));
  for (const f of ['..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', 'escape/passwd', 'design/..%2F..%2F..%2Fetc%2Fpasswd']) assert.ok([400, 404].includes((await req(app.port, { path: `${P}/files/${f}`, headers: auth })).status), f);
  for (const key of ['..%2F..:x', 'ch1:..%2F..%2Fx', 'ch1:deck:..%2Fx', `project:${encodeURIComponent('../../x')}`]) assert.ok([400, 404].includes((await req(app.port, { path: `${P}/media/${key}`, headers: auth })).status), key);
  assert.equal((await req(app.port, { method: 'POST', path: '/api/projects/open', headers: { ...auth, 'Content-Type': 'application/json' }, body: { dir: '/etc' } })).status, 403);
  assert.equal((await req(app.port, { path: `/api/fs/dirs?path=${encodeURIComponent('/etc')}`, headers: auth })).status, 403);
});

test('model calls are forwarded for the page (endpoints without CORS), only for the app itself', async () => {
  const up = http.createServer((q, r) => { const c = []; q.on('data', d => c.push(d)); q.on('end', () => { r.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'x=1' }); r.write('data: {"auth":' + JSON.stringify(q.headers.authorization || null) + '}\n\n'); r.end('data: ' + Buffer.concat(c).toString() + '\n\n'); }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  try {
    const target = `http://127.0.0.1:${up.address().port}/v1/chat/completions`;
    const h = { ...auth, 'Content-Type': 'application/json', 'X-IA-Target': target, Cookie: 'ia_token=x' };
    const r = await req(app.port, { method: 'POST', path: '/api/llm', headers: { ...h, Authorization: `Bearer ${app.token}` }, body: { model: 'm' } });
    assert.equal(r.status, 200); assert.equal(r.headers['content-type'], 'text/event-stream'); assert.equal(r.headers['set-cookie'], undefined);
    assert.match(r.body, /"model":"m"/);
    assert.equal((await req(app.port, { method: 'POST', path: '/api/llm', headers: { 'Content-Type': 'application/json', 'X-IA-Target': target }, body: {} })).status, 401);
    assert.equal((await req(app.port, { method: 'POST', path: '/api/llm', headers: { ...auth, 'X-IA-Target': target, Origin: 'http://127.0.0.1:9999' }, body: {} })).status, 403);
    for (const t of ['file:///etc/passwd', 'not a url', 'http://user:pw@127.0.0.1/']) assert.equal((await req(app.port, { method: 'POST', path: '/api/llm', headers: { ...auth, 'X-IA-Target': t }, body: {} })).status, 400, t);
  } finally { up.close(); }
});

test('the editor build: isolation headers, pre-compressed wasm and extension-less fonts', async () => {
  const ed = tmpdir('ia-ed-'); fs.mkdirSync(path.join(ed, 'sdkjs/common/wasm'), { recursive: true }); fs.mkdirSync(path.join(ed, 'fonts'));
  fs.writeFileSync(path.join(ed, 'editor.html'), '<!doctype html>'); fs.writeFileSync(path.join(ed, 'sdkjs/common/wasm/x2t.wasm.br'), 'BR'); fs.writeFileSync(path.join(ed, 'fonts/050'), 'TTF');
  const app2 = await startServer({ port: 0, editorDir: ed, watch: false, quiet: true });
  try {
    const page = await req(app2.port, { path: '/editor/editor?embed=1' });
    assert.equal(page.status, 200); assert.equal(page.headers['cross-origin-embedder-policy'], 'require-corp'); assert.equal(page.headers['cross-origin-opener-policy'], 'same-origin');
    const w = await req(app2.port, { path: '/editor/sdkjs/common/wasm/x2t.wasm.br' });
    assert.equal(w.headers['content-encoding'], 'br'); assert.equal(w.headers['content-type'], 'application/wasm');
    assert.equal((await req(app2.port, { path: '/editor/fonts/050' })).headers['content-type'], 'font/ttf');
    const index = await req(app2.port, { path: '/', headers: { Cookie: `ia_token=${app2.token}` } });
    assert.equal(index.headers['cross-origin-embedder-policy'], 'credentialless');
  } finally { await app2.close(); }
});
