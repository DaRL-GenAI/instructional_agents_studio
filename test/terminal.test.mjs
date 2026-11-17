// The agents' own terminals (server/terminal.mjs): a PTY in the course folder over a WebSocket, its output kept for a
// page that comes back, access only with the app's token. Uses a plain shell, so it runs without Claude Code or Codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { WebSocket } from 'ws';
import { tmpdir, isolateConfig, sampleProject } from './helpers.mjs';

isolateConfig();
const terminal = await import('../server/terminal.mjs');
const { startServer } = await import('../server/http.mjs');
const why = terminal.unavailable();

test('a shell in the course folder: input, output, replay for a second page, size, close', { skip: why || false, timeout: 60000 }, async () => {
  const app = await startServer({ dir: path.join(tmpdir(), 'course'), port: 0, editorDir: null, watch: false, quiet: true });
  try {
    const H = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
    const api = (p, o = {}) => fetch(`http://127.0.0.1:${app.port}${p}`, { ...o, headers: { ...H, ...(o.headers || {}) } });
    const created = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ project: sampleProject() }) })).json();
    const P = `/api/projects/${created.project.id}/terminals`;
    const list0 = await (await api(P)).json(); assert.equal(list0.available.shell, true); assert.equal(list0.unavailable, null);
    const r = await api(P, { method: 'POST', body: JSON.stringify({ program: 'shell', cols: 90, rows: 20 }) }); const t = await r.json();
    assert.equal(r.status, 200, JSON.stringify(t)); assert.match(t.id, /^[0-9a-f]{12}$/); assert.equal(t.running, true);
    const open = () => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/term/${t.id}`, { headers: { Authorization: `Bearer ${app.token}`, Origin: `http://127.0.0.1:${app.port}` } }); let out = ''; ws.on('message', d => { out += d.toString(); }); ws.on('open', () => res({ ws, out: () => out })); ws.on('error', rej); });
    const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };
    const a = await open();
    a.ws.send(`\x00${JSON.stringify({ type: 'resize', cols: 80, rows: 24 })}`);
    a.ws.send('echo ia-term-$((40+2))\r'.replace('$((40+2))', process.platform === 'win32' ? '42' : '$((40+2))'));
    assert.ok(await until(() => a.out().includes('ia-term-42')), `output: ${a.out().slice(-400)}`);
    // the shell runs in the course folder
    a.ws.send(process.platform === 'win32' ? 'cd\r' : 'pwd\r');
    assert.ok(await until(() => a.out().includes(path.basename(created.dir))), 'cwd is the course folder');
    // a second page gets what was shown so far
    const b = await open(); assert.ok(await until(() => b.out().includes('ia-term-42')), 'replayed');
    assert.equal((await (await api(P)).json()).terminals.length, 1);
    // no token, no terminal
    await assert.rejects(new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws/term/${t.id}`); ws.on('open', res); ws.on('error', rej); }));
    assert.equal((await api(`${P}/${t.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual((await (await api(P)).json()).terminals, []);
    assert.equal((await api(P, { method: 'POST', body: JSON.stringify({ program: 'rm' }) })).status, 400);
    a.ws.close(); b.ws.close();
  } finally { await app.close(); }
});
