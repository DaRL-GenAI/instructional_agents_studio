// import/extract.js — the text of an instructor's existing file, for sorting it into the course (import) and for
// comparing versions: .pptx (slide titles, bullets, notes), .docx (Markdown via mammoth), .pdf (the first pages),
// .md/.txt, .ipynb (markdown cells), .tex (commands stripped lightly). Runs in the browser and in Node (tests): the
// .pptx reader needs DOMParser and JSZip, the PDF reader uses pdf.js when it is loaded and a small built-in reader
// otherwise. Nothing here sends a whole file anywhere: digest() is what the classifier may show a model.
import { readPptx } from '../pptxdeck.js';
import { docxToMd } from '../docconv.js';

export const extOf = path => (String(path).match(/\.([^./]+)$/)?.[1] || '').toLowerCase();
export const baseName = path => String(path).split('/').pop();
export const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'text', 'rst', 'csv', 'json']);
export const READABLE = new Set([...TEXT_EXT, 'pptx', 'docx', 'pdf', 'ipynb', 'tex']);
const PDF_PAGES = 4, MAX_TEXT = 200000;

const bytesOf = async d => d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(await d.arrayBuffer());
const textOf = async d => new TextDecoder().decode(await bytesOf(d));

/** The slides of a deck as text (also how a slides stage's manifest reads, so versions compare line by line). */
export const deckText = slides => (slides || []).map(s => [`# ${s.title}`, ...(s.bullets || []).map(b => `- ${b}`), s.notes ? `Notes: ${s.notes}` : null].filter(Boolean).join('\n')).join('\n\n');

/** file (Blob | bytes) → { text, title, slides? } ('' for files without readable text). */
export async function extractText(path, data) {
  const ext = extOf(path); let text = '', title = '', slides;
  try {
    if (ext === 'pptx') { slides = await readPptx(data instanceof Uint8Array || data instanceof ArrayBuffer ? new Blob([data]) : data); text = deckText(slides); title = slides[0]?.title || ''; }
    else if (ext === 'docx') text = await docxToMd(data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    else if (ext === 'pdf') text = await pdfText(await bytesOf(data));
    else if (ext === 'ipynb') text = notebookText(await textOf(data));
    else if (ext === 'tex') { const raw = await textOf(data); text = texText(raw); title = raw.match(/\\title\{([^}]*)\}/)?.[1]?.trim() || ''; }
    else if (TEXT_EXT.has(ext)) text = await textOf(data);
  } catch (e) { return { text: '', title: '', error: e.message || String(e) }; }
  text = String(text || '').replace(/\r\n?/g, '\n').slice(0, MAX_TEXT);
  if (!title) title = firstHeading(text);
  return { text, title, ...(slides ? { slides } : {}) };
}

export function firstHeading(text) {
  const h = String(text).match(/^#{1,3}\s+(.+)$/m)?.[1]; if (h) return h.trim().slice(0, 120);
  return (String(text).split('\n').find(l => l.trim()) || '').trim().replace(/^[#*\-\s]+/, '').slice(0, 120);
}

/** A short digest of a file's text: headings first, then the opening lines. Never more than `max` characters. */
export function digest(text, { max = 600 } = {}) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const heads = lines.filter(l => /^#{1,4}\s/.test(l)).slice(0, 10).map(l => l.replace(/^#+\s*/, '# '));
  const body = lines.filter(l => !/^#{1,4}\s/.test(l)).join(' ').replace(/\s+/g, ' ');
  let out = heads.join(' | ');
  if (out.length < max) out = (out ? `${out} || ` : '') + body.slice(0, max - out.length - 4);
  return out.slice(0, max);
}

// ---------------------------------------------------------------- notebooks and LaTeX
export function notebookText(json) {
  let nb; try { nb = JSON.parse(json); } catch { return ''; }
  return (nb.cells || []).filter(c => c.cell_type === 'markdown').map(c => (Array.isArray(c.source) ? c.source.join('') : String(c.source || '')).trim()).filter(Boolean).join('\n\n');
}

export function texText(src) {
  let t = String(src).replace(/(^|[^\\])%.*$/gm, '$1');
  const body = t.match(/\\begin\{document\}([\s\S]*?)(\\end\{document\}|$)/); if (body) t = body[1];
  t = t.replace(/\\(chapter|section|subsection|subsubsection|frametitle)\*?\{([^}]*)\}/g, (_, k, x) => `\n${k === 'subsection' || k === 'frametitle' ? '##' : k === 'subsubsection' ? '###' : '#'} ${x}\n`)
    .replace(/\\item\s*/g, '\n- ')
    .replace(/\\(begin|end)\{[^}]*\}(\[[^\]]*\])?/g, '\n')
    .replace(/\\(textbf|textit|emph|underline|texttt|mathrm|text)\{([^}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, '').replace(/\\\\/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n');
  return t.split('\n').map(l => l.trim()).join('\n').trim();
}

// ---------------------------------------------------------------- PDF
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
/** The text of the first pages of a PDF: pdf.js in the browser, the built-in reader when pdf.js is unavailable. */
export async function pdfText(bytes, { pages = PDF_PAGES } = {}) {
  const lib = await loadPdfjs();
  if (lib) {
    try {
      const pdf = await lib.getDocument({ data: bytes.slice() }).promise; const out = [];
      for (let i = 1; i <= Math.min(pdf.numPages, pages); i++) {
        const c = await (await pdf.getPage(i)).getTextContent(); let line = '';
        for (const it of c.items) { line += it.str; if (it.hasEOL) { out.push(line); line = ''; } }
        if (line) out.push(line); out.push('');
      }
      return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    } catch { /* fall back to the built-in reader */ }
  }
  return simplePdfText(bytes, { pages });
}
async function loadPdfjs() {
  if (typeof document === 'undefined') return null;
  if (!window.pdfjsLib) {
    await new Promise(res => { const s = document.createElement('script'); s.src = `${PDFJS}pdf.min.js`; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    if (!window.pdfjsLib) return null;
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.js`;
  return window.pdfjsLib;
}

const latin1 = b => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
async function inflate(bytes) {
  const ds = new DecompressionStream('deflate'); const w = ds.writable.getWriter(); w.write(bytes).catch(() => {}); w.close().catch(() => {});
  const chunks = []; const r = ds.readable.getReader(); let n = 0;
  try { for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); n += value.length; if (n > 8e6) break; } } catch { /* truncated or corrupt stream: keep what came out */ }
  const out = new Uint8Array(n); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out;
}
const unescapePdf = s => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[e] ?? String.fromCharCode(parseInt(e, 8))));

/** A small PDF text reader: the literal strings shown by Tj / TJ / ' / " in the content streams (plain or
 *  FlateDecode). Enough for simple documents; pdf.js handles the rest in the browser. */
export async function simplePdfText(bytes, { pages = PDF_PAGES } = {}) {
  const src = latin1(bytes); const out = []; let seen = 0;
  const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g; let m;
  while ((m = re.exec(src)) && seen < pages * 3) {
    const dict = m[1]; const start = m.index + m[0].length; const end = src.indexOf('endstream', start); if (end < 0) break;
    if (/\/(Subtype\s*\/Image|Type\s*\/XObject|Length1|Type\s*\/(XRef|ObjStm|Metadata))/.test(dict)) continue;
    let raw = bytes.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) raw = await inflate(raw); else if (/\/Filter/.test(dict)) continue;
    const content = latin1(raw); if (!/\bBT\b/.test(content)) continue;
    seen++;
    const lines = []; let line = '';
    const tok = /\((?:\\.|[^\\)])*\)|\[(?:\\.|[^\]\\])*\]\s*TJ|\b(T\*|Td|TD|ET|Tj|')\b/g; let t;
    while ((t = tok.exec(content))) {
      const s = t[0];
      if (s.startsWith('[')) line += [...s.matchAll(/\((?:\\.|[^\\)])*\)|(-?\d+(?:\.\d+)?)/g)].map(x => x[1] !== undefined ? (Number(x[1]) < -200 ? ' ' : '') : unescapePdf(x[0].slice(1, -1))).join('');
      else if (s.startsWith('(')) line += unescapePdf(s.slice(1, -1));
      else if (['T*', 'Td', 'TD', 'ET', "'"].includes(s)) { if (line.trim()) lines.push(line.trim()); line = ''; }
    }
    if (line.trim()) lines.push(line.trim());
    out.push(lines.join('\n'));
  }
  return out.filter(Boolean).join('\n\n');
}
