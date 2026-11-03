// files.mjs — the Workspace's file operations inside a project folder: list the tree, write, create folders,
// rename, delete (into .studio/trash/), search. Paths are checked by workspace.mjs (resolveInside). Files the app
// manages (a stage's output, the deck, course.json, .studio/) can be read here but are written through the project
// store, so stage versions, history and the audit trail stay consistent.
import fs from 'node:fs';
import path from 'node:path';
import { META } from '../js/fs/serialize.js';
import { resolveInside, readText, writeFile } from './workspace.mjs';
import { readHeader } from '../js/fs/bundle.js';
import { HttpError } from './projects.mjs';
import { GUIDE_FILES, isManagedGuide } from './agents/guide.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_ENTRIES = 20000;
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.tex', '.bib', '.csv', '.tsv', '.html', '.css', '.js', '.mjs', '.py', '.sh', '.toml', '.xml', '.svg', '']);

/** Every file and folder under the project (no .git, no node_modules): [{ path, dir, size, mtime }], sorted. */
export function tree(root) {
  const out = []; const real = fs.realpathSync(root);
  const walk = rel => {
    let ents; try { ents = fs.readdirSync(rel ? path.join(real, rel) : real, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (out.length >= MAX_ENTRIES) return;
      if (SKIP_DIRS.has(d.name)) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) continue; // never follow links out of the folder
      if (d.isDirectory()) { out.push({ path: p, dir: true }); walk(p); }
      else if (d.isFile()) { let st; try { st = fs.statSync(path.join(real, p)); } catch { continue; } out.push({ path: p, dir: false, size: st.size, mtime: Math.floor(st.mtimeMs) }); }
    }
  };
  walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files the app writes itself (through the project store): course.json, .studio/**, every stage output file. */
export function managed(root) {
  const meta = JSON.parse(readText(root, META) || '{}');
  const out = new Set([META, 'course.json', ...(meta.files || [])]);
  for (const f of GUIDE_FILES) if (isManagedGuide(readText(root, f))) out.add(f);
  return out;
}
export const isInternal = rel => rel === '.git' || rel.startsWith('.git/') || rel === '.studio' || rel.startsWith('.studio/');

export function checkWritable(root, rel, what = 'changed') {
  if (isInternal(rel)) throw new HttpError(403, `Files under ${rel.split('/')[0]}/ cannot be ${what} here`);
  if (managed(root).has(rel)) throw new HttpError(409, 'This file belongs to a stage: it is saved through the stage, not as a plain file', { managed: true });
}

export function mkdir(root, rel) {
  if (isInternal(rel)) throw new HttpError(403, 'Not allowed here');
  const abs = resolveInside(root, rel); if (fs.existsSync(abs)) throw new HttpError(409, 'Already exists');
  fs.mkdirSync(abs, { recursive: true });
}

/** Every file under a path (the path itself when it is a file), relative to root. */
export function filesUnder(root, rel) {
  const abs = resolveInside(root, rel); if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  return tree(root).filter(e => !e.dir && e.path.startsWith(`${rel}/`)).map(e => e.path);
}

/** Move a file or folder. Refuses managed files (anywhere inside a moved folder too) and existing targets. */
export function rename(root, from, to) {
  if (from === to) return [];
  const mg = managed(root);
  for (const f of filesUnder(root, from)) if (mg.has(f)) throw new HttpError(409, `${f} belongs to a stage and cannot be moved`, { managed: true });
  if (isInternal(from) || isInternal(to)) throw new HttpError(403, 'Not allowed here');
  const a = resolveInside(root, from), b = resolveInside(root, to);
  if (!fs.existsSync(a)) throw new HttpError(404, 'No such file');
  if (fs.existsSync(b)) throw new HttpError(409, `${to} already exists`);
  const moved = filesUnder(root, from);
  fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b);
  return moved.map(f => [f, to + f.slice(from.length)]);
}

/** Move a file or folder into .studio/trash/<time>/ (restorable by hand). Returns the files it held. */
export function trash(root, rel) {
  const mg = managed(root);
  for (const f of filesUnder(root, rel)) if (mg.has(f)) throw new HttpError(409, `${f} belongs to a stage and cannot be deleted here`, { managed: true });
  if (isInternal(rel)) throw new HttpError(403, 'Not allowed here');
  const abs = resolveInside(root, rel); if (!fs.existsSync(abs)) throw new HttpError(404, 'No such file');
  const files = filesUnder(root, rel);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = resolveInside(root, `.studio/trash/${stamp}/${rel}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(abs, dest);
  return { files, trashed: `.studio/trash/${stamp}/${rel}` };
}

/** Lines matching `q` (case-insensitive) in the project's text files: [{ path, line, text }]. */
export function search(root, q, { limit = 200 } = {}) {
  const needle = String(q || '').toLowerCase(); if (!needle) return [];
  const out = [];
  for (const e of tree(root)) {
    if (e.dir || e.size > 1024 * 1024 || /^(build|\.studio\/(decks|trash|backup|jobs|stages|sessions))\//.test(e.path)) continue;
    if (!TEXT_EXT.has(path.extname(e.path).toLowerCase())) continue;
    const name = e.path.toLowerCase().includes(needle);
    const text = readText(root, e.path) || '';
    if (name) out.push({ path: e.path, line: 0, text: '' });
    text.split('\n').forEach((l, i) => { if (out.length < limit && l.toLowerCase().includes(needle)) out.push({ path: e.path, line: i + 1, text: l.slice(0, 240) }); });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- course materials (import)
/** A request body (fs/bundle.js: { files: [{ path, data }] }) → [{ path, buf }]. Paths are relative to sources/. */
export function readSources(body) {
  const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  let header, offset; try { ({ header, offset } = readHeader(bytes)); } catch (e) { throw new HttpError(400, e.message); }
  const list = header.skel?.files; if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'No files');
  if (list.length > 2000) throw new HttpError(413, 'Too many files');
  const starts = []; let at = offset; for (const p of header.parts) { starts.push(at); at += p.len; }
  return list.map(f => {
    const i = f?.data?.$bin; if (typeof f?.path !== 'string' || !Number.isInteger(i) || !header.parts[i]) throw new HttpError(400, 'Bad file entry');
    return { path: f.path, buf: Buffer.from(bytes.subarray(starts[i], starts[i] + header.parts[i].len)) };
  });
}

/** sources/<path> for each file (folders kept). Returns the written paths. */
export function writeSources(root, list) {
  const out = [];
  for (const { path: p, buf } of list) {
    const clean = String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^sources\//, '');
    if (!clean || clean.split('/').some(s => s === '..' || s === '.' || s === '' || s === '.git' || s === '.studio')) throw new HttpError(400, `Bad path: ${p}`);
    const rel = `sources/${clean}`;
    const abs = resolveInside(root, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new HttpError(409, `${rel} is a folder`);
    writeFile(root, rel, buf); out.push(rel);
  }
  return out;
}

/** "import: sources/course-src (9 files)" or "import: sources/hw1.docx". */
export function sourcesMessage(paths) {
  if (paths.length === 1) return `import: ${paths[0]}`;
  const parts = paths.map(p => p.split('/')); let n = 0;
  while (parts.every(x => x.length > n + 1 && x[n] === parts[0][n])) n++;
  return `import: ${parts[0].slice(0, Math.max(1, n)).join('/')} (${paths.length} files)`;
}
