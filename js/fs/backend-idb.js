// fs/backend-idb.js — the browser edition's storage: projects, media and settings in IndexedDB (js/db.js).
import { db, mediaKey } from '../db.js';

export const idbBackend = {
  kind: 'idb',
  list: () => db.all('projects'),
  get: id => db.get('projects', id),
  put: p => db.put('projects', p.id, p),
  create: async p => { await db.put('projects', p.id, p); return p; },
  async remove(id) { await db.del('projects', id); await db.clearPrefix('media', `${id}:`); },
  getMedia: (pid, ch, kind) => db.get('media', mediaKey(pid, ch, kind)),
  putMedia: (pid, ch, kind, v) => db.put('media', mediaKey(pid, ch, kind), v),
  delMedia: (pid, ch, kind) => db.del('media', mediaKey(pid, ch, kind)),
  async mediaKeys(pid) { return (await db.keys('media')).map(String).filter(k => k.startsWith(`${pid}:`)); },
  getSettings: () => db.get('settings', 'account'),
  putSettings: s => db.put('settings', 'account', s),
};
