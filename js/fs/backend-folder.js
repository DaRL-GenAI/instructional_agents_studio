// fs/backend-folder.js — the local app's storage: each project is a folder on disk, read and written by the local
// server (server/projects.mjs). Writes carry the git head they were based on; a stale one is refused (409) and merged
// here three-way (fs/merge.js) before writing again.
import { api, LOCAL } from './api.js';
import { encodeBundle, decodeBundle } from './bundle.js';
import { merge3, adoptInPlace, changedUnits } from './merge.js';

const heads = new Map();   // project id → git head the browser copy is based on
const bases = new Map();   // project id → that commit's project (JSON), the base of a three-way merge
const external = new Map(); // project id → decks changed on disk, waiting to be committed by the app
export const dirs = new Map(); // project id → folder
const P = id => `/api/projects/${encodeURIComponent(id)}`;
const M = (pid, ch, kind) => `${P(pid)}/media/${encodeURIComponent(`${ch}:${kind}`)}`;
const took = r => { heads.set(r.project.id, r.head); bases.set(r.project.id, JSON.stringify(r.project)); if (r.dir) dirs.set(r.project.id, r.dir); external.set(r.project.id, r.external || []); return r.project; };

export const folderBackend = {
  kind: 'folder',
  async list() { const r = await api('/api/projects'); for (const x of r.projects) dirs.set(x.project.id, x.dir); return r.projects.map(x => x.project); },
  async get(id) { try { return took(await api(P(id))); } catch (e) { if (e.status === 404) return null; throw e; } },
  /** Save; when the folder moved on (409) merge the disk version in, adopt it in place and save again.
   *  Resolves to the number of units taken from disk (the caller re-renders when > 0). */
  async put(p, { message, tries = 3 } = {}) {
    const sent = JSON.stringify(p);
    try { const r = await api(P(p.id), { method: 'PUT', body: { project: JSON.parse(sent), base: heads.get(p.id) || null, ...(message ? { message } : {}) } }); heads.set(p.id, r.head); bases.set(p.id, sent); return 0; }
    catch (e) {
      if (!e.conflict || !e.body?.project || tries <= 1) throw e;
      const theirs = e.body.project, ours = JSON.parse(sent);
      const merged = merge3(bases.has(p.id) ? JSON.parse(bases.get(p.id)) : theirs, theirs, ours);
      heads.set(p.id, e.body.head); bases.set(p.id, JSON.stringify(theirs));
      // take only what came from disk: edits made in the browser since the request went out stay
      const n = adoptInPlace(p, merged, changedUnits(ours, merged));
      return n + await this.put(p, { message, tries: tries - 1 });
    }
  },
  /** Pull the folder's current state into the live project (after a change on disk). Returns units changed. */
  async sync(p) {
    const r = await api(P(p.id)); if (r.head === heads.get(p.id)) return 0;
    const live = JSON.parse(JSON.stringify(p));
    const merged = merge3(bases.has(p.id) ? JSON.parse(bases.get(p.id)) : r.project, r.project, live);
    heads.set(p.id, r.head); bases.set(p.id, JSON.stringify(r.project)); external.set(p.id, r.external || []);
    return adoptInPlace(p, merged);
  },
  async create(p, { dir } = {}) { return took(await api('/api/projects', { method: 'POST', body: { project: p, dir } })); },
  async remove(id) { await api(P(id), { method: 'DELETE' }); heads.delete(id); },
  async duplicate(id) { return took(await api(`${P(id)}/duplicate`, { method: 'POST' })); },
  async import(json, { dir } = {}) { return took(await api('/api/projects/import', { method: 'POST', body: { json, dir } })); },
  async open(dir) { return took(await api('/api/projects/open', { method: 'POST', body: { dir } })); },
  /** Reviewed agent changes as one commit: the project (stage files) plus plain files { path, data: base64 } and
   *  removed plain files. */
  async applyAgent(p, { files = [], removed = [], message, session } = {}) {
    const sent = JSON.stringify(p);
    const r = await api(`${P(p.id)}/agent/apply`, { method: 'POST', body: { project: JSON.parse(sent), base: heads.get(p.id) || null, files, removed, message, session } });
    heads.set(p.id, r.head); bases.set(p.id, sent); return r;
  },
  /** Files dropped in as course materials → sources/<path>, one commit. files: [{ path, blob }]. */
  async importSources(id, files) {
    const r = await api(`${P(id)}/sources`, { method: 'POST', body: encodeBundle({ files: files.map(f => ({ path: f.path, data: f.blob })) }), headers: { 'Content-Type': 'application/x-ia-bundle' } });
    return r;
  },
  externalDecks: id => external.get(id) || [],
  head: id => heads.get(id),
  async getMedia(pid, ch, kind) {
    let r; try { r = await api(M(pid, ch, kind), { raw: true }); } catch (e) { if (e.status === 404) return undefined; throw e; }
    return decodeBundle(await r.arrayBuffer());
  },
  async putMedia(pid, ch, kind, v) { await api(M(pid, ch, kind), { method: 'PUT', body: encodeBundle(v), headers: { 'Content-Type': 'application/x-ia-bundle' } }); },
  async delMedia(pid, ch, kind) { await api(M(pid, ch, kind), { method: 'DELETE' }); },
  async mediaKeys(pid) { return (await api(`${P(pid)}/media`)).keys.map(k => `${pid}:${k}`); },
  getSettings: () => api('/api/settings'),
  putSettings: s => api('/api/settings', { method: 'PUT', body: s }),
  browse: path => api(`/api/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  info: () => LOCAL,
};
