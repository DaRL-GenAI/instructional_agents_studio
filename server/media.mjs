// media.mjs — the project's media store (what IndexedDB's media store holds in the browser edition), as files:
//   deck versions        .studio/decks/<chapterId>/<sha256>.pptx   (the current one is also chapters/NN-slug/slides.pptx)
//   Word versions        .studio/decks/<chapterId>/<sha256>.docx   (key doc:<sha>; a stage converted to Word)
//   project media        .studio/media/<kind>.json + parts        (the deck template; committed)
//   chapter media        build/media/<chapterId>/<kind>.json + parts (narration, video, images; not committed)
// A value arrives as a bundle (js/fs/bundle.js): a JSON header line, then the binary parts.
import fs from 'node:fs';
import path from 'node:path';
import { readHeader } from '../js/fs/bundle.js';
import { resolveInside, sha256 } from './workspace.mjs';

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const KIND_EXT = { deck: 'pptx', doc: 'docx' }, EXT_TYPE = { pptx: PPTX, docx: DOCX };
const EXT = { 'video/webm': 'webm', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'weba', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', [PPTX]: 'pptx', [DOCX]: 'docx', 'application/json': 'json' };
const OK_CH = /^[A-Za-z0-9_-]{1,64}$/, OK_KIND = /^[A-Za-z0-9_-]{1,64}$/, DECK = /^(deck|doc):([0-9a-f]{64})$/;

export class MediaError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

export function parseKey(key) {
  const i = String(key).indexOf(':'); if (i < 0) throw new MediaError('Bad media key');
  const chapterId = key.slice(0, i), kind = key.slice(i + 1);
  if (!OK_CH.test(chapterId) || !(OK_KIND.test(kind) || DECK.test(kind))) throw new MediaError('Bad media key');
  const d = kind.match(DECK);
  return { chapterId, kind, deck: d?.[2] || null, ext: d ? KIND_EXT[d[1]] : null };
}
const deckPath = (ch, sha, ext = 'pptx') => `.studio/decks/${ch}/${sha}.${ext}`;
const baseOf = (ch, kind) => ch === 'project' ? `.studio/media/${kind}` : `build/media/${ch}/${kind}`;

/** Store a bundle. A deck (or Word document) must be one file whose sha-256 matches its key. */
export function put(root, key, body) {
  const { chapterId, kind, deck, ext } = parseKey(key);
  const { header, offset } = readHeader(body);
  if (deck) {
    if (header.parts.length !== 1 || header.skel?.$bin !== 0) throw new MediaError('A deck is one file');
    const data = body.subarray(offset); if (sha256(data) !== deck) throw new MediaError('The deck does not match its hash');
    write(root, deckPath(chapterId, deck, ext), data); return;
  }
  del(root, key);
  const base = baseOf(chapterId, kind); let at = offset;
  const parts = header.parts.map((p, i) => { const f = `${path.posix.basename(base)}.${i}.${EXT[p.type] || 'bin'}`; write(root, `${path.posix.dirname(base)}/${f}`, body.subarray(at, at + p.len)); at += p.len; return { ...p, file: f }; });
  write(root, `${base}.json`, JSON.stringify({ v: 1, skel: header.skel, parts }));
}

/** The stored bundle (Buffer) or null. `fallback(chapterId, sha, ext)` → Buffer finds a deck elsewhere (slides.pptx). */
export function get(root, key, fallback) {
  const { chapterId, kind, deck, ext } = parseKey(key);
  if (deck) {
    let data = read(root, deckPath(chapterId, deck, ext));
    if (!data && fallback) { data = fallback(chapterId, deck, ext); if (data) write(root, deckPath(chapterId, deck, ext), data); }
    return data ? bundle({ skel: { $bin: 0 }, parts: [{ as: 'blob', type: EXT_TYPE[ext], len: data.length }] }, [data]) : null;
  }
  const base = baseOf(chapterId, kind); const meta = read(root, `${base}.json`); if (!meta) return null;
  const h = JSON.parse(meta); const dir = path.posix.dirname(base);
  const bufs = h.parts.map(p => read(root, `${dir}/${p.file}`) || Buffer.alloc(0));
  return bundle({ skel: h.skel, parts: h.parts.map(({ file, ...p }, i) => ({ ...p, len: bufs[i].length })) }, bufs);
}

export function del(root, key) {
  const { chapterId, kind, deck, ext } = parseKey(key);
  if (deck) return unlink(root, deckPath(chapterId, deck, ext));
  const base = baseOf(chapterId, kind); const meta = read(root, `${base}.json`); if (!meta) return;
  const dir = path.posix.dirname(base); for (const p of JSON.parse(meta).parts || []) unlink(root, `${dir}/${p.file}`);
  unlink(root, `${base}.json`);
}

/** Every stored key: "<chapterId>:<kind>". */
export function keys(root) {
  const out = [];
  const ls = rel => { try { return fs.readdirSync(resolveInside(root, rel), { withFileTypes: true }); } catch { return []; } };
  for (const d of ls('.studio/decks')) if (d.isDirectory()) for (const f of ls(`.studio/decks/${d.name}`)) { const m = f.name.match(/^([0-9a-f]{64})\.(pptx|docx)$/); if (m) out.push(`${d.name}:${m[2] === 'docx' ? 'doc' : 'deck'}:${m[1]}`); }
  for (const f of ls('.studio/media')) if (f.name.endsWith('.json')) out.push(`project:${f.name.slice(0, -5)}`);
  for (const d of ls('build/media')) if (d.isDirectory()) for (const f of ls(`build/media/${d.name}`)) if (f.name.endsWith('.json')) out.push(`${d.name}:${f.name.slice(0, -5)}`);
  return out;
}

export const deckFile = (root, chapterId, sha, ext = 'pptx') => read(root, deckPath(chapterId, sha, ext));
export const storeDeckFile = (root, chapterId, data, ext = 'pptx') => { const sha = sha256(data); write(root, deckPath(chapterId, sha, ext), data); return sha; };

function bundle(header, bufs) { return Buffer.concat([Buffer.from(JSON.stringify({ v: 1, ...header }) + '\n'), ...bufs]); }
function read(root, rel) { try { return fs.readFileSync(resolveInside(root, rel)); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } }
function write(root, rel, data) { const abs = resolveInside(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, data); }
function unlink(root, rel) { try { fs.unlinkSync(resolveInside(root, rel)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
