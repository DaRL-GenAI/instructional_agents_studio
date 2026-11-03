// docstage.js — a chapter stage (homework, lab) whose file is a Word document instead of Markdown. Like the slides
// deck (pptxdeck.js), every version of the .docx is a blob in the media store (`doc:<sha256>`) and the stage output
// is a small manifest { format: 'docx', sha, name, bytes, text }: `text` is the document read back as Markdown, which
// previews, reviews and revision prompts use. In the project folder the stage's file becomes chapters/NN/<stage>.docx.
import { mdToDocx, docxToMd, DOCX_TYPE } from './docconv.js';
import { binaryOf } from './fs/serialize.js';
import { sha256 } from './pptxdeck.js';

export const CONVERTIBLE = new Set(['homework', 'lab']); // chapter stages that can switch between .md and .docx

/** The manifest of a Word stage output, or null. */
export function docManifest(output) { if (binaryOf(output)?.format !== 'docx') return null; try { return JSON.parse(output); } catch { return null; } }
/** The stage's text: the Markdown itself, or what the Word document says. */
export const outputText = output => docManifest(output)?.text ?? output;

/** Store one version of a Word file and build its manifest. */
export async function storeDoc(store, chapterId, blob, { name } = {}) {
  const sha = await sha256(blob);
  await store.putMedia(chapterId, `doc:${sha}`, blob instanceof File || blob.type ? blob : new Blob([blob], { type: DOCX_TYPE }));
  const text = await docxToMd(blob);
  return JSON.stringify({ format: 'docx', sha, name: name || 'document.docx', bytes: blob.size, text }, null, 2);
}

/** Commit an edited, imported or converted file as a new version of the stage (versioned, logged). */
export async function commitDoc(store, chapterId, stageId, blob, { name, label, where, reason = 'edit' } = {}) {
  const st = store.chapterStage(chapterId, stageId); const prev = docManifest(st.output);
  const output = await storeDoc(store, chapterId, blob, { name: name || prev?.name || `${stageId}.docx` });
  if (docManifest(output).sha === prev?.sha) return false;
  const changed = store.userEdit(st, label, output, where);
  if (changed && reason !== 'edit') { st.origin = reason; store.log({ type: reason === 'import' ? 'import' : 'convert', stage: label, where, file: name, to: 'docx', bytes: blob.size }); store.save(); }
  await pruneDocs(store, chapterId, stageId);
  return changed;
}

/** The current (or a given) version's file. */
export async function docBlob(store, chapterId, stageId, output) {
  const m = docManifest(output ?? store.chapterStage(chapterId, stageId).output); if (!m) return null;
  return (await store.getMedia(chapterId, `doc:${m.sha}`)) || null;
}

/** Delete stored versions no longer referenced by any Word stage of the chapter (output or history). */
export async function pruneDocs(store, chapterId) {
  const ch = store.chapter(chapterId); if (!ch) return;
  const keep = new Set(); for (const st of Object.values(ch.stages || {})) for (const o of [st?.output, ...(st?.history || []).map(h => h.output)]) { const m = docManifest(o); if (m) keep.add(m.sha); }
  const prefix = `${store.id}:${chapterId}:doc:`;
  for (const k of await store.mediaKeys(prefix)) if (!keep.has(k.slice(prefix.length))) await store.delMedia(chapterId, `doc:${k.slice(prefix.length)}`);
}

/** Markdown stage → Word: the stage's file becomes <stage>.docx (the Markdown stays in History). */
export async function convertToWord(store, chapter, stageId, { label, where } = {}) {
  const st = store.chapterStage(chapter.id, stageId);
  if (!st.output || docManifest(st.output)) throw new Error('Nothing to convert');
  const bytes = await mdToDocx(st.output, { title: `${chapter.title}: ${stageId}` });
  return commitDoc(store, chapter.id, stageId, new Blob([bytes], { type: DOCX_TYPE }), { name: `${stageId}.docx`, label, where, reason: 'convert' });
}

/** Word stage → Markdown: the stage's file becomes <stage>.md again (the .docx stays in History). */
export async function convertToMarkdown(store, chapter, stageId, { label, where } = {}) {
  const st = store.chapterStage(chapter.id, stageId); const blob = await docBlob(store, chapter.id, stageId);
  if (!blob) throw new Error('The Word file is missing');
  const md = await docxToMd(blob);
  const changed = store.userEdit(st, label, md, where);
  if (changed) { st.origin = 'convert'; store.log({ type: 'convert', stage: label, where, to: 'md', chars: md.length }); store.save(); }
  return changed;
}

/** New Markdown from the generator for a stage that is a Word document: write it as the next .docx version. */
export async function asDocOutput(store, chapter, stageId, md) {
  const bytes = await mdToDocx(md, { title: `${chapter.title}: ${stageId}` });
  return storeDoc(store, chapter.id, new Blob([bytes], { type: DOCX_TYPE }), { name: docManifest(store.chapterStage(chapter.id, stageId).output)?.name || `${stageId}.docx` });
}

// ---------------------------------------------------------------- project files (export / import)
/** Every stored Word file the stages reference (current versions), as base64: { chapterId: [{ sha, data }] }. */
export async function packDocs(project, getMedia) {
  const out = {};
  for (const ch of project.chapters || []) for (const st of Object.values(ch.stages || {})) {
    const m = docManifest(st?.output); if (!m) continue;
    const blob = await getMedia(project.id, ch.id, `doc:${m.sha}`); if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    (out[ch.id] ||= []).push({ sha: m.sha, data: btoa(bin) });
  }
  return out;
}
export async function unpackDocs(projectId, packed, putMedia) {
  for (const [chId, list] of Object.entries(packed || {})) for (const { sha, data } of list || []) {
    const bin = atob(data); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await putMedia(projectId, chId, `doc:${sha}`, new Blob([bytes], { type: DOCX_TYPE }));
  }
}
