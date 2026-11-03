// views/pptxeditor.js — the chapter deck opened full screen in the presentation editor (an OfficeFrame, see
// officeeditor.js). The layer lives outside #main, so app re-renders never reload it; every save is committed as a
// new version of the slides stage. The Workspace opens the same deck in a tab instead.
import { el, button, toast, confirmDialog, icon, field, input, textarea, select, notice } from '../ui.js';
import { LOCAL } from '../fs/api.js';
import { deckBlob, commitDeck, deckManifest, compareDecks } from '../pptxdeck.js';
import { READ_MACRO, APPLY_MACRO, parseSlideRange, revisionMessages, parseRevision, describeOps, AGENT_NAMES, bridgeHealth, bridgeRevise, bridgeCancel } from '../slideagent.js';
import { OfficeFrame, editorBase, downloadFile } from './officeeditor.js';
export { editorBase };

let open = null; // the one editor layer, while it is open

export async function openPptxEditor(ctx, o) {
  if (open) { open.layer.querySelector('iframe')?.focus(); return; }
  const { store } = ctx; const ch = o.chapter;
  const blob = await deckBlob(store, ch.id, o.stage.output);
  if (!blob) return toast('The deck file is missing from this browser. Re-run Slides or import a .pptx.', 'error');

  const fileName = `${ch.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'slides'}.pptx`;
  const status = el('span', { class: 'pptx-status', role: 'status', 'aria-live': 'polite' }, 'Loading editor…');
  const setStatus = (s, text) => { status.dataset.s = s; status.textContent = text; };
  const state = { dirty: false, saving: false };
  const office = new OfficeFrame({
    fileName, title: `Slides editor · ${ch.title}`,
    onStatus: setStatus,
    onDirty: d => { state.dirty = d; saveBtn.disabled = !d || state.saving; if (office.state.opened) setStatus(d ? 'dirty' : 'ok', d ? 'Unsaved changes' : 'Saved'); },
    // Ctrl+S / the editor's own download (self-hosted editor): the deck commits, other formats download.
    onExported: (file, { regularSave, dirty }) => { if (regularSave) commit(file, dirty).catch(err => { setStatus('error', err.message); toast(err.message, 'error'); }); else downloadFile(file, `${fileName.replace(/\.pptx$/i, '')}.${(file.name.split('.').pop() || 'bin').toLowerCase()}`); },
  });
  const frame = office.el; frame.classList.add('pptx-frame');
  const saveBtn = button({ label: 'Save', icon: 'check', variant: 'primary', size: 'sm', disabled: true, onClick: () => save() });
  const reviseBtn = button({ label: 'Revise', icon: 'message', size: 'sm', disabled: true, onClick: () => toggleRevise(), attrs: { 'aria-expanded': 'false' } });
  const side = el('aside', { class: 'pptx-side', 'aria-label': 'Revise slides', hidden: true });
  const closeBtn = button({ label: 'Close', size: 'sm', variant: 'ghost', onClick: () => close() });
  const layer = el('div', { class: 'pptx-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit slides: ${ch.title}` },
    el('div', { class: 'pptx-bar' }, icon('presentation'), el('b', {}, ch.title), status, el('span', { class: 'spacer' }), reviseBtn, saveBtn, closeBtn),
    el('div', { class: 'pptx-body' }, frame, side));
  document.body.append(layer); document.body.classList.add('pptx-open');
  office.load(blob).then(() => { reviseBtn.disabled = false; setStatus('ok', 'Saved'); }, err => setStatus('error', err.message));

  const macro = (code, args, readonly = false) => office.macro(code, args, readonly);
  const onUnload = e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', onUnload);

  async function save() {
    if (!office.state.opened || !state.dirty || state.saving) return false;
    state.saving = true; saveBtn.disabled = true; setStatus('', 'Saving…');
    try { const { file, dirty } = await office.save('PPTX'); return await commit(file, dirty); }
    catch (err) { setStatus('error', err.message); toast(err.message, 'error'); return false; }
    finally { state.saving = false; saveBtn.disabled = !state.dirty; }
  }

  async function commit(file, dirty) {
    rv.pending = null;
    const changed = await commitDeck(store, ch.id, file, { name: deckManifest(o.stage.output)?.name, label: o.label, where: ch.title });
    state.dirty = !!dirty; saveBtn.disabled = !state.dirty || state.saving;
    setStatus(state.dirty ? 'dirty' : 'ok', changed ? `Saved as v${store.chapterStage(ch.id, 'slides').version}` : 'No changes');
    ctx.render(); return true;
  }

  async function close() {
    if ((state.dirty || rv.pending) && !(await confirmDialog({ title: 'Discard unsaved slide edits?', body: 'Changes since the last save will be lost. Save first to keep them as a new version.', confirmLabel: 'Discard changes', danger: true }))) return;
    office.destroy(); removeEventListener('beforeunload', onUnload);
    layer.remove(); document.body.classList.remove('pptx-open'); open = null; ctx.render();
  }

  // ---------------------------------------------------------------- targeted revision
  const rv = { built: false, running: false, pending: null };
  const openBuffer = async b => { await office.openBuffer(b); state.dirty = false; saveBtn.disabled = true; setStatus('ok', 'Saved'); };
  async function toggleRevise() {
    side.hidden = !side.hidden; reviseBtn.setAttribute('aria-expanded', String(!side.hidden));
    if (side.hidden) return;
    if (!rv.built) buildRevise();
    try { const d = await macro(READ_MACRO, null, true); rv.count = d.count; if (!rv.touched) rv.slides.value = String(d.current + 1); } catch (err) { rv.out.replaceChildren(notice('error', err.message)); }
    rv.text.focus();
    let agents = {}; if (LOCAL) try { agents = (await bridgeHealth()).agents || {}; } catch { agents = {}; }
    for (const opt of rv.agent.options) if (opt.value !== 'builtin') { opt.disabled = !agents[opt.value]; opt.textContent = AGENT_NAMES[opt.value] + (agents[opt.value] ? '' : LOCAL ? ' · not installed' : ' · local app only'); }
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
    if (rv.abort) { rv.abort.abort(); bridgeCancel(); } else ctx.pipe?.cancel();
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
    const { summary, file } = await bridgeRevise({ project: store.id, agent, slides: targets.map(i => i + 1), instruction, chapter: ch.title, blob: base }, {
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
