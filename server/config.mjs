// config.mjs — ~/.config/instructional-agents/: recent projects and account settings (0600). IA_CONFIG_DIR overrides
// the location (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Windows: %APPDATA% (roaming settings) and %LOCALAPPDATA% (cache, history kept on this computer); elsewhere XDG.
const win = process.platform === 'win32';
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
export const configDir = () => process.env.IA_CONFIG_DIR || (win ? path.join(appData(), 'instructional-agents') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'instructional-agents'));
export const cacheDir = () => process.env.IA_CACHE_DIR || (win ? path.join(localAppData(), 'instructional-agents', 'Cache') : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'instructional-agents'));
/** State kept on this computer only (history and scratch of courses in a synced folder): never a cache, it holds history. */
export const dataDir = () => process.env.IA_DATA_DIR || (win ? path.join(localAppData(), 'instructional-agents', 'Data') : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'instructional-agents'));
export const projectsRoot = () => process.env.IA_PROJECTS_ROOT || readJson('config.json', {}).projectsRoot || path.join(os.homedir(), 'InstructionalAgents');

function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(configDir(), name), 'utf8')); } catch { return fallback; } }
function writeJson(name, value) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const f = path.join(configDir(), name), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameRetry(tmp, f);
}

/** rename, retried briefly on Windows, where a virus scanner or the search indexer can hold the target for a moment. */
export function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (process.platform !== 'win32' || i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

// ---------------------------------------------------------------- recent projects: [{ id, dir, name, openedAt }]
export const recent = () => readJson('projects.json', []);
export function remember(entry) {
  const list = recent().filter(r => r.id !== entry.id && r.dir !== entry.dir);
  list.unshift({ ...entry, openedAt: new Date().toISOString() }); writeJson('projects.json', list.slice(0, 50));
}
export function forget(id) { writeJson('projects.json', recent().filter(r => r.id !== id)); }
export const dirOf = id => recent().find(r => r.id === id)?.dir || null;

// ---------------------------------------------------------------- local state of courses in synced folders: [{ dir, id, name }]
export const localStates = () => readJson('local-state.json', []);
export const saveLocalStates = list => writeJson('local-state.json', list);

// ---------------------------------------------------------------- account settings (what IndexedDB holds in the browser edition)
export const settings = () => readJson('settings.json', null);
export const saveSettings = s => writeJson('settings.json', s);
