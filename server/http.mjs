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
import { resolveInside, sha256, writeFile, sourcesOf } from './workspace.mjs';
import * as folders from './folders.mjs';
import { findEditor } from './editor-pkg.mjs';
import * as media from './media.mjs';
import * as config from './config.mjs';
import * as vcs from './vcs.mjs';
import * as agents from './agents/runner.mjs';
import * as login from './agents/login.mjs';
import { forward } from './llmproxy.mjs';
import * as files from './files.mjs';
import * as jobs from './agents/jobs.mjs';
import * as sessions from './agents/sessions.mjs';
import * as tex from './tex.mjs';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const STATIC_TOP = new Set(['index.html', 'js', 'css', 'assets']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.map': 'application/json', '.bin': 'application/octet-stream', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.md': 'text/markdown; charset=utf-8', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.csv': 'text/csv; charset=utf-8', '.yaml': 'text/yaml; charset=utf-8', '.yml': 'text/yaml; charset=utf-8', '.tex': 'text/x-tex; charset=utf-8', '.jsonl': 'application/jsonl' };
const LIMIT = { json: 256 * 1024 * 1024, media: 2 * 1024 * 1024 * 1024 };

/** Start the server. `dir`: the folder the app was started in (a project, or where a new one should go). */
export async function startServer({ dir = null, port = 8790, token = newToken(), editorDir, watch = true, quiet = false, allowHosts = [], texEngine } = {}) {
  const texInfo = () => (texEngine !== undefined ? texEngine : tex.findTex());
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
  const guard = createGuard({ token, port: bound, allowHosts });
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
    const info = { version: PKG.version, editor: !!editor, tex: texInfo()?.engine || null, projectsRoot: config.projectsRoot(), pendingDir: session.pendingDir, openId: session.openId, home: os.homedir() };
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
    // the editor build ships pre-compressed files (x2t.wasm.br) and extension-less fonts (fonts/NNN)
    const br = kind === 'editor' && abs.endsWith('.br'); const name = br ? abs.slice(0, -3) : abs;
    const type = MIME[path.extname(name).toLowerCase()] || (kind === 'editor' && /^fonts\/\w+$/.test(rel) ? 'font/ttf' : 'application/octet-stream');
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const h = { 'Content-Type': type, 'Content-Length': st.size, ETag: etag, 'Cache-Control': kind === 'editor' && /\/(assets|fonts)\/|\.br$/.test(abs) ? 'public, max-age=31536000, immutable' : 'no-cache', ...headersFor(kind) };
    if (br) h['Content-Encoding'] = 'br';
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
    if (p === '/api/projects/open' && m === 'POST') { // a course folder opens; any other folder comes back described, to be opened as a course (adopt)
      const d = checkDir((await body(req)).dir);
      if (isProjectDir(d)) return send(res, 200, await projects.load(projects.open(d).id));
      return send(res, 200, { folder: folders.inspect(d) });
    }
    if (p === '/api/projects/adopt' && m === 'POST') { const b = await body(req); const r = await projects.adopt(b.project, b.dir); if (r.dir === session.pendingDir) session.pendingDir = null; return send(res, 200, r); }
    if (p === '/api/projects/import' && m === 'POST') { const b = await body(req); return send(res, 200, await projects.importJson(b.json, b.dir, { source: b.name || 'project.json' })); }
    if (p === '/api/fs/dirs' && m === 'GET') return send(res, 200, browse(url.searchParams.get('path')));
    if (p === '/api/llm') return forward(req, res);
    if (p === '/api/agents/health' && m === 'GET') return send(res, 200, { ...agents.health(), login: login.state() });
    if (p === '/api/agents/login' && m === 'POST') { // the CLI opens a browser here and waits on localhost, so the page must be on this computer too
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) throw new HttpError(400, 'Sign in from a terminal on the computer running the app');
      return send(res, 202, login.start((await body(req)).agent, broadcast));
    }
    if (p === '/api/agents/login/cancel' && m === 'POST') return send(res, 200, { cancelled: login.cancel() });
    if (p === '/api/agents/cancel' && m === 'POST') return send(res, 200, { cancelled: agents.cancel() });
    if (p === '/api/agents/revise' && m === 'POST') return revise(req, res);
    if ((g = p.match(/^\/api\/projects\/([\w-]+)$/))) {
      const id = g[1];
      if (m === 'GET') return send(res, 200, await projects.load(id));
      if (m === 'PUT') { const b = await body(req); return send(res, 200, await projects.save(id, b.project, b.base, typeof b.message === 'string' && /^(import|edit|gen): /.test(b.message) ? { message: b.message.slice(0, 300) } : {})); }
      if (m === 'DELETE') { projects.forget(id); return send(res, 204); }
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/duplicate$/)) && m === 'POST') return send(res, 200, await projects.duplicate(g[1]));
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/log$/)) && m === 'GET') return send(res, 200, { log: await vcs.log(projects.state(g[1]).dir) });
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/media$/)) && m === 'GET') return send(res, 200, { keys: media.keys(projects.state(g[1]).dir) });
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/media\/([^/]+)$/))) {
      const s = projects.state(g[1]); const key = g[2];
      if (m === 'GET') {
        const fallback = (ch, sha, ext) => { // a fresh clone has no .studio/decks: the chapter's slides.pptx (homework.docx…) may be that version
          const stages = JSON.parse(fs.readFileSync(path.join(s.dir, '.studio/meta.json'), 'utf8')).stages || {};
          for (const [k, m] of Object.entries(stages)) {
            if (!k.startsWith(`chapters.${ch}.`) || !m.$deck?.endsWith(`.${ext}`)) continue;
            let b; try { b = fs.readFileSync(resolveInside(s.dir, m.$deck)); } catch { continue; }
            if (sha256(b) === sha) return b;
          }
          return null;
        };
        const out = media.get(s.dir, key, fallback); if (!out) return send(res, 404, { error: 'No such media' });
        res.writeHead(200, { 'Content-Type': 'application/x-ia-bundle', 'Content-Length': out.length, 'Cache-Control': 'no-store' }); return res.end(out);
      }
      if (m === 'PUT') { media.put(s.dir, key, await raw(req, LIMIT.media)); return send(res, 204); }
      if (m === 'DELETE') { media.del(s.dir, key); return send(res, 204); }
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/files\/(.+)$/))) {
      const id = g[1], rel = g[2];
      if (m === 'GET') { // read one file of the project (raw); its sha-256 is the version a later write is based on
        const s = projects.state(id); const abs = resolveInside(s.dir, rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'No such file' });
        const buf = fs.readFileSync(abs); res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ETag: `"${sha256(buf)}"` }); return res.end(buf);
      }
      if (m === 'PUT') { // write a plain file: ?base=<sha-256 read before> refuses when it changed since; ?base=new refuses when it exists
        const data = await raw(req, LIMIT.media); const base = url.searchParams.get('base');
        return send(res, 200, await projects.fileOp(id, s => {
          files.checkWritable(s.dir, rel);
          const abs = resolveInside(s.dir, rel); const exists = fs.existsSync(abs);
          if (exists && fs.statSync(abs).isDirectory()) throw new HttpError(409, 'A folder has that name');
          if (base === 'new' && exists) throw new HttpError(409, `${rel} already exists`, { exists: true });
          if (base && base !== 'new' && exists) { const cur = sha256(fs.readFileSync(abs)); if (cur !== base) throw new HttpError(409, 'The file changed on disk', { sha: cur }); }
          writeFile(s.dir, rel, data);
          return { added: [rel], message: `${url.searchParams.get('kind') === 'import' ? 'import' : 'edit'}: ${rel}`, result: { sha: sha256(data) } };
        }));
      }
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/history\/(.+)$/)) && m === 'GET') return send(res, 200, { commits: await vcs.fileLog(projects.state(g[1]).dir, g[2]) });
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/at\/([0-9a-f]{40})\/(.+)$/)) && m === 'GET') { // a file as it was in a commit
      const s = projects.state(g[1]); resolveInside(s.dir, g[3]);
      const buf = await vcs.readAt(s.dir, g[2], g[3]); if (!buf) return send(res, 404, { error: 'Not in that version' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(g[3]).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ETag: `"${sha256(buf)}"` }); return res.end(buf);
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/restore$/)) && m === 'POST') { // a plain file back to a commit's version, as a new commit
      const b = await body(req); if (typeof b.path !== 'string' || !/^[0-9a-f]{40}$/.test(b.oid || '')) throw new HttpError(400, 'Bad request');
      return send(res, 200, await projects.fileOp(g[1], async s => {
        files.checkWritable(s.dir, b.path);
        const buf = await vcs.readAt(s.dir, b.oid, b.path); if (!buf) throw new HttpError(404, 'Not in that version');
        writeFile(s.dir, b.path, buf);
        return { added: [b.path], message: `edit: restore ${b.path} @${b.oid.slice(0, 7)}`, result: { sha: sha256(buf) } };
      }));
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/tex$/)) && m === 'POST') { // compile a .tex file into build/
      const b = await body(req); const s = projects.state(g[1]);
      if (typeof b.path !== 'string') throw new HttpError(400, 'Bad path');
      try { return send(res, 200, await tex.compile(s.dir, b.path, { tex: texInfo() })); } catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/sources$/)) && m === 'POST') { // course materials dropped in: sources/<path>, one commit
      const list = files.readSources(await raw(req, LIMIT.media));
      return send(res, 200, await projects.fileOp(g[1], s => { const added = files.writeSources(s.dir, list); return { added, message: files.sourcesMessage(added), result: { paths: added } }; }));
    }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/agent(\/.*)?$/))) return agentApi(req, res, g[1], g[2] || '', m);
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/tree$/)) && m === 'GET') { const s = projects.state(g[1]); return send(res, 200, { entries: files.tree(s.dir), managed: [...files.managed(s.dir)] }); }
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/search$/)) && m === 'GET') return send(res, 200, { matches: files.search(projects.state(g[1]).dir, url.searchParams.get('q')) });
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/vcs$/)) && m === 'GET') return send(res, 200, await vcs.summary(projects.state(g[1]).dir));
    if ((g = p.match(/^\/api\/projects\/([\w-]+)\/fs\/(mkdir|rename|delete)$/)) && m === 'POST') {
      const b = await body(req); const op = g[2];
      return send(res, 200, await projects.fileOp(g[1], s => {
        if (op === 'mkdir') { files.mkdir(s.dir, b.path); return { result: { path: b.path } }; }
        if (op === 'rename') { const moved = files.rename(s.dir, b.from, b.to); return { removed: moved.map(x => x[0]), added: moved.map(x => x[1]), message: `edit: rename ${b.from} → ${b.to}`, result: { path: b.to } }; }
        const t = files.trash(s.dir, b.path); return { removed: t.files, message: `edit: delete ${b.path}`, result: { trashed: t.trashed } };
      }));
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

  // ---------------------------------------------------------------- the agent panel
  async function agentApi(req, res, id, sub, m) {
    const s = projects.state(id); let g;
    const managed = () => files.managed(s.dir);
    if (sub === '' && m === 'GET') { const a = agents.health().agents; return send(res, 200, { agents: a, running: jobs.runningOf(id), login: login.state() }); }
    if (sub === '/sessions' && m === 'GET') return send(res, 200, { sessions: sessions.list(s.dir) });
    if (sub === '/sessions' && m === 'POST') return send(res, 200, sessions.create(s.dir, await body(req)));
    if (sub === '/cancel' && m === 'POST') return send(res, 200, { cancelled: jobs.cancel(id) });
    if (sub === '/apply' && m === 'POST') {
      const b = await body(req); const mg = managed();
      const list = [...(b.files || []).map(f => f?.path), ...(b.removed || [])];
      for (const rel of list) {
        if (typeof rel !== 'string') throw new HttpError(400, 'Bad path');
        resolveInside(s.dir, rel);
        const why = jobs.rejectReason(rel, mg, sourcesOf(s.dir)); if (why) throw new HttpError(403, `${rel}: ${why}`);
        if (mg.has(rel)) throw new HttpError(409, `${rel} belongs to a stage: send it as part of the project`);
      }
      const r = await projects.applyAgent(id, { project: b.project || null, base: b.base || null, files: b.files || [], removed: b.removed || [], message: String(b.message || 'agent: changes').slice(0, 300) });
      if (b.session && /^[a-z0-9]+$/.test(b.session)) jobs.discard(s.dir, b.session);
      return send(res, 200, r);
    }
    if (sub === '/undo' && m === 'POST') { const b = await body(req); if (!/^[0-9a-f]{40}$/.test(b.oid || '')) throw new HttpError(400, 'Bad commit'); return send(res, 200, await projects.undoAgent(id, b.oid)); }
    if ((g = sub.match(/^\/sessions\/([a-z0-9]+)(\/.*)?$/))) {
      const sid = g[1], rest = g[2] || '';
      if (rest === '' && m === 'GET') { const x = sessions.get(s.dir, sid); const r = jobs.runningOf(id); return send(res, 200, { ...x, running: r?.session === sid, pending: r?.session === sid ? null : jobs.pending(s.dir, sid, { managed: managed() }) }); }
      if (rest === '' && m === 'PUT') return send(res, 200, sessions.put(s.dir, sid, await body(req)));
      if (rest === '' && m === 'DELETE') { if (jobs.runningOf(id)?.session === sid) throw new HttpError(409, 'Stop the agent first'); jobs.discard(s.dir, sid); sessions.remove(s.dir, sid); return send(res, 204); }
      if (rest === '/run' && m === 'POST') {
        const b = await body(req);
        if (typeof b.message !== 'string' || !b.message.trim()) throw new HttpError(400, 'Write a message');
        const context = (Array.isArray(b.context) ? b.context : []).filter(c => c && typeof c.path === 'string').map(c => ({ path: c.path, label: String(c.label || ''), slides: Array.isArray(c.slides) ? c.slides.filter(Number.isInteger) : undefined, paragraphs: Array.isArray(c.paragraphs) ? c.paragraphs.filter(Number.isInteger) : undefined, lines: Array.isArray(c.lines) ? c.lines.slice(0, 2).map(Number) : undefined, text: typeof c.text === 'string' ? c.text : undefined }));
        const scope = (Array.isArray(b.scope) ? b.scope : context.map(c => c.path)).filter(x => typeof x === 'string').slice(0, 50);
        const emit = ev => broadcast({ type: 'agent', id, ev });
        const r = await jobs.run({ id, root: s.dir, session: sid, message: b.message, context, scope, managed, emit });
        r.done.catch(e => emit({ type: 'done', session: sid, error: e.message, changes: [] }));
        return send(res, 202, { session: sid, agent: r.agent });
      }
      if (rest === '/discard' && m === 'POST') { if (jobs.runningOf(id)?.session === sid) throw new HttpError(409, 'Stop the agent first'); jobs.discard(s.dir, sid); return send(res, 204); }
      if ((g = rest.match(/^\/file\/(.+)$/)) && m === 'GET') {
        let buf; try { buf = jobs.readJobFile(s.dir, sid, g[1]); } catch (e) { if (e.code === 'ENOENT') return send(res, 404, { error: 'No such file' }); throw e; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(g[1]).toLowerCase()] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ETag: `"${sha256(buf)}"` }); return res.end(buf);
      }
    }
    return send(res, 404, { error: 'Not found' });
  }

  const origin = `http://127.0.0.1:${bound}`;
  const startUrl = `${origin}/?token=${token}${session.openId ? `#/p/${session.openId}/overview` : '#/projects'}`;
  if (!quiet) console.log(`Instructional Agents ${PKG.version} on ${origin}${editor ? ` (editor: ${editor.dir})` : ' (editor: https://edit.chaxus.com)'}`);
  return {
    server, port: bound, origin, token, url: startUrl, projects, editor,
    async close() { agents.cancel('server stopped'); jobs.cancelAll('server stopped'); login.cancel('server stopped'); for (const c of clients) c.terminate(); wss.close(); await projects.close(); await new Promise(r => server.close(r)); },
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
