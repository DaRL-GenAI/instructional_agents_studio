// projects.mjs — course projects as folders: load (folder → project), save (project → changed files → one git
// commit), create / import / duplicate, and the watcher that turns edits made outside the app (VS Code, PowerPoint,
// an agent) into commits and change events.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { serialize, deserialize, fileOwner, stageAt, fnv, slugify, binaryOf, META } from '../js/fs/serialize.js';
import { migrate, uid } from '../js/model.js';
import { readText, readBuf, writeFile, removeFile, sha256 } from './workspace.mjs';
import * as vcs from './vcs.mjs';
import * as media from './media.mjs';
import * as config from './config.mjs';

export class HttpError extends Error { constructor(status, message, body) { super(message); this.status = status; this.body = body; } }

/** Folders the app may create or open projects in: the home directory and the temp directory (IA_ALLOW_ROOTS adds more). */
export function allowedRoots() {
  const extra = (process.env.IA_ALLOW_ROOTS || '').split(path.delimiter).filter(Boolean);
  return [os.homedir(), os.tmpdir(), ...extra].map(p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
}
export function checkDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new HttpError(400, 'Choose a folder');
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  let probe = abs; while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync(probe), path.relative(probe, abs));
  if (!allowedRoots().some(r => real === r || real.startsWith(r + path.sep))) throw new HttpError(403, 'Projects must live inside your home folder');
  return real;
}
export const isProjectDir = dir => fs.existsSync(path.join(dir, META));

const COMMIT_KIND = e => e.type === 'slide_revision' && /claude|codex/i.test(e.agent || '') ? 'agent' : e.type === 'import' ? 'import' : ['stage_done', 'auto_repair'].includes(e.type) ? 'gen' : 'edit';
const RANK = { agent: 3, import: 2, gen: 1, edit: 0 };
const IGNORED = /(^|\/)(\.git|node_modules|build|\.studio\/(decks|jobs|trash|backup))(\/|$)|\.tmp$|~$|\.swp$/;

export class Projects {
  constructor({ onChange = () => {}, watch = true } = {}) { this.byId = new Map(); this.onChange = onChange; this.watch = watch; }

  /** The state of an opened project folder (read once, then cached). */
  open(dir, { watch = this.watch } = {}) {
    dir = fs.realpathSync(dir);
    for (const s of this.byId.values()) if (s.dir === dir) return s;
    const meta = JSON.parse(readText(dir, META) || 'null'); if (!meta?.project?.id) throw new HttpError(400, `${dir} is not an Instructional Agents project`);
    const s = { id: meta.project.id, dir, head: null, written: new Map(), removed: new Set(), uncommitted: new Set(), lock: Promise.resolve(), auditLen: 0, pending: new Set(), timer: null, watcher: null };
    // what the app last wrote = what is on disk now; decks: the sha the manifest names
    const project = Object.values(meta.stages || {}).some(m => m.$deck) ? this.read(dir) : null;
    for (const [key, m] of Object.entries(meta.stages || {})) if (m.$deck) { const sha = binaryOf(stageAt(project, key)?.output)?.sha; if (sha) s.written.set(m.$deck, sha); }
    s.auditLen = (readText(dir, '.studio/audit.jsonl') || '').split('\n').filter(Boolean).length;
    this.byId.set(s.id, s);
    config.remember({ id: s.id, dir, name: meta.project.name });
    if (watch) this.startWatch(s);
    return s;
  }
  state(id) {
    const s = this.byId.get(id); if (s) return s;
    const dir = config.dirOf(id); if (!dir || !isProjectDir(dir)) throw new HttpError(404, 'Project not found');
    return this.open(dir);
  }
  read(dir, opts) { return migrate(deserialize(p => readText(dir, p), opts)); }
  /** Serialize work on one project (saves, external edits). */
  locked(s, fn) { const run = s.lock.then(fn, fn); s.lock = run.catch(() => {}); return run; }

  async load(id, { light = false } = {}) {
    const s = this.state(id); s.head ??= await vcs.head(s.dir);
    const project = this.read(s.dir, { light });
    return { project, head: s.head, dir: s.dir, external: light ? [] : this.externalDecks(s, project) };
  }

  /** Decks (and Word documents of stages) replaced on disk that the app has not committed as a version yet:
   *  [{ chapterId, stageId, format, sha, path }]. */
  externalDecks(s, project) {
    const out = [], meta = JSON.parse(readText(s.dir, META));
    for (const [key, m] of Object.entries(meta.stages || {})) {
      if (!m.$deck) continue;
      const [, chapterId, stageId] = key.split('.'); const want = binaryOf(stageAt(project, key)?.output); const buf = readBuf(s.dir, m.$deck);
      if (!buf || !want) continue;
      const sha = sha256(buf); if (sha === want.sha) continue;
      if (!media.deckFile(s.dir, chapterId, sha, want.format)) media.storeDeckFile(s.dir, chapterId, buf, want.format);
      out.push({ chapterId, stageId, format: want.format, sha, path: m.$deck });
    }
    return out;
  }

  list() {
    const out = [];
    for (const r of config.recent()) {
      if (!isProjectDir(r.dir)) continue;
      try { const s = this.open(r.dir); out.push({ project: this.read(s.dir, { light: true }), dir: s.dir }); } catch (e) { console.warn(`skipping ${r.dir}: ${e.message}`); }
    }
    return out;
  }

  /** Write the project; `base` is the head the browser's copy came from (stale → 409 with the current project). */
  save(id, project, base, opts = {}) {
    const s = this.state(id);
    return this.locked(s, async () => {
      s.head ??= await vcs.head(s.dir);
      if (base && s.head && base !== s.head) throw new HttpError(409, 'The project changed on disk', { head: s.head, project: this.read(s.dir) });
      return this.write(s, project, opts);
    });
  }

  async write(s, project, { message, extra = [], commit = true } = {}) {
    if (project.id !== s.id) throw new HttpError(400, 'Project id mismatch');
    const prevMeta = JSON.parse(readText(s.dir, META) || '{}');
    const { files, decks } = serialize(project); const changed = [...extra];
    for (const [f, text] of Object.entries(files)) {
      const h = sha256(text); if (s.written.get(f) === h && readText(s.dir, f) === text) continue;
      if (readText(s.dir, f) !== text) { writeFile(s.dir, f, text); changed.push(f); }
      s.written.set(f, h);
    }
    for (const [f, { chapterId, sha, format }] of Object.entries(decks)) {
      const disk = readBuf(s.dir, f); const dsha = disk && sha256(disk);
      if (dsha === sha) { s.written.set(f, sha); continue; }
      if (disk && dsha !== s.written.get(f)) continue; // replaced on disk and not adopted yet: keep the user's file
      const src = media.deckFile(s.dir, chapterId, sha, format); if (!src) continue;
      writeFile(s.dir, f, src); s.written.set(f, sha); changed.push(f);
    }
    const now = new Set([...Object.keys(files), ...Object.keys(decks)]);
    for (const f of prevMeta.files || []) if (!now.has(f) && f !== META) { s.removed.add(f); removeFile(s.dir, f); s.written.delete(f); changed.push(f); }
    if (!changed.length || !commit) return { head: s.head };
    const fresh = (project.audit || []).slice(s.auditLen);
    // bookkeeping only (a stage marked running, a model call started): on disk now, committed with the next change
    if (fresh.every(e => e.type === 'llm_call') && !message && changed.every(f => f.startsWith('.studio/'))) { for (const f of changed) s.uncommitted.add(f); return { head: s.head }; }
    changed.unshift(...[...s.uncommitted].filter(f => !changed.includes(f))); s.uncommitted.clear();
    const kind = fresh.map(COMMIT_KIND).reduce((a, k) => RANK[k] > RANK[a] ? k : a, 'edit');
    const shown = changed.filter(f => !f.startsWith('.studio/')); const first = shown[0] || changed[0];
    const msg = message || `${kind}: ${first}${changed.length > 1 ? ` (+${changed.length - 1})` : ''}`;
    s.head = await vcs.commit(s.dir, changed, msg); s.auditLen = (project.audit || []).length;
    this.onChange({ type: 'changed', id: s.id, head: s.head, paths: changed, source: 'app' });
    return { head: s.head };
  }

  /** A Workspace file operation: fn(s) changes files on disk and returns { added: [paths], removed: [paths], message }.
   *  Runs under the project's lock, tells the watcher these changes are ours, and commits them as one commit. */
  fileOp(id, fn) {
    const s = this.state(id);
    return this.locked(s, async () => {
      s.head ??= await vcs.head(s.dir);
      const { added = [], removed = [], message, result } = await fn(s);
      for (const f of added) { const b = readBuf(s.dir, f); if (b) s.written.set(f, sha256(b)); }
      for (const f of removed) { s.removed.add(f); s.written.delete(f); }
      const paths = [...added, ...removed];
      if (paths.length) {
        const before = s.head; s.head = await vcs.commit(s.dir, paths, message);
        this.onChange({ type: 'changed', id: s.id, head: s.head, paths, source: 'app', committed: s.head !== before });
      }
      return { head: s.head, ...result };
    });
  }

  // ---------------------------------------------------------------- new folders
  async create(project, dir, { message } = {}) {
    dir = dir ? checkDir(dir) : uniqueDir(path.join(checkDir(config.projectsRoot()), slugify(project.name) || 'course'));
    if (isProjectDir(dir)) throw new HttpError(409, `${dir} already holds a course`);
    fs.mkdirSync(dir, { recursive: true });
    await vcs.init(dir);
    writeFile(dir, META, JSON.stringify({ format: 'instructional-agents', version: 1, project: { id: project.id, name: project.name } })); // placeholder so open() works
    const s = this.open(dir, { watch: false });
    await this.locked(s, async () => { await this.write(s, project, { commit: false }); s.head = await vcs.commitAll(dir, message || `init: ${project.name}`); s.auditLen = (project.audit || []).length; });
    if (this.watch) { this.startWatch(s); await s.ready; }
    return this.load(s.id);
  }

  /** A project JSON exported from Studio (with its decks inside) → a new folder. The original file is kept in
   *  .studio/backup/. */
  async importJson(json, dir, { source = 'project.json' } = {}) {
    let p; try { p = migrate(JSON.parse(json)); } catch { throw new HttpError(400, 'Not a Studio project file'); }
    if (!p?.course) throw new HttpError(400, 'Not a Studio project file');
    p.id = 'prj_' + uid(); p.updatedAt = new Date().toISOString();
    const decks = p.decks || {}; delete p.decks;
    const target = dir ? checkDir(dir) : uniqueDir(path.join(checkDir(config.projectsRoot()), slugify(p.name) || 'course'));
    if (isProjectDir(target)) throw new HttpError(409, `${target} already holds a course`);
    fs.mkdirSync(target, { recursive: true });
    writeFile(target, `.studio/backup/${path.basename(source).replace(/[^\w.-]+/g, '_')}`, json);
    for (const [chId, d] of Object.entries(decks)) if (d?.data && /^[A-Za-z0-9_-]+$/.test(chId)) media.storeDeckFile(target, chId, Buffer.from(d.data, 'base64'));
    for (const [chId, list] of Object.entries(p.docs || {})) if (Array.isArray(list) && /^[A-Za-z0-9_-]+$/.test(chId)) for (const d of list) if (d?.data) media.storeDeckFile(target, chId, Buffer.from(d.data, 'base64'), 'docx');
    delete p.docs;
    return this.create(p, target, { message: `import: ${path.basename(source)}` });
  }

  async duplicate(id) {
    const s = this.state(id); const src = this.read(s.dir);
    const dir = uniqueDir(`${s.dir}-copy`);
    fs.cpSync(s.dir, dir, { recursive: true, filter: f => !/[\\/](\.git|\.studio[\\/]jobs)$/.test(f) });
    const copy = JSON.parse(JSON.stringify(src)); copy.id = 'prj_' + uid(); copy.name = `${src.name} (copy)`; copy.course.name = copy.name; copy.createdAt = copy.updatedAt = new Date().toISOString();
    copy.audit = [{ id: 1, ts: copy.createdAt, type: 'project', note: `duplicated from ${src.name}` }];
    fs.rmSync(path.join(dir, META)); // create() writes the new one
    return this.create(copy, dir, { message: `init: duplicate of ${src.name}` });
  }

  forget(id) { const s = this.byId.get(id); s?.watcher?.close(); this.byId.delete(id); config.forget(id); }
  async close() { for (const s of this.byId.values()) await s.watcher?.close(); }

  // ---------------------------------------------------------------- edits made outside the app
  startWatch(s) {
    s.watcher = chokidar.watch(s.dir, { ignoreInitial: true, ignored: p => IGNORED.test(path.relative(s.dir, p).split(path.sep).join('/')), awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    const on = (ev, abs) => {
      const rel = path.relative(s.dir, abs).split(path.sep).join('/'); if (!rel || IGNORED.test(rel)) return;
      if (ev !== 'unlink') { let buf; try { buf = fs.readFileSync(abs); } catch { return; } if (s.written.get(rel) === sha256(buf) || s.written.get(rel) === sha256(buf.toString('utf8'))) return; }
      else if (s.removed.delete(rel)) return;
      s.pending.add(rel); clearTimeout(s.timer); s.timer = setTimeout(() => this.adoptExternal(s).catch(e => console.warn('external change:', e.message)), 250);
    };
    for (const ev of ['add', 'change', 'unlink']) s.watcher.on(ev, abs => on(ev, abs));
    s.ready = new Promise(r => s.watcher.on('ready', r));
  }

  adoptExternal(s) {
    const paths = [...s.pending]; s.pending.clear(); if (!paths.length) return Promise.resolve();
    return this.locked(s, async () => {
      s.head ??= await vcs.head(s.dir);
      const metaText = readText(s.dir, META); if (!metaText) return;
      const meta = JSON.parse(metaText); const project = this.read(s.dir);
      let edits = 0;
      for (const f of paths) {
        const own = fileOwner(meta, f); if (own?.kind !== 'text') continue;
        const st = stageAt(project, own.key); const m = meta.stages[own.key]; if (!st) continue;
        const text = st.output || ''; if (fnv(text) === m.$hash) continue;
        const old = (await vcs.readAt(s.dir, s.head, f))?.toString('utf8') ?? '';
        st.history ||= []; st.history.push({ version: st.version, output: old, at: st.ranAt, reason: st.edited ? 'user edit' : 'model output' });
        if (st.history.length > 10) st.history.shift();
        Object.assign(st, { version: (st.version || 0) + 1, edited: true, status: 'done', error: null, outputHash: fnv(text) });
        const [, a, b] = own.key.split('.'); const ch = own.key.startsWith('chapters.') ? project.chapters.find(c => c.id === a) : null;
        project.audit ||= [];
        project.audit.push({ id: (project.audit.at(-1)?.id || 0) + 1, ts: new Date().toISOString(), type: 'edit', stage: ch ? b : (a || own.key), where: ch ? ch.title : 'course', note: `edited on disk: ${f}`, chars: text.length, version: st.version, hash: st.outputHash });
        edits++;
      }
      if (edits) project.updatedAt = new Date().toISOString();
      for (const f of paths) { const b = readBuf(s.dir, f); if (b) s.written.set(f, sha256(b)); }
      await this.write(s, project, { message: `edit: ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ''} (on disk)`, extra: paths });
      this.onChange({ type: 'changed', id: s.id, head: s.head, paths, source: 'disk' });
    });
  }
}

function uniqueDir(base) { let d = base, i = 2; while (fs.existsSync(d) && fs.readdirSync(d).length) d = `${base}-${i++}`; return d; }
