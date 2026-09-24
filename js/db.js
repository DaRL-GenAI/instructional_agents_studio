// db.js — IndexedDB persistence: projects, media blobs (narration/video), account settings.
// Falls back to an in-memory map when IndexedDB is unavailable (private mode, old browsers).

const DB_NAME = 'ia-studio';
const DB_VERSION = 1;
const STORES = ['projects', 'media', 'settings'];
let dbp = null;
const memory = { projects: new Map(), media: new Map(), settings: new Map() };
let usingMemory = false;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (!('indexedDB' in window)) { usingMemory = true; return resolve(null); }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { usingMemory = true; resolve(null); };
    req.onblocked = () => { usingMemory = true; resolve(null); };
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await open();
  if (!d) return fn(null);
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const os = t.objectStore(store);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export const db = {
  get usingMemory() { return usingMemory; },
  async get(store, key) {
    const d = await open();
    if (!d) return memory[store].get(key);
    return new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async put(store, key, value) {
    const d = await open();
    if (!d) { memory[store].set(key, value); return; }
    return tx(store, 'readwrite', os => os.put(value, key));
  },
  async del(store, key) {
    const d = await open();
    if (!d) { memory[store].delete(key); return; }
    return tx(store, 'readwrite', os => os.delete(key));
  },
  async keys(store) {
    const d = await open();
    if (!d) return [...memory[store].keys()];
    return new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async all(store) {
    const d = await open();
    if (!d) return [...memory[store].values()];
    return new Promise((res, rej) => { const r = d.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  async clearPrefix(store, prefix) {
    const ks = await this.keys(store);
    for (const k of ks) if (String(k).startsWith(prefix)) await this.del(store, k);
  },
  async estimate() {
    try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; } } catch { /* ignore */ }
    return null;
  },
  async persisted() { try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { return null; } },
  async persist() { try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; } },
};

export const mediaKey = (projectId, chapterId, kind) => `${projectId}:${chapterId}:${kind}`;
