// views/pptxeditor.js — the chapter deck opened in a presentation editor (ONLYOFFICE, run in the browser by the
// document-editor build at settings.editorUrl). The editor is a full-screen layer outside #main, so app re-renders
// never reload it; it talks to Studio over the editor's postMessage API (open-buffer in, save → File out), and every
// save is committed as a new version of the slides stage.
import { el, button, toast, confirmDialog, icon } from '../ui.js';
import { account, DEFAULT_SETTINGS } from '../state.js';
import { deckBlob, commitDeck, deckManifest } from '../pptxdeck.js';

let open = null; // the one editor layer, while it is open

export function editorBase() { return String(account.settings.editorUrl || DEFAULT_SETTINGS.editorUrl).replace(/\/+$/, ''); }

export async function openPptxEditor(ctx, o) {
  if (open) { open.layer.querySelector('iframe')?.focus(); return; }
  const { store } = ctx; const ch = o.chapter;
  const blob = await deckBlob(store, ch.id, o.stage.output);
  if (!blob) return toast('The deck file is missing from this browser. Re-run Slides or import a .pptx.', 'error');

  const base = editorBase(); const origin = new URL(base).origin;
  const fileName = `${ch.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'slides'}.pptx`;
  const frame = el('iframe', { class: 'pptx-frame', title: `Slides editor · ${ch.title}`, allow: 'clipboard-read; clipboard-write; fullscreen', src: `${base}/editor?embed=1&locale=${encodeURIComponent(account.settings.language || 'en')}&embedOrigin=${encodeURIComponent(location.origin)}` });
  const status = el('span', { class: 'pptx-status', role: 'status', 'aria-live': 'polite' }, 'Loading editor…');
  const saveBtn = button({ label: 'Save', icon: 'check', variant: 'primary', size: 'sm', disabled: true, onClick: () => save() });
  const closeBtn = button({ label: 'Close', size: 'sm', variant: 'ghost', onClick: () => close() });
  const layer = el('div', { class: 'pptx-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit slides: ${ch.title}` },
    el('div', { class: 'pptx-bar' }, icon('presentation'), el('b', {}, ch.title), status, el('span', { class: 'spacer' }), saveBtn, closeBtn),
    frame);
  document.body.append(layer); document.body.classList.add('pptx-open');

  const state = { ready: false, opened: false, dirty: false, saving: null };
  const setStatus = (s, text) => { status.dataset.s = s; status.textContent = text; };
  const send = (type, payload = {}) => frame.contentWindow?.postMessage({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, type, payload }, origin);
  const loadTimer = setTimeout(() => { if (!state.ready) setStatus('error', `The editor at ${origin} did not respond`); }, 45000);

  const onMessage = async e => {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    const { type, payload = {} } = e.data || {};
    if (!type?.startsWith('document:')) return;
    if (type === 'document:ready' && !state.ready) { state.ready = true; clearTimeout(loadTimer); setStatus('', 'Opening…'); send('document:open-buffer', { fileName, buffer: await blob.arrayBuffer(), readonly: false }); }
    if (type === 'document:opened') { state.opened = true; setStatus('ok', 'Saved'); }
    if (type === 'document:dirty-changed') { state.dirty = !!payload.dirty; saveBtn.disabled = !state.dirty || !!state.saving; setStatus(state.dirty ? 'dirty' : 'ok', state.dirty ? 'Unsaved changes' : 'Saved'); }
    if (type === 'document:saved') state.saving?.resolve(payload);
    if (type === 'document:error') { if (state.saving) state.saving.reject(new Error(payload.message || 'Save failed')); else setStatus('error', payload.message || 'Editor error'); }
  };
  const onUnload = e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('message', onMessage); addEventListener('beforeunload', onUnload);

  async function save() {
    if (!state.opened || !state.dirty || state.saving) return false;
    saveBtn.disabled = true; setStatus('', 'Saving…');
    try {
      const payload = await new Promise((resolve, reject) => { state.saving = { resolve, reject }; send('document:save', { targetExt: 'PPTX' }); setTimeout(() => reject(new Error('The editor did not return the file in time')), 60000); });
      const changed = await commitDeck(store, ch.id, payload.file, { name: deckManifest(o.stage.output)?.name, label: o.label, where: ch.title });
      state.dirty = !!payload.dirty;
      setStatus(state.dirty ? 'dirty' : 'ok', changed ? `Saved as v${store.chapterStage(ch.id, 'slides').version}` : 'No changes');
      ctx.render(); return true;
    } catch (err) { setStatus('error', err.message); toast(err.message, 'error'); return false; }
    finally { state.saving = null; saveBtn.disabled = !state.dirty; }
  }

  async function close() {
    if (state.dirty && !(await confirmDialog({ title: 'Discard unsaved slide edits?', body: 'Changes since the last save will be lost. Save first to keep them as a new version.', confirmLabel: 'Discard changes', danger: true }))) return;
    clearTimeout(loadTimer); removeEventListener('message', onMessage); removeEventListener('beforeunload', onUnload);
    layer.remove(); document.body.classList.remove('pptx-open'); open = null; ctx.render();
  }

  open = { layer, close };
}

/** Pick a .pptx and commit it as the chapter's deck (a new version; the previous one stays in History). */
export function importPptx(ctx, o) {
  const pick = el('input', { type: 'file', accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', style: 'display:none' });
  pick.onchange = async () => {
    const file = pick.files[0]; pick.remove(); if (!file) return;
    if (o.stage.output && !(await confirmDialog({ title: `Replace the slides of “${o.chapter.title}”?`, body: `${file.name} becomes the chapter’s deck. The current deck stays in History and can be restored.`, confirmLabel: 'Replace' }))) return;
    await ctx.guarded('Importing slides', async () => {
      const changed = await commitDeck(ctx.store, o.chapter.id, file, { name: file.name, label: o.label, where: o.chapter.title, reason: 'import' });
      toast(changed ? `Imported ${file.name}` : 'That file is already the current deck', changed ? 'ok' : undefined);
    });
  };
  document.body.append(pick); pick.click();
}
