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
