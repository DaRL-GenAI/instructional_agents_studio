// ws/history.js — one file's versions: the commits that changed it (local app) or its stage's own history (browser
// edition); their text (slides and Word files as their text index) for a diff; and restoring one. A stage's file is
// restored through the store (a new version of the stage, with history and audit); a plain file through git.
import { el, button } from '../ui.js';
import { api } from '../fs/api.js';
import { diffLines, hunkRows } from '../diff.js';
import { readPptx, deckBlob, commitDeck, deckManifest } from '../pptxdeck.js';
import { docBlob, commitDoc, docManifest } from '../docstage.js';
import { docxToMd } from '../docconv.js';
import { slidesText } from '../linkage.js';

const enc = p => p.split('/').map(encodeURIComponent).join('/');

/** [{ id, label, message, at, current, read() → Blob }], newest first; the first is the file as it is now. */
export async function fileVersions(ws, path) {
  const out = [];
  const cur = await ws.src.read(path).catch(() => null);
  if (cur) out.push({ id: 'current', label: 'Current', current: true, at: null, read: async () => cur.blob });
  if (ws.src.kind === 'local') {
    const P = `/api/projects/${encodeURIComponent(ws.id)}`;
    const { commits } = await api(`${P}/history/${enc(path)}`);
    for (const c of commits) out.push({ id: c.oid, label: c.oid.slice(0, 7), message: c.message, at: c.at, read: async () => (await api(`${P}/at/${c.oid}/${enc(path)}`, { raw: true })).blob() });
    return out;
  }
  const info = ws.ownerInfo(path); if (!info) return out;
  if (out[0]) out[0].label = `Current · v${info.stage.version}`;
  for (const h of [...(info.stage.history || [])].reverse()) {
    if (!h.output) continue;
    out.push({ id: `v${h.version}`, label: `v${h.version}`, message: h.reason || '', at: h.at, output: h.output, read: () => outputBlob(ws, info, h.output) });
  }
  return out;
}
async function outputBlob(ws, info, output) {
  const store = ws.ctx.store;
  if (deckManifest(output)) return deckBlob(store, info.chapter.id, output);
  if (docManifest(output)) return docBlob(store, info.chapter.id, info.stageId, output);
  return new Blob([output], { type: 'text/plain' });
}

/** A version as text: .pptx → its slides' text (with notes), .docx → Markdown, else the text itself. */
export async function versionText(path, blob) {
  if (!blob) return '';
  if (/\.pptx$/i.test(path)) return slidesText(await readPptx(blob));
  if (/\.docx$/i.test(path)) return docxToMd(blob);
  return blob.text();
}

/** Restore `path` to version v: a stage's file through the store, a plain file through the local server (git). */
export async function restoreVersion(ws, path, v) {
  const info = ws.ownerInfo(path); const store = ws.ctx.store;
  const message = `edit: restore ${path} @${v.id.slice(0, 7)}`;
  if (info) {
    const blob = await v.read(); if (!blob) throw new Error('That version is not available');
    const meta = { label: info.label, where: info.where };
    if (/\.pptx$/i.test(path)) await commitDeck(store, info.chapter.id, blob, { ...meta, name: deckManifest(info.stage.output)?.name });
    else if (/\.docx$/i.test(path)) await commitDoc(store, info.chapter.id, info.stageId, blob, { ...meta, name: docManifest(info.stage.output)?.name });
    else store.userEdit(info.stage, info.label, await blob.text(), info.where);
    store.log({ type: 'restore', stage: info.label, where: info.where, note: `restored ${v.label}` });
    await store.flush({ message });
    return;
  }
  if (ws.src.kind !== 'local') throw new Error('Only a stage’s file can be restored in the browser edition');
  await api(`/api/projects/${encodeURIComponent(ws.id)}/restore`, { method: 'POST', body: { path, oid: v.id } });
}

// ---------------------------------------------------------------- the diff dialog
function inlineRows(a, hunks) {
  if (!hunks.length) return [el('p', { class: 'meta hist-same' }, 'No differences')];
  return hunks.map(h => el('div', { class: 'hist-hunk' }, el('div', { class: 'hist-hunk-head meta' }, `line ${h.a + 1}`),
    el('pre', { class: 'ag-diff' }, ...hunkRows(a, h, 3).map(r => el('div', { class: `ag-line ${r.kind === '+' ? 'add' : r.kind === '-' ? 'del' : ''}` }, el('span', { class: 'sign', 'aria-hidden': 'true' }, r.kind), r.text || ' ')))));
}
function sideRows(a, hunks) {
  if (!hunks.length) return [el('p', { class: 'meta hist-same' }, 'No differences')];
  return hunks.map(h => {
    const rows = hunkRows(a, h, 3); const out = []; let del = [], add = [];
    const flush = () => { for (let i = 0; i < Math.max(del.length, add.length); i++) out.push([del[i] ?? null, add[i] ?? null]); del = []; add = []; };
    for (const r of rows) { if (r.kind === '-') del.push(r); else if (r.kind === '+') add.push(r); else { flush(); out.push([r, r]); } }
    flush();
    const cell = (r, side) => el('td', { class: !r ? 'gap' : r.kind === ' ' ? '' : side === 'a' ? 'del' : 'add' }, r ? r.text || ' ' : '');
    return el('table', { class: 'hist-side' }, el('tbody', {}, ...out.map(([x, y]) => el('tr', {}, cell(x, 'a'), cell(y, 'b')))));
  });
}
/** Show the change from version a to version b ({ label, text }). */
export function showDiff({ path, a, b }) {
  const hunks = diffLines(a.text, b.text);
  let mode = 'inline';
  const body = el('div', { class: 'hist-body' });
  const render = () => { body.replaceChildren(...(mode === 'inline' ? inlineRows(a.text, hunks) : [el('div', { class: 'hist-cols meta' }, el('span', {}, a.label), el('span', {}, b.label)), ...sideRows(a.text, hunks)])); for (const x of seg.children) x.setAttribute('aria-pressed', String(x.dataset.m === mode)); };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Diff layout' }, ...[['inline', 'Inline'], ['side', 'Side by side']].map(([m, l]) => el('button', { type: 'button', dataset: { m }, onClick: () => { mode = m; render(); } }, l)));
  const dlg = el('dialog', { class: 'dlg hist-dlg', 'aria-label': `Changes in ${path}` });
  dlg.append(el('div', { class: 'dlg-body' },
    el('div', { class: 'hist-top' }, el('h3', {}, path.split('/').pop()), el('span', { class: 'meta' }, `${a.label} → ${b.label}`), el('span', { class: 'spacer' }), seg,
      button({ icon: 'x', size: 'sm', variant: 'ghost', title: 'Close', onClick: () => dlg.close() })),
    el('p', { class: 'meta' }, hunks.length ? `${hunks.length} change${hunks.length > 1 ? 's' : ''}` : ''), body));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg); render(); dlg.showModal();
  return dlg;
}
