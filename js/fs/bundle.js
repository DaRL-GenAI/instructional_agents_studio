// fs/bundle.js — a media value (anything IndexedDB could hold: objects, arrays, Blobs, ArrayBuffers, typed arrays)
// as one request body: a JSON header line { v, skel, parts } followed by the binary parts back to back. The skeleton
// replaces every binary with { $bin: i }; the server stores the parts as real files.
const TYPED = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];

/** value → Blob (browser). */
export function encodeBundle(value) {
  const parts = [], data = [];
  const walk = v => {
    if (v === null || typeof v !== 'object') return v;
    if (typeof Blob !== 'undefined' && v instanceof Blob) {
      const d = { as: typeof File !== 'undefined' && v instanceof File ? 'file' : 'blob', type: v.type || '', len: v.size };
      if (d.as === 'file') { d.name = v.name; d.lastModified = v.lastModified; }
      parts.push(d); data.push(v); return { $bin: parts.length - 1 };
    }
    if (v instanceof ArrayBuffer) { parts.push({ as: 'ab', len: v.byteLength }); data.push(v); return { $bin: parts.length - 1 }; }
    if (ArrayBuffer.isView(v)) { const name = v.constructor.name; parts.push({ as: TYPED.includes(name) ? name : 'Uint8Array', len: v.byteLength }); data.push(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)); return { $bin: parts.length - 1 }; }
    if (v instanceof Date) return { $date: v.toISOString() };
    if (Array.isArray(v)) return v.map(walk);
    const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = walk(x); return o;
  };
  const skel = walk(value);
  return new Blob([JSON.stringify({ v: 1, skel, parts }) + '\n', ...data], { type: 'application/x-ia-bundle' });
}

/** Uint8Array → { header, offset } (browser and Node). */
export function readHeader(bytes) {
  const nl = bytes.indexOf(10); if (nl < 0) throw new Error('Bad media bundle');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
  if (header.v !== 1 || !Array.isArray(header.parts)) throw new Error('Bad media bundle');
  let total = nl + 1; for (const p of header.parts) { if (!Number.isInteger(p.len) || p.len < 0) throw new Error('Bad media bundle'); total += p.len; }
  if (total !== bytes.length) throw new Error('Media bundle length mismatch');
  return { header, offset: nl + 1 };
}

/** ArrayBuffer → value (browser). */
export function decodeBundle(buf) {
  const bytes = new Uint8Array(buf); const { header, offset } = readHeader(bytes);
  let at = offset; const bins = header.parts.map(p => {
    const slice = buf.slice(at, at + p.len); at += p.len;
    if (p.as === 'blob') return new Blob([slice], { type: p.type });
    if (p.as === 'file') return new File([slice], p.name || 'file', { type: p.type, lastModified: p.lastModified });
    if (p.as === 'ab') return slice;
    return new (globalThis[p.as] || Uint8Array)(slice);
  });
  const walk = v => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v.$bin === 'number' && Object.keys(v).length === 1) return bins[v.$bin];
    if (typeof v.$date === 'string' && Object.keys(v).length === 1) return new Date(v.$date);
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = walk(x); return o;
  };
  return walk(header.skel);
}
