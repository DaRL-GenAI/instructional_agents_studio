// localstate.mjs — courses in a synced folder (Google Drive, iCloud Drive, Dropbox, OneDrive). The course files sync
// like any others, but what the app writes often and in bulk stays on this computer: the git repository (a sync
// client that uploads .git object by object, or merges two computers' copies, can corrupt it), the agent job copies
// and the chats. They live in <dataDir>/projects/<name>-<id>/ { git/, jobs/, sessions/ }, found again through
// <configDir>/local-state.json. Another computer that opens the same folder starts a history of its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as config from './config.mjs';

const inside = (p, root) => p === root || p.startsWith(root + path.sep);

/** The sync service a folder belongs to ('Google Drive', 'iCloud Drive', …), or null. IA_CLOUD_DIRS adds folders
 *  (a mount of rclone, Insync, … on Linux). */
export function cloudOf(dir) {
  const home = os.homedir(), cs = path.join(home, 'Library', 'CloudStorage');
  const extra = (process.env.IA_CLOUD_DIRS || '').split(path.delimiter).filter(Boolean).map(p => path.resolve(p));
  if (extra.some(r => inside(dir, r))) return 'a synced folder';
  if (inside(dir, cs) && dir !== cs) {
    const top = path.relative(cs, dir).split(path.sep)[0];
    return /^GoogleDrive/i.test(top) ? 'Google Drive' : /^Dropbox/i.test(top) ? 'Dropbox' : /^OneDrive/i.test(top) ? 'OneDrive' : /^Box/i.test(top) ? 'Box' : 'a synced folder';
  }
  if (inside(dir, path.join(home, 'Library', 'Mobile Documents'))) return 'iCloud Drive';
  if (['Google Drive', 'My Drive'].some(n => inside(dir, path.join(home, n))) || inside(dir, '/Volumes/GoogleDrive')) return 'Google Drive';
  if (inside(dir, path.join(home, 'Dropbox'))) return 'Dropbox';
  if (path.relative(home, dir).split(path.sep)[0].startsWith('OneDrive')) return 'OneDrive';
  return null;
}

/** Synced folders on this computer, for the folder picker: [{ label, path }]. */
export function places() {
  const home = os.homedir(), out = [], cs = path.join(home, 'Library', 'CloudStorage');
  const add = (label, p) => { try { if (fs.statSync(p).isDirectory() && !out.some(o => o.path === p)) out.push({ label, path: p }); } catch { /* not here */ } };
  let ents = []; try { ents = fs.readdirSync(cs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { /* not a Mac */ }
  const drives = ents.filter(n => /^GoogleDrive-/i.test(n));
  for (const n of drives) {
    const who = drives.length > 1 ? ` (${n.replace(/^GoogleDrive-/i, '')})` : '';
    add(`Google Drive${who}`, path.join(cs, n, 'My Drive')); add(`Shared drives${who}`, path.join(cs, n, 'Shared drives'));
  }
  add('Google Drive', path.join(home, 'My Drive')); add('Google Drive', path.join(home, 'Google Drive')); add('Google Drive', '/Volumes/GoogleDrive/My Drive');
  add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  for (const n of ents) { const k = n.match(/^(Dropbox|OneDrive|Box)/i)?.[1]; if (k) add(n.replace('-', ' · '), path.join(cs, n)); }
  add('Dropbox', path.join(home, 'Dropbox'));
  return out;
}

const metaId = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'meta.json'), 'utf8')).project?.id || null; } catch { return null; } };

/** This computer's folder for a course folder: the one recorded for it (or for the same course at a path that no
 *  longer exists: the folder was moved), else a new one when `create`, else null. */
export function localDir(dir, { create = false } = {}) {
  const list = config.localStates();
  let e = list.find(x => x.dir === dir);
  if (!e) {
    const id = metaId(dir);
    e = id && list.find(x => x.id === id && !fs.existsSync(x.dir));
    if (e) { e.dir = dir; config.saveLocalStates(list); }
  }
  if (!e && create) {
    const slug = path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'course';
    e = { dir, id: metaId(dir), name: `${slug}-${crypto.randomBytes(3).toString('hex')}` };
    list.push(e); config.saveLocalStates(list);
    const old = path.join(dir, '.studio', 'sessions'), now = path.join(config.dataDir(), 'projects', e.name, 'sessions');
    if (fs.existsSync(old)) { fs.mkdirSync(path.dirname(now), { recursive: true }); fs.cpSync(old, now, { recursive: true }); fs.rmSync(old, { recursive: true, force: true }); } // chats from before
  }
  if (!e) return null;
  if (!e.id) { const id = metaId(dir); if (id) { e.id = id; config.saveLocalStates(list); } }
  const abs = path.join(config.dataDir(), 'projects', e.name); fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  return abs;
}

/** Where a course keeps its git repository: its own .git when it has one, else this computer's (synced folders). */
export function gitdirOf(dir, { create = false } = {}) {
  const own = path.join(dir, '.git'); if (fs.existsSync(own)) return own;
  const local = localDir(dir, { create: create && !!cloudOf(dir) });
  return local ? path.join(local, 'git') : own;
}

/** A scratch folder of a course ('jobs', 'sessions'): inside .studio/, or on this computer for a synced folder. */
export function scratchDir(root, name) {
  const local = localDir(root, { create: !!cloudOf(root) });
  return local ? path.join(local, name) : path.join(root, '.studio', name);
}
