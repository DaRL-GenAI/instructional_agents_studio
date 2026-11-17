// workspace.mjs — files inside a project folder. Every path from a request is resolved here and must stay inside
// the folder: no absolute paths, no "..", no symlink that leads out.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renameRetry } from './config.mjs';
import { isInside } from './platform.mjs';

export class PathError extends Error { constructor(m) { super(m); this.status = 400; } }

/** root + relative path → absolute path inside root (throws otherwise). The file need not exist. */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new PathError('Bad path');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new PathError('Absolute paths are not allowed');
  if (rel.split(/[\\/]+/).includes('..')) throw new PathError('Path leaves the project folder');
  const realRoot = fs.realpathSync.native(root);
  const abs = path.resolve(realRoot, rel);
  if (!isInside(abs, realRoot)) throw new PathError('Path leaves the project folder');
  // the nearest existing ancestor (or the file) must resolve inside the root too: symlinks may not lead out
  let probe = abs;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const real = fs.realpathSync.native(probe);
  if (!isInside(real, realRoot)) throw new PathError('Path leaves the project folder');
  return abs;
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function readText(root, rel) { try { return fs.readFileSync(resolveInside(root, rel), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export function readBuf(root, rel) { try { return fs.readFileSync(resolveInside(root, rel)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export function writeFile(root, rel, data) { const abs = resolveInside(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); const tmp = `${abs}.${process.pid}.tmp`; fs.writeFileSync(tmp, data); try { renameRetry(tmp, abs); } catch (e) { fs.rmSync(tmp, { force: true }); if (['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw Object.assign(new Error(`${rel} is open in another program or read-only (close it there and try again)`), { status: 409 }); throw e; } }
/** Remove a file and the directories it leaves empty (up to the root). */
export function removeFile(root, rel) {
  const abs = resolveInside(root, rel); try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const realRoot = fs.realpathSync.native(root);
  for (let d = path.dirname(abs); d !== realRoot && isInside(d, realRoot); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
}

/** Files of a folder opened as a course that stay in place as source material (.studio/meta.json "sources"). */
export function sourcesOf(root) {
  try { const m = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'meta.json'), 'utf8')); return new Set(Array.isArray(m.sources) ? m.sources.filter(x => typeof x === 'string') : []); } catch { return new Set(); }
}
