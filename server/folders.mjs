// folders.mjs — any folder can be opened as a course. Before the app turns a plain folder into one it looks at it
// here: what is in it (a summary for the confirmation dialog, the files the import sorts), whether it is small enough
// to keep in git, and whether it is a folder the app may use at all.
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, checkDir, allowedRoots, isProjectDir } from './projects.mjs';

export const LIMITS = { files: 2000, bytes: 500 * 1024 * 1024 };
/** Folders not looked into: dependencies, environments, caches, version control. */
export const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.ipynb_checkpoints', '.tox', '.mypy_cache', '.pytest_cache', '.cache', '.studio', '.Trash']);
const KIND = [
  ['Slides', /^(pptx|ppt|key|odp)$/], ['Word', /^(docx|doc|odt|rtf)$/], ['PDF', /^pdf$/],
  ['Text', /^(md|markdown|txt|text|rst|tex|bib|ipynb|html?|csv|tsv|json|ya?ml)$/],
  ['Images', /^(png|jpe?g|gif|webp|svg|bmp|heic|tiff?)$/], ['Media', /^(mp4|mov|webm|avi|mkv|mp3|wav|m4a|ogg)$/],
];
const kindOf = name => { const ext = (name.match(/\.([^./]+)$/)?.[1] || '').toLowerCase(); return KIND.find(([, re]) => re.test(ext))?.[0] || 'Other'; };

/** Where a folder may be opened as a course: inside an allowed root, never a root itself; a file is not a folder. */
export function checkOpenable(dir) {
  const abs = checkDir(dir);
  if (allowedRoots().includes(abs)) throw new HttpError(400, 'Pick a folder inside your home folder, not the home folder itself');
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) throw new HttpError(400, 'Not a folder');
  return abs;
}

/** Walk a folder without following symlinks. files: the visible files (no dot-files, no SKIP folders) with their
 *  sizes; count / bytes: everything git could pick up (dot-files included, SKIP folders not). Stops early, with
 *  `over` set, once a limit is passed. */
export function scan(dir, { limits = LIMITS } = {}) {
  const files = []; let count = 0, bytes = 0, over = null;
  const walk = (rel, hidden) => {
    let ents; try { ents = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (over) return;
      if (SKIP.has(d.name) || d.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${d.name}` : d.name; const dot = hidden || d.name.startsWith('.');
      if (d.isDirectory()) { walk(p, dot); continue; }
      if (!d.isFile()) continue;
      let st; try { st = fs.lstatSync(path.join(dir, p)); } catch { continue; }
      count++; bytes += st.size;
      if (!dot) files.push({ path: p, size: st.size });
      if (count > limits.files) over = 'files'; else if (bytes > limits.bytes) over = 'bytes';
    }
  };
  if (fs.existsSync(dir)) walk('', false);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })), count, bytes, over };
}

/** A folder about to become a course: { dir, name, exists, git, empty, count, bytes, kinds: [[label, n]], top: [names] }
 *  (+ files: [{ path, size }]). Refuses folders over the limits. */
export function inspect(dir, { limits = LIMITS, withFiles = false } = {}) {
  const abs = checkOpenable(dir);
  if (isProjectDir(abs)) throw new HttpError(409, `${abs} already holds a course`);
  const s = scan(abs, { limits });
  if (s.over) throw new HttpError(413, s.over === 'files'
    ? `This folder holds more than ${limits.files} files. Choose a subfolder with just the course materials.`
    : `This folder holds more than ${Math.round(limits.bytes / 1024 / 1024)} MB. Choose a subfolder with just the course materials.`);
  const kinds = new Map(); for (const f of s.files) { const k = kindOf(f.path); kinds.set(k, (kinds.get(k) || 0) + 1); }
  const top = [...new Set(s.files.map(f => f.path.split('/')[0]))];
  return {
    dir: abs, name: path.basename(abs), exists: fs.existsSync(abs), git: fs.existsSync(path.join(abs, '.git')),
    empty: !s.files.length, count: s.files.length, bytes: s.files.reduce((a, f) => a + f.size, 0),
    kinds: [...kinds].sort((a, b) => b[1] - a[1]), top: top.slice(0, 12), more: Math.max(0, top.length - 12),
    ...(withFiles ? { files: s.files } : {}),
  };
}
