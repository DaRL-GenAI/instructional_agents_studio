// http.mjs — the local server: the Studio front end (repo root: index.html, js/, css/, assets/), the editor build at
// /editor/, the JSON API at /api/ and the change feed at /ws. Listens on 127.0.0.1 only; see security.mjs.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createGuard, newToken } from './security.mjs';
import { Projects, HttpError, checkDir, isProjectDir, allowedRoots } from './projects.mjs';
import { resolveInside, sha256 } from './workspace.mjs';
import { findEditor } from './editor-pkg.mjs';
import * as media from './media.mjs';
import * as config from './config.mjs';
import * as vcs from './vcs.mjs';
import * as agents from './agents/runner.mjs';
import { forward } from './llmproxy.mjs';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const STATIC_TOP = new Set(['index.html', 'js', 'css', 'assets']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.map': 'application/json', '.bin': 'application/octet-stream', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/markdown; charset=utf-8' };
const LIMIT = { json: 256 * 1024 * 1024, media: 2 * 1024 * 1024 * 1024 };

/** Start the server. `dir`: the folder the app was started in (a project, or where a new one should go). */
export async function startServer({ dir = null, port = 8790, token = newToken(), editorDir, watch = true, quiet = false } = {}) {
  const editor = editorDir !== undefined ? (editorDir ? { dir: path.resolve(editorDir), version: 'local' } : null) : findEditor();
  const clients = new Set();
  const broadcast = ev => { const s = JSON.stringify(ev); for (const c of clients) if (c.readyState === 1) c.send(s); };
  const projects = new Projects({ onChange: broadcast, watch });
  const session = { pendingDir: null, openId: null };
  if (dir) {
    const abs = checkDir(dir);
    if (isProjectDir(abs)) session.openId = projects.open(abs).id; else session.pendingDir = abs;
  }
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const listen = p => new Promise((res, rej) => { server.once('error', rej); server.listen(p, '127.0.0.1', () => { server.off('error', rej); res(server.address().port); }); });
  let bound;
  for (let p = port, tries = 0; ; p++, tries++) { try { bound = await listen(p); break; } catch (e) { if (e.code !== 'EADDRINUSE' || tries > 20 || port === 0) throw e; } }
  const guard = createGuard({ token, port: bound });
  const editorTop = editor ? new Set(fs.readdirSync(editor.dir).filter(n => !STATIC_TOP.has(n))) : new Set();
  const isolate = !!editor; // the editor's wasm threads need a cross-origin isolated page

  server.on('request', (req, res) => handle(req, res).catch(e => {
    const status = e.status || 500; if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || String(e), ...(e.body || {}) }); else res.end();
  }));
  server.on('upgrade', (req, sock, head) => {
    const bad = guard.checkHost(req) || guard.checkOrigin(req, { api: true }) || (!guard.authed(req) && [401, 'Unauthorized']);
    if (bad || new URL(req.url, 'http://x').pathname !== '/ws') { sock.write(`HTTP/1.1 ${bad ? bad[0] : 404} ${bad ? bad[1] : 'Not Found'}\r\nConnection: close\r\n\r\n`); return sock.destroy(); }
    wss.handleUpgrade(req, sock, head, ws => { clients.add(ws); ws.on('close', () => clients.delete(ws)); ws.send(JSON.stringify({ type: 'hello', version: PKG.version })); });
  });

  async function handle(req, res) {
    const bad = guard.checkHost(req); if (bad) return send(res, bad[0], { error: bad[1] });
    const url = new URL(req.url, `http://${req.headers.host}`); const p = decodeURIComponent(url.pathname);
    // the token arrives once in the URL; trade it for the cookie and drop it from the address bar
    if (url.searchParams.has('token')) {
      if (!guard.tokenMatches(url.searchParams.get('token'))) return send(res, 403, 'Wrong token. Open the address printed by instructional-agents.');
      url.searchParams.delete('token');
      res.writeHead(302, { 'Set-Cookie': guard.cookie(), Location: url.pathname + (url.search || '') + url.hash, 'Cache-Control': 'no-store' }); return res.end();
    }
    if (p.startsWith('/api/')) {
      const o = guard.checkOrigin(req, { api: true }); if (o) return send(res, o[0], { error: o[1] });
      if (p === '/api/health') return send(res, 200, { app: 'instructional-agents', version: PKG.version });
      if (!guard.authed(req)) return send(res, 401, { error: 'Unauthorized: open the address printed by instructional-agents' });
      return api(req, res, url, p);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    const o = guard.checkOrigin(req); if (o) return send(res, o[0], o[1]);
    if (p === '/' || p === '/index.html') {
      if (!guard.authed(req)) return send(res, 401, 'This is the Instructional Agents local app. Open the address printed in the terminal (it carries the access token).');
      return sendIndex(res);
    }
    if (editor && (p === '/editor' || p.startsWith('/editor/'))) {
      if (p === '/editor') { res.writeHead(301, { Location: '/editor/' }); return res.end(); }
      let rel = p.slice('/editor/'.length) || 'index.html';
      if (rel === 'editor' || (!path.extname(rel) && fs.existsSync(path.join(editor.dir, `${rel}.html`)))) rel += '.html';
      return sendFile(req, res, editor.dir, rel, 'editor');
    }
    const top = p.split('/')[1];
    if (STATIC_TOP.has(top)) return sendFile(req, res, APP_ROOT, p.slice(1), 'app');
    if (editorTop.has(top)) return sendFile(req, res, editor.dir, p.slice(1), 'editor'); // absolute paths inside the editor build (/sdkjs/…)
    return send(res, 404, 'Not found');
  }

  function sendIndex(res) {
    const info = { version: PKG.version, editor: !!editor, projectsRoot: config.projectsRoot(), pendingDir: session.pendingDir, openId: session.openId, home: os.homedir() };
    const html = fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8').replace('<script type="importmap">', `<script>window.__IA_LOCAL__=${JSON.stringify(info).replace(/</g, '\\u003c')}</script>\n  <script type="importmap">`);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', ...headersFor('app') }); res.end(html);
  }
  function headersFor(kind) {
    const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    if (isolate) { h['Cross-Origin-Opener-Policy'] = 'same-origin'; h['Cross-Origin-Embedder-Policy'] = kind === 'editor' ? 'require-corp' : 'credentialless'; h['Cross-Origin-Resource-Policy'] = 'same-origin'; }
    return h;
  }
  function sendFile(req, res, root, rel, kind) {
    let abs; try { abs = resolveInside(root, rel); } catch { return send(res, 404, 'Not found'); }
    if (root === APP_ROOT && !STATIC_TOP.has(rel.split('/')[0])) return send(res, 404, 'Not found');
    let st; try { st = fs.statSync(abs); } catch { return send(res, 404, 'Not found'); }
    if (st.isDirectory()) { if (fs.existsSync(path.join(abs, 'index.html'))) { abs = path.join(abs, 'index.html'); st = fs.statSync(abs); } else return send(res, 404, 'Not found'); }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const h = { 'Content-Type': type, 'Content-Length': st.size, ETag: etag, 'Cache-Control': kind === 'editor' && /\/assets\//.test(abs) ? 'public, max-age=31536000, immutable' : 'no-cache', ...headersFor(kind) };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
    res.writeHead(200, h); if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  }

  // ---------------------------------------------------------------- API
  async function api(req, res, url, p) {
    const m = req.method; let g;
    if (p === '/api/settings') {
      if (m === 'GET') return send(res, 200, config.settings());
      if (m === 'PUT') { config.saveSettings(await body(req)); return send(res, 204); }
    }
    if (p === '/api/projects' && m === 'GET') return send(res, 200, { projects: projects.list() });
    if (p === '/api/projects' && m === 'POST') { const b = await body(req); const r = await projects.create(b.project, b.dir || (session.pendingDir && !isProjectDir(session.pendingDir) ? session.pendingDir : null)); if (r.dir === session.pendingDir) session.pendingDir = null; return send(res, 200, r); }
    if (p === '/api/projects/open' && m === 'POST') { const d = checkDir((await body(req)).dir); if (!isProjectDir(d)) throw new HttpError(400, 'Not a course folder (no .studio/meta.json). Create a new course there instead.'); return send(res, 200, await projects.load(projects.open(d).id)); }
    if (p === '/api/projects/import' && m === 'POST') { const b = await body(req); return send(res, 200, await projects.importJson(b.json, b.dir, { source: b.name || 'project.json' })); }
    if (p === '/api/fs/dirs' && m === 'GET') return send(res, 200, browse(url.searchParams.get('path')));
    if (p === '/api/llm') return forward(req, res);
    if (p === '/api/agents/health' && m === 'GET') return send(res, 200, agents.health());
    if (p === '/api/agents/cancel' && m === 'POST') return send(res, 200, { cancelled: agents.cancel() });
    if (p === '/api/agents/revise' && m === 'POST') return revise(req, res);
    if ((g = p.match(/^\/api\/projects\/([\w-]+)$/))) {
      const id = g[1];
      if (m === 'GET') return send(res, 200, await projects.load(id));
      if (m === 'PUT') { const b = await body(req); return send(res, 200, await projects.save(id, b.project, b.base)); }
      if (m === 'DELETE') { projects.forget(id); return send(res, 204); }
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/duplicate$/)) && m === 'POST') return send(res, 200, await projects.duplicate(g[1]));
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/log$/)) && m === 'GET') return send(res, 200, { log: await vcs.log(projects.state(g[1]).dir) });
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/media$/)) && m === 'GET') return send(res, 200, { keys: media.keys(projects.state(g[1]).dir) });
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/media\/([^/]+)$/))) {
      const s = projects.state(g[1]); const key = g[2];
      if (m === 'GET') {
        const fallback = (ch, sha) => { // a fresh clone has no .studio/decks: the chapter's slides.pptx may be that version
          const f = JSON.parse(fs.readFileSync(path.join(s.dir, '.studio/meta.json'), 'utf8')).stages?.[`chapters.${ch}.slides`]?.$deck; if (!f) return null;
          let b; try { b = fs.readFileSync(resolveInside(s.dir, f)); } catch { return null; }
          return sha256(b) === sha ? b : null;
        };
        const out = media.get(s.dir, key, fallback); if (!out) return send(res, 404, { error: 'No such media' });
        res.writeHead(200, { 'Content-Type': 'application/x-ia-bundle', 'Content-Length': out.length, 'Cache-Control': 'no-store' }); return res.end(out);
      }
      if (m === 'PUT') { media.put(s.dir, key, await raw(req, LIMIT.media)); return send(res, 204); }
      if (m === 'DELETE') { media.del(s.dir, key); return send(res, 204); }
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/files\/(.+)$/)) && m === 'GET') { // read one file of the project (raw)
      const s = projects.state(g[1]); const abs = resolveInside(s.dir, g[2]);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'No such file' });
      const buf = fs.readFileSync(abs); res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }); return res.end(buf);
    }
    return send(res, 404, { error: 'Not found' });
  }

  function browse(p) {
    const roots = allowedRoots();
    const start = p ? checkDir(p) : (fs.existsSync(config.projectsRoot()) ? config.projectsRoot() : os.homedir());
    let dirPath = start; while (!fs.existsSync(dirPath)) dirPath = path.dirname(dirPath);
    const dirs = fs.readdirSync(dirPath, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map(d => ({ name: d.name, isProject: isProjectDir(path.join(dirPath, d.name)) })).sort((a, b) => a.name.localeCompare(b.name));
    const up = path.dirname(dirPath);
    return { path: dirPath, isProject: isProjectDir(dirPath), parent: up !== dirPath && roots.some(r => up === r || up.startsWith(r + path.sep)) ? up : null, dirs };
  }

  async function revise(req, res) {
    const b = await body(req); const err = agents.checkRevise(b); if (err) return send(res, 400, { error: err });
    if (agents.busy()) return send(res, 409, { error: 'Another revision is running' });
    const s = projects.state(b.project);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    const out = ev => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
    res.on('close', () => { if (!res.writableFinished) agents.cancel('the browser disconnected'); });
    try { await agents.revise(s.dir, b, out); } catch (e) { out({ type: 'error', message: String(e.message || e) }); }
    res.end();
  }

  const origin = `http://127.0.0.1:${bound}`;
  const startUrl = `${origin}/?token=${token}${session.openId ? `#/p/${session.openId}/overview` : '#/projects'}`;
  if (!quiet) console.log(`Instructional Agents ${PKG.version} on ${origin}${editor ? ` (editor: ${editor.dir})` : ' (editor: https://edit.chaxus.com)'}`);
  return {
    server, port: bound, origin, token, url: startUrl, projects, editor,
    async close() { agents.cancel('server stopped'); for (const c of clients) c.terminate(); wss.close(); await projects.close(); await new Promise(r => server.close(r)); },
  };
}

function send(res, status, data) {
  if (status === 204 || data === undefined || data === null && status === 204) { res.writeHead(status); return res.end(); }
  const isText = typeof data === 'string'; const b = isText ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(b);
}
async function raw(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function body(req) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected JSON');
  try { return JSON.parse((await raw(req, LIMIT.json)).toString('utf8')); } catch (e) { if (e.status) throw e; throw new HttpError(400, 'Bad JSON'); }
}
