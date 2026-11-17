// editor-pkg.mjs — the presentation/document editor (an ONLYOFFICE web build) served at /editor/. Found in
// IA_EDITOR_DIR, in the npm package instructional-agents-editor if one is installed next to the app, or in the cache
// (~/.cache/instructional-agents/editor/<version>/), where the app downloads the release asset below on its first start
// (or `instructional-agents editor install`). Without one the app falls back to the hosted editor (https://edit.chaxus.com).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { cacheDir } from './config.mjs';

// The release asset: the trimmed build as tar.gz (scripts/trim-editor.mjs --pack), attached to the GitHub release
// editor-v<version>; its source is the editor-src branch (NOTICE). Overridable with IA_EDITOR_URL / _SHA256 / _VERSION.
const RELEASE = { version: '0.1.1', url: 'https://github.com/DaRL-GenAI/instructional_agents_studio/releases/download/editor-v0.1.1/editor-trim.tar.gz', sha256: '5b28c55bde3aa32a410396ccb7e50208e576041ed77a8f587b7b47781cc11f44' };
export const EDITOR = { version: process.env.IA_EDITOR_VERSION || RELEASE.version, url: process.env.IA_EDITOR_URL ?? RELEASE.url, sha256: process.env.IA_EDITOR_SHA256 || RELEASE.sha256 };
const MARK = '.ia-editor.json';
const looksLikeEditor = d => !!d && fs.existsSync(path.join(d, 'editor.html')) && fs.existsSync(path.join(d, 'sdkjs'));

/** { dir, version, source } of a usable editor build, or null. */
export function findEditor() {
  const env = process.env.IA_EDITOR_DIR;
  if (env) return looksLikeEditor(env) ? { dir: path.resolve(env), version: 'local', source: 'IA_EDITOR_DIR' } : null;
  const npm = npmEditor(); if (npm) return npm;
  const root = path.join(cacheDir(), 'editor');
  const dirs = (() => { try { return fs.readdirSync(root).sort().reverse(); } catch { return []; } })();
  for (const v of [EDITOR.version, ...dirs]) { const d = path.join(root, v); if (fs.existsSync(path.join(d, MARK)) && looksLikeEditor(d)) return { dir: d, version: v, source: 'cache' }; }
  return null;
}

/** The editor npm package next to the app (node_modules), or null. */
export function npmEditor() {
  if (process.env.IA_NO_EDITOR_PKG) return null; // tests
  try {
    const pj = createRequire(import.meta.url).resolve('instructional-agents-editor/package.json');
    const dir = path.join(path.dirname(pj), 'dist');
    return looksLikeEditor(dir) ? { dir, version: JSON.parse(fs.readFileSync(pj, 'utf8')).version, source: 'npm' } : null;
  } catch { return null; }
}

/** Download, verify (sha-256 of the archive) and unpack the editor into the cache. */
export async function installEditor({ url = EDITOR.url, sha256 = EDITOR.sha256, version = EDITOR.version, log = () => {} } = {}) {
  if (!url) throw new Error('No editor package URL (set IA_EDITOR_URL or pass --url)');
  if (!/^[0-9a-f]{64}$/i.test(sha256 || '')) throw new Error('The editor package needs its sha-256 (IA_EDITOR_SHA256 or --sha256)');
  const root = path.join(cacheDir(), 'editor'); fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.download-${process.pid}`); const out = path.join(root, version);
  log(`downloading ${url}`);
  const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
  const hash = crypto.createHash('sha256'); const file = fs.createWriteStream(tmp);
  const total = Number(r.headers.get('content-length')) || 0; let got0 = 0, shown = 0;
  await pipeline(Readable.fromWeb(r.body), async function* (src) {
    for await (const c of src) { hash.update(c); got0 += c.length; const pct = total ? Math.floor(got0 / total * 10) * 10 : 0; if (pct > shown) { shown = pct; log(`${pct}% (${Math.round(got0 / 1e6)} of ${Math.round(total / 1e6)} MB)`); } yield c; }
  }, file);
  const got = hash.digest('hex'); if (got !== sha256.toLowerCase()) { fs.rmSync(tmp, { force: true }); throw new Error(`Checksum mismatch: got ${got}`); }
  const staging = `${out}.partial`; fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
  const unzip = /\.br$/.test(new URL(url).pathname) ? zlib.createBrotliDecompress() : zlib.createGunzip();
  await pipeline(fs.createReadStream(tmp), unzip, untar(staging));
  fs.rmSync(tmp, { force: true });
  const inner = fs.readdirSync(staging); const top = inner.length === 1 && looksLikeEditor(path.join(staging, inner[0])) ? path.join(staging, inner[0]) : staging;
  if (!looksLikeEditor(top)) throw new Error('The package does not contain an editor build');
  fs.writeFileSync(path.join(top, MARK), JSON.stringify({ version, url, sha256, at: new Date().toISOString() }));
  fs.rmSync(out, { recursive: true, force: true }); fs.renameSync(top, out); fs.rmSync(staging, { recursive: true, force: true });
  log(`editor ${version} installed in ${out}`);
  return findEditor();
}

/** A minimal tar (ustar / pax names) extractor as a writable stream: regular files and directories only, every
 *  path kept inside `dest`. */
function untar(dest) {
  const base = path.resolve(dest); let buf = Buffer.alloc(0); let entry = null; let longName = null;
  const safe = name => { const p = path.resolve(base, name); if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`Unsafe path in package: ${name}`); return p; };
  const str = (b, a, n) => b.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
  return new (class extends Writable {
    _write(chunk, _enc, cb) {
      try {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (entry) {
            const take = Math.min(entry.left, buf.length);
            if (take) { if (entry.fd != null) fs.writeSync(entry.fd, buf.subarray(0, take)); if (entry.pax != null) entry.pax.push(buf.subarray(0, take)); buf = buf.subarray(take); entry.left -= take; }
            if (entry.left) break;
            const pad = (512 - (entry.size % 512)) % 512; if (buf.length < pad) break;
            buf = buf.subarray(pad);
            if (entry.fd != null) fs.closeSync(entry.fd);
            if (entry.pax) { const m = Buffer.concat(entry.pax).toString('utf8').match(/\d+ path=([^\n]*)\n/); if (m) longName = m[1]; }
            if (entry.gnu) longName = Buffer.concat(entry.gnu).toString('utf8').replace(/\0.*$/s, '');
            entry = null; continue;
          }
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512); buf = buf.subarray(512);
          if (h.every(b => b === 0)) continue;
          const name = longName || ((str(h, 345, 155) ? str(h, 345, 155) + '/' : '') + str(h, 0, 100)); longName = null;
          const size = parseInt(str(h, 124, 12).trim() || '0', 8); const type = String.fromCharCode(h[156] || 48);
          entry = { size, left: size, fd: null };
          if (type === 'x' || type === 'g') entry.pax = [];
          else if (type === 'L') { entry.gnu = []; entry.pax = entry.gnu; }
          else if (type === '5') fs.mkdirSync(safe(name), { recursive: true });
          else if (type === '0' || type === '\0' || type === '7') { const p = safe(name); fs.mkdirSync(path.dirname(p), { recursive: true }); entry.fd = fs.openSync(p, 'w'); }
          if (!size) { if (entry.fd != null) fs.closeSync(entry.fd); entry = null; }
        }
        cb();
      } catch (e) { cb(e); }
    }
  })();
}
