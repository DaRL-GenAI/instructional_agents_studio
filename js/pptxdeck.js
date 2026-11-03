// pptxdeck.js — the chapter deck is a .pptx file. Every version is a blob in the media store keyed by its
// sha-256 (`deck:<sha>`); the slides stage output is a small manifest pointing at the current blob plus a
// read-only text index (title, bullets, notes per slide) re-read from the file on every commit, which the
// downstream prompts (script, homework, lab, quiz, storyboard) consume. The file is the only source of truth.
import { loadJSZip } from './export.js';
import { parseTemplate, resolvePath } from './template.js';
import { normalizeDeck, deckToPptx, resolveTheme } from './deck.js';
import { backend } from './fs/backend.js';

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TITLE_PH = new Set(['title', 'ctrTitle']);
const CHROME_PH = new Set(['dt', 'ftr', 'sldNum', 'hdr']);
const safeJson = (t, f) => { try { return JSON.parse(t); } catch { return f; } };

/** The manifest of a slides stage output, or null when the output is not a pptx deck (empty or legacy JSON). */
export function deckManifest(output) { const v = safeJson(output, null); return v && v.format === 'pptx' && v.sha ? v : null; }
export const isLegacyDeck = output => !!output && !deckManifest(output) && normalizeDeck(safeJson(output, null)).slides.length > 0;

export async function sha256(blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Read a .pptx in presentation order: [{ slide_id, title, bullets, notes }]. */
export async function readPptx(blob) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(blob);
  const xml = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const rels = async part => { const dir = part.slice(0, part.lastIndexOf('/') + 1); const doc = await xml(`${dir}_rels/${part.slice(dir.length)}.rels`); return doc ? [...doc.getElementsByTagName('Relationship')].map(r => ({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', target: resolvePath(dir, r.getAttribute('Target') || '') })) : []; };
  const paras = node => [...node.getElementsByTagNameNS('*', 'p')].filter(p => p.namespaceURI?.includes('drawingml')).map(p => [...p.getElementsByTagNameNS('*', 't')].map(t => t.textContent).join('').trim()).filter(Boolean);
  const phType = sp => sp.getElementsByTagNameNS('*', 'ph')[0]?.getAttribute('type') ?? (sp.getElementsByTagNameNS('*', 'ph')[0] ? 'body' : null);
  const pres = await xml('ppt/presentation.xml'); if (!pres) throw new Error('Not a PowerPoint file (ppt/presentation.xml is missing).');
  const presRels = await rels('ppt/presentation.xml');
  const slides = [];
  for (const id of [...pres.getElementsByTagNameNS('*', 'sldId')].map(n => n.getAttributeNS(NS_R, 'id'))) {
    const part = presRels.find(r => r.id === id)?.target; const doc = part && await xml(part); if (!doc) continue;
    const shapes = [...doc.getElementsByTagNameNS('*', 'sp')].filter(sp => !CHROME_PH.has(phType(sp)));
    const titleSp = shapes.find(sp => TITLE_PH.has(phType(sp)));
    // Free text boxes count as body text too: Studio-drawn slides and many hand-made decks use them.
    const body = shapes.filter(sp => sp !== titleSp).flatMap(paras);
    let title = titleSp ? paras(titleSp).join(' ') : '';
    if (!title && body.length) title = body.shift();
    const notesPart = (await rels(part)).find(r => /notesSlide$/.test(r.type))?.target; const nd = notesPart && await xml(notesPart);
    const notes = nd ? [...nd.getElementsByTagNameNS('*', 'sp')].filter(sp => phType(sp) === 'body').flatMap(paras).join('\n') : '';
    slides.push({ slide_id: slides.length + 1, title: title || `Slide ${slides.length + 1}`, bullets: body, notes });
  }
  // Footers drawn as plain text boxes (course name, "3 / 12"): drop page numbers and lines repeated on most slides.
  const seen = new Map(); for (const s of slides) for (const b of new Set(s.bullets)) seen.set(b, (seen.get(b) || 0) + 1);
  const boiler = b => /^\d+\s*(\/|of)\s*\d+$/i.test(b) || (slides.length >= 4 && seen.get(b) > slides.length / 2);
  for (const s of slides) s.bullets = s.bullets.filter(b => !boiler(b)).slice(0, 14);
  return slides;
}

/** A content signature per slide (presentation order): element names, attributes and text, so a file that was
 *  re-serialized (python-pptx, another editor) still matches where the slide itself did not change. */
export async function slideSignatures(blob) {
  const JSZip = await loadJSZip(); const zip = await JSZip.loadAsync(blob);
  const read = async p => { const f = zip.file(p); return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null; };
  const pres = await read('ppt/presentation.xml'); const rels = await read('ppt/_rels/presentation.xml.rels');
  if (!pres || !rels) throw new Error('Not a PowerPoint file (ppt/presentation.xml is missing).');
  const target = Object.fromEntries([...rels.getElementsByTagName('Relationship')].map(r => [r.getAttribute('Id'), resolvePath('ppt/', r.getAttribute('Target') || '')]));
  const sig = n => n.nodeType === 3 ? (n.nodeValue.trim() ? JSON.stringify(n.nodeValue) : '') : n.nodeType !== 1 ? '' : `${n.localName}(${[...n.attributes].filter(a => !a.name.startsWith('xmlns')).map(a => `${a.localName}=${a.value}`).sort().join(',')})[${[...n.childNodes].map(sig).join('')}]`;
  const out = [];
  for (const id of [...pres.getElementsByTagNameNS('*', 'sldId')].map(n => n.getAttributeNS(NS_R, 'id'))) { const doc = target[id] && await read(target[id]); out.push(doc ? await sha256(new Blob([sig(doc.documentElement)])) : ''); }
  return out;
}

/** What a revision did to the deck: slides outside `targets` (0-based) that changed, and the slide counts. */
export async function compareDecks(before, after, targets) {
  const [a, b] = await Promise.all([slideSignatures(before), slideSignatures(after)]);
  const left = new Map(); for (const h of b) left.set(h, (left.get(h) || 0) + 1);
  const keep = new Set(targets); const changedOutside = [];
  a.forEach((h, i) => { if (keep.has(i)) return; if (left.get(h)) left.set(h, left.get(h) - 1); else changedOutside.push(i + 1); });
  return { before: a.length, after: b.length, changedOutside };
}

/** Palette and fonts from the file's theme, in the shape resolveTheme() takes (used by the animated lesson). */
async function themeOf(blob, name) {
  try { const t = await parseTemplate(new File([blob], name || 'deck.pptx')); return { palette: t.palette, fonts: t.fonts }; } catch { return null; }
}

/** Store a deck version and build its manifest. `theme` overrides the palette read from the file (the generator's choice). */
export async function storeDeck(store, chapterId, blob, { name, theme } = {}) {
  const sha = await sha256(blob);
  await store.putMedia(chapterId, `deck:${sha}`, blob);
  const slides = await readPptx(blob);
  if (!slides.length) throw new Error('The presentation has no slides.');
  return JSON.stringify({ format: 'pptx', sha, name: name || 'slides.pptx', bytes: blob.size, theme: theme || await themeOf(blob, name), slides }, null, 2);
}

/** Commit an edited or imported file as a new version of the chapter's slides stage (versioned, logged, downstream marked stale). */
export async function commitDeck(store, chapterId, blob, { name, label = 'Slides', where, reason = 'edit' } = {}) {
  const st = store.chapterStage(chapterId, 'slides'); const prev = deckManifest(st.output);
  const output = await storeDeck(store, chapterId, blob, { name: name || prev?.name, theme: reason === 'edit' ? prev?.theme : undefined });
  if (deckManifest(output).sha === prev?.sha) return false;
  const changed = store.userEdit(st, label, output, where);
  if (changed && reason === 'import') store.log({ type: 'import', stage: label, where, file: name, bytes: blob.size });
  await pruneDecks(store, chapterId);
  return changed;
}

/** The current (or a given) version's file. */
export async function deckBlob(store, chapterId, output) {
  const m = deckManifest(output ?? store.chapterStage(chapterId, 'slides').output); if (!m) return null;
  return (await store.getMedia(chapterId, `deck:${m.sha}`)) || null;
}

/** Delete stored versions no longer referenced by the stage output or its history. */
export async function pruneDecks(store, chapterId) {
  const st = store.chapterStage(chapterId, 'slides');
  const keep = new Set([st.output, ...(st.history || []).map(h => h.output)].map(o => deckManifest(o)?.sha).filter(Boolean));
  const prefix = `${store.id}:${chapterId}:deck:`;
  for (const k of await store.mediaKeys(prefix)) if (!keep.has(k.slice(prefix.length))) await store.delMedia(chapterId, `deck:${k.slice(prefix.length)}`);
}

/** Render a JSON deck (the generator's draft, or a legacy saved deck) to a .pptx with the project's template. */
export async function draftToPptx(store, chapter, deck, script = []) {
  const p = store.project; const theme = resolveTheme(deck.theme, p.deck);
  const templateBlob = theme.tpl ? (await store.getMedia('project', 'template').catch(() => null))?.blob || null : null;
  return deckToPptx(deck, theme, { course: p.course.name, chapter: chapter.title }, script, { templateBlob });
}

/** One-time conversion of a chapter whose slides were saved as JSON. Returns true when the stage was converted. */
export async function migrateLegacyDeck(store, chapterId) {
  const ch = store.chapter(chapterId); const st = ch?.stages.slides;
  if (!st || !isLegacyDeck(st.output)) return false;
  const deck = normalizeDeck(safeJson(st.output, null)); const script = safeJson(ch.stages.script?.output, []) || [];
  const blob = await draftToPptx(store, ch, deck, Array.isArray(script) ? script : []);
  const output = await storeDeck(store, chapterId, blob, { name: 'slides.pptx', theme: deck.theme });
  return store.autoRevise(st, 'Slides', output, ch.title, 'converted to .pptx');
}

// ---------------------------------------------------------------- moving projects (export / import / duplicate)
/** Current deck file of every chapter as base64, for the project JSON export. */
export async function packDecks(project) {
  const out = {};
  for (const ch of project.chapters || []) {
    const m = deckManifest(ch.stages?.slides?.output); if (!m) continue;
    const blob = await backend.getMedia(project.id, ch.id, `deck:${m.sha}`); if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out[ch.id] = { sha: m.sha, data: btoa(bin) };
  }
  return out;
}
/** Restore packed deck files under a (new) project id. */
export async function unpackDecks(projectId, packed = {}) {
  for (const [chId, { sha, data }] of Object.entries(packed || {})) {
    const bin = atob(data); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await backend.putMedia(projectId, chId, `deck:${sha}`, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
  }
}
/** Copy every stored deck version from one project to another (duplicate). */
export async function copyDecks(fromId, toId) {
  for (const k of await backend.mediaKeys(fromId)) { const m = k.match(/^[^:]+:([^:]+):(deck:[0-9a-f]+)$/); if (m) await backend.putMedia(toId, m[1], m[2], await backend.getMedia(fromId, m[1], m[2])); }
}
