// ws/source.js — where the Workspace's files come from.
//   local:   the project folder, through the local server (list, read, write plain files, create, rename, trash).
//   virtual: the browser edition (IndexedDB) has no folder; the tree is the layout serialize.js would write, and
//            only the stages' own files exist (read-only except through their stage).
import { api, LOCAL } from '../fs/api.js';
import { backend } from '../fs/backend.js';
import { layout } from './stages.js';
import { binaryOf, BINARY } from '../fs/serialize.js';

export async function shaHex(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const enc = path => path.split('/').map(encodeURIComponent).join('/');
const TYPES = { pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
export const typeOf = path => TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';

export function makeSource(store) { return LOCAL ? localSource(store) : virtualSource(store); }

function localSource(store) {
  const P = `/api/projects/${encodeURIComponent(store.id)}`;
  return {
    kind: 'local', writable: true,
    async list() { const r = await api(`${P}/tree`); return { entries: r.entries, managed: new Set(r.managed) }; },
    /** → { blob, sha } or null when the file does not exist. */
    async read(path) {
      let r; try { r = await api(`${P}/files/${enc(path)}`, { raw: true }); } catch (e) { if (e.status === 404) return null; throw e; }
      const blob = await r.blob(); const etag = (r.headers.get('ETag') || '').replace(/"/g, '');
      return { blob: new Blob([blob], { type: typeOf(path) }), sha: etag || await shaHex(blob) };
    },
    /** Write a plain file. base: the sha read before (409 when the disk moved on) or 'new' (409 when it exists). */
    async write(path, data, { base, kind } = {}) {
      const q = new URLSearchParams(); if (base) q.set('base', base); if (kind) q.set('kind', kind);
      const body = data instanceof Blob ? data : new Blob([data]);
      return api(`${P}/files/${enc(path)}${q.size ? `?${q}` : ''}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    mkdir: path => api(`${P}/fs/mkdir`, { method: 'POST', body: { path } }),
    rename: (from, to) => api(`${P}/fs/rename`, { method: 'POST', body: { from, to } }),
    remove: path => api(`${P}/fs/delete`, { method: 'POST', body: { path } }),
    async search(q) { return (await api(`${P}/search?q=${encodeURIComponent(q)}`)).matches; },
    vcs: () => api(`${P}/vcs`).catch(() => null),
    log: () => api(`${P}/log`).then(r => r.log).catch(() => []),
  };
}

function virtualSource(store) {
  const files = () => layout(store.project);
  return {
    kind: 'virtual', writable: false,
    async list() {
      const { files: f, decks } = files(); const paths = [...Object.keys(f), ...Object.keys(decks)];
      const dirs = new Set(); for (const p of paths) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
      const entries = [...[...dirs].map(path => ({ path, dir: true })), ...Object.entries(f).map(([path, t]) => ({ path, dir: false, size: t.length })), ...Object.keys(decks).map(path => ({ path, dir: false }))];
      return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), managed: new Set(paths) };
    },
    async read(path) {
      const { files: f, decks } = files();
      if (path in f) return { blob: new Blob([f[path]], { type: 'text/plain' }), sha: await shaHex(f[path]) };
      const d = decks[path]; if (!d) return null;
      const blob = await backend.getMedia(store.id, d.chapterId, `${BINARY[d.format || 'pptx']}:${d.sha}`);
      return blob ? { blob: new Blob([blob], { type: typeOf(path) }), sha: d.sha } : null;
    },
    async search(q) {
      const needle = q.toLowerCase(); const out = [];
      for (const [path, text] of Object.entries(files().files)) {
        if (path.startsWith('.studio/stages/')) continue;
        if (path.toLowerCase().includes(needle)) out.push({ path, line: 0, text: '' });
        text.split('\n').forEach((l, i) => { if (out.length < 200 && l.toLowerCase().includes(needle)) out.push({ path, line: i + 1, text: l.slice(0, 240) }); });
      }
      return out;
    },
    vcs: async () => null, log: async () => [],
  };
}
export { binaryOf };
