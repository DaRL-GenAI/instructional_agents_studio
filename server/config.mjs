// config.mjs — ~/.config/instructional-agents/: recent projects and account settings (0600). IA_CONFIG_DIR overrides
// the location (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const configDir = () => process.env.IA_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'instructional-agents');
export const cacheDir = () => process.env.IA_CACHE_DIR || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'instructional-agents');
export const projectsRoot = () => process.env.IA_PROJECTS_ROOT || readJson('config.json', {}).projectsRoot || path.join(os.homedir(), 'InstructionalAgents');

function readJson(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(configDir(), name), 'utf8')); } catch { return fallback; } }
function writeJson(name, value) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const f = path.join(configDir(), name), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f);
}

// ---------------------------------------------------------------- recent projects: [{ id, dir, name, openedAt }]
export const recent = () => readJson('projects.json', []);
export function remember(entry) {
  const list = recent().filter(r => r.id !== entry.id && r.dir !== entry.dir);
  list.unshift({ ...entry, openedAt: new Date().toISOString() }); writeJson('projects.json', list.slice(0, 50));
}
export function forget(id) { writeJson('projects.json', recent().filter(r => r.id !== id)); }
export const dirOf = id => recent().find(r => r.id === id)?.dir || null;

// ---------------------------------------------------------------- account settings (what IndexedDB holds in the browser edition)
export const settings = () => readJson('settings.json', null);
export const saveSettings = s => writeJson('settings.json', s);
