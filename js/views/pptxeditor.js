// views/pptxeditor.js — the chapter deck opened in a presentation editor (ONLYOFFICE, run in the browser by the
// document-editor build at settings.editorUrl). The editor is a full-screen layer outside #main, so app re-renders
// never reload it; it talks to Studio over the editor's postMessage API (open-buffer in, save → File out), and every
// save is committed as a new version of the slides stage.
import { el, button, toast, confirmDialog, icon, field, input, textarea, select, notice } from '../ui.js';
import { account, DEFAULT_SETTINGS } from '../state.js';
import { deckBlob, commitDeck, deckManifest, compareDecks } from '../pptxdeck.js';
import { READ_MACRO, APPLY_MACRO, parseSlideRange, revisionMessages, parseRevision, describeOps, AGENT_NAMES, bridgeHealth, bridgeRevise, bridgeCancel } from '../slideagent.js';

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
  const reviseBtn = button({ label: 'Revise', icon: 'message', size: 'sm', disabled: true, onClick: () => toggleRevise(), attrs: { 'aria-expanded': 'false' } });
  const side = el('aside', { class: 'pptx-side', 'aria-label': 'Revise slides', hidden: true });
  const closeBtn = button({ label: 'Close', size: 'sm', variant: 'ghost', onClick: () => close() });
  const layer = el('div', { class: 'pptx-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit slides: ${ch.title}` },
    el('div', { class: 'pptx-bar' }, icon('presentation'), el('b', {}, ch.title), status, el('span', { class: 'spacer' }), reviseBtn, saveBtn, closeBtn),
    el('div', { class: 'pptx-body' }, frame, side));
  document.body.append(layer); document.body.classList.add('pptx-open');

  const state = { ready: false, opened: false, dirty: false, saving: null };
  const setStatus = (s, text) => { status.dataset.s = s; status.textContent = text; };
  const send = (type, payload = {}, id = `${Date.now()}-${Math.random().toString(16).slice(2)}`) => { frame.contentWindow?.postMessage({ id, type, payload }, origin); return id; };
  // Request/reply by message id (run-macro). An editor without the call never answers, hence the timeout.
  const pending = new Map();
  const request = (type, payload, ms = 30000) => new Promise((resolve, reject) => {
    const id = send(type, payload); const t = setTimeout(() => { pending.delete(id); reject(new Error('The editor did not answer. Slide revision needs the self-hosted editor (Account → Slides editor).')); }, ms);
    pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
  });
  const macro = async (code, args, readonly = false) => (await request('document:run-macro', { code, args, readonly })).result;
  const loadTimer = setTimeout(() => { if (!state.ready) setStatus('error', `The editor at ${origin} did not respond`); }, 45000);

  const onMessage = async e => {
    if (e.origin !== origin || e.source !== frame.contentWindow) return;
    const { type, payload = {} } = e.data || {};
    if (!type?.startsWith('document:')) return;
    const waiter = e.data.id && pending.get(e.data.id);
    if (waiter) { pending.delete(e.data.id); return type === 'document:error' ? waiter.reject(new Error(payload.message || 'Editor error')) : waiter.resolve(payload); }
    if (type === 'document:ready' && !state.ready) { state.ready = true; clearTimeout(loadTimer); setStatus('', 'Opening…'); send('document:open-buffer', { fileName, buffer: await blob.arrayBuffer(), readonly: false }); }
    if (type === 'document:opened') { state.opened = true; reviseBtn.disabled = false; setStatus('ok', 'Saved'); }
    if (type === 'document:dirty-changed') { state.dirty = !!payload.dirty; saveBtn.disabled = !state.dirty || !!state.saving; setStatus(state.dirty ? 'dirty' : 'ok', state.dirty ? 'Unsaved changes' : 'Saved'); }
    if (type === 'document:saved') state.saving?.resolve(payload);
    // Ctrl+S / the editor's own download (self-hosted editor): the deck commits, other formats download.
    if (type === 'document:exported' && payload.file) { if (payload.regularSave) commit(payload.file, payload.dirty).catch(err => { setStatus('error', err.message); toast(err.message, 'error'); }); else downloadFile(payload.file); }
    if (type === 'document:error') { if (state.saving) state.saving.reject(new Error(payload.message || 'Save failed')); else setStatus('error', payload.message || 'Editor error'); }
  };
  const onUnload = e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('message', onMessage); addEventListener('beforeunload', onUnload);

  async function save() {
    if (!state.opened || !state.dirty || state.saving) return false;
    saveBtn.disabled = true; setStatus('', 'Saving…');
    try {
      const payload = await new Promise((resolve, reject) => { state.saving = { resolve, reject }; send('document:save', { targetExt: 'PPTX' }); setTimeout(() => reject(new Error('The editor did not return the file in time')), 60000); });
      return await commit(payload.file, payload.dirty);
    } catch (err) { setStatus('error', err.message); toast(err.message, 'error'); return false; }
    finally { state.saving = null; saveBtn.disabled = !state.dirty; }
  }

  async function commit(file, dirty) {
    rv.pending = null;
    const changed = await commitDeck(store, ch.id, file, { name: deckManifest(o.stage.output)?.name, label: o.label, where: ch.title });
    state.dirty = !!dirty; saveBtn.disabled = !state.dirty || !!state.saving;
    setStatus(state.dirty ? 'dirty' : 'ok', changed ? `Saved as v${store.chapterStage(ch.id, 'slides').version}` : 'No changes');
    ctx.render(); return true;
  }

  function downloadFile(file) {
    const a = el('a', { href: URL.createObjectURL(file), download: `${fileName.replace(/\.pptx$/i, '')}.${(file.name.split('.').pop() || 'bin').toLowerCase()}` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function close() {
    if ((state.dirty || rv.pending) && !(await confirmDialog({ title: 'Discard unsaved slide edits?', body: 'Changes since the last save will be lost. Save first to keep them as a new version.', confirmLabel: 'Discard changes', danger: true }))) return;
    clearTimeout(loadTimer); removeEventListener('message', onMessage); removeEventListener('beforeunload', onUnload);
    layer.remove(); document.body.classList.remove('pptx-open'); open = null; ctx.render();
  }

  // ---------------------------------------------------------------- targeted revision
  const rv = { built: false, running: false, pending: null };
  const openBuffer = async b => { await request('document:open-buffer', { fileName, buffer: await b.arrayBuffer(), readonly: false }, 120000); state.dirty = false; saveBtn.disabled = true; setStatus('ok', 'Saved'); };
  async function toggleRevise() {
    side.hidden = !side.hidden; reviseBtn.setAttribute('aria-expanded', String(!side.hidden));
    if (side.hidden) return;
    if (!rv.built) buildRevise();
    try { const d = await macro(READ_MACRO, null, true); rv.count = d.count; if (!rv.touched) rv.slides.value = String(d.current + 1); } catch (err) { rv.out.replaceChildren(notice('error', err.message)); }
    rv.text.focus();
    let agents = {}; if (account.settings.bridgeToken) try { agents = (await bridgeHealth(account.settings)).agents || {}; } catch { agents = {}; }
    for (const opt of rv.agent.options) if (opt.value !== 'builtin') { opt.disabled = !agents[opt.value]; opt.textContent = AGENT_NAMES[opt.value] + (agents[opt.value] ? '' : ' · not connected'); }
    if (rv.agent.selectedOptions[0]?.disabled) rv.agent.value = 'builtin';
  }
  function buildRevise() {
    rv.built = true;
    rv.slides = input({ id: 'rv-slides', placeholder: 'e.g. 2, 5-7', inputmode: 'numeric', oninput: () => { rv.touched = true; } });
    rv.text = textarea({ id: 'rv-text', rows: 5, placeholder: 'Tighten the bullets and add an example' });
    rv.agent = select(Object.entries(AGENT_NAMES), 'builtin', { id: 'rv-agent' });
    rv.run = button({ label: 'Run', icon: 'play', variant: 'primary', onClick: () => rv.running ? stopRevision() : runRevision() });
    rv.out = el('div', { class: 'pptx-side-out', 'aria-live': 'polite' });
    side.append(field('Slides', rv.slides, { id: 'rv-slides' }), field('Instruction', rv.text, { id: 'rv-text' }), field('Agent', rv.agent, { id: 'rv-agent' }), rv.run, rv.out);
    rv.text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runRevision(); });
  }
  function stopRevision() {
    rv.stopped = true;
    if (rv.abort) { rv.abort.abort(); bridgeCancel(account.settings); } else ctx.pipe?.cancel();
  }
  async function runRevision() {
    const agent = rv.agent.value;
    if (rv.running || rv.pending || (agent === 'builtin' && !ctx.requireKey())) return;
    const instruction = rv.text.value.trim(); if (!instruction) { rv.text.focus(); return; }
    const setRun = on => { rv.running = on; rv.run.lastChild.textContent = on ? 'Stop' : 'Run'; };
    rv.stopped = false; setRun(true); rv.out.replaceChildren(el('p', { class: 'muted' }, 'Reading slides…'));
    try {
      const targets = parseSlideRange(rv.slides.value, rv.count || (await macro(READ_MACRO, null, true)).count);
      if (agent === 'builtin') await runBuiltin(targets, instruction); else await runAgent(agent, targets, instruction);
    } catch (err) { rv.out.replaceChildren(rv.stopped ? notice('info', 'Stopped.') : notice('error', err.message)); }
    finally { setRun(false); rv.abort = null; }
  }
  const logRevision = (agent, targets, instruction, extra) => { store.log({ type: 'slide_revision', where: ch.title, stage: o.label, agent, slides: targets.map(i => i + 1), instruction: instruction.slice(0, 500), ...extra }); store.save(); };

  async function runBuiltin(targets, instruction) {
    const deck = await macro(READ_MACRO, { slides: targets }, true);
    rv.out.replaceChildren(el('p', { class: 'muted' }, 'Thinking…'));
    const res = await ctx.pipe.call({ where: ch.title, stage: o.label, agent: 'Slide reviser', messages: revisionMessages({ course: store.project.course.name, chapter: ch.title, deck, instruction }), json: true });
    const { summary, ops } = parseRevision(res.text, deck, targets);
    if (!ops.length) { rv.out.replaceChildren(notice('info', summary || 'No changes suggested.')); return; }
    await macro(APPLY_MACRO, { ops });
    logRevision('built-in', targets, instruction, { ops: ops.length });
    rv.out.replaceChildren(...(summary ? [el('p', {}, summary)] : []), el('ul', {}, ...describeOps(ops).map(t => el('li', {}, t))));
  }

  // Claude Code / Codex edit the saved deck on this machine; the result is previewed in the editor until kept or discarded.
  async function runAgent(agent, targets, instruction) {
    if (state.dirty && !(await save())) return;
    const base = await deckBlob(store, ch.id);
    const steps = el('ol', { class: 'pptx-steps' }); rv.out.replaceChildren(steps);
    rv.abort = new AbortController();
    const { summary, file } = await bridgeRevise(account.settings, { agent, slides: targets.map(i => i + 1), instruction, chapter: ch.title, blob: base }, {
      signal: rv.abort.signal, onProgress: t => { steps.append(el('li', {}, t)); while (steps.children.length > 6) steps.firstChild.remove(); },
    });
    const check = await compareDecks(base, file, targets);
    await openBuffer(file);
    rv.pending = { agent, targets, instruction, file, base, check };
    const keep = button({ label: 'Keep', icon: 'check', variant: 'primary', onClick: () => keepAgent() });
    const discard = button({ label: 'Discard', variant: 'ghost', onClick: () => discardAgent() });
    rv.out.replaceChildren(
      ...(summary ? [el('p', {}, summary)] : []),
      ...(check.after !== check.before ? [el('p', { class: 'muted' }, `${check.before} → ${check.after} slides`)] : []),
      ...(check.changedOutside.length ? [notice('warn', `Also changed slide${check.changedOutside.length > 1 ? 's' : ''} ${check.changedOutside.join(', ')}, outside your selection.`)] : []),
      el('div', { class: 'btn-row' }, keep, discard));
  }
  async function keepAgent() {
    const p = rv.pending; if (!p) return;
    const ok = state.dirty ? await save() : await commit(p.file, false).catch(err => { toast(err.message, 'error'); return false; });
    if (!ok) return;
    logRevision(p.agent, p.targets, p.instruction, { changedOutside: p.check.changedOutside, slidesBefore: p.check.before, slidesAfter: p.check.after });
    rv.out.replaceChildren(el('p', { class: 'muted' }, status.textContent));
  }
  async function discardAgent() {
    const p = rv.pending; if (!p) return;
    try { await openBuffer(p.base); rv.pending = null; rv.out.replaceChildren(); } catch (err) { toast(err.message, 'error'); }
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
