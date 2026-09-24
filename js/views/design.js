// views/design.js — the six ADDIE deliberations and the chapter list.
import { el, button, badge, dot, input, textarea, notice, empty, icon, toast, confirmDialog } from '../ui.js';
import { FOUNDATION, CHAPTER_STAGES } from '../prompts.js';
import { stageDetail, stageStatus, transcriptView } from './stage.js';
import { href, go } from '../router.js';

export function render(ctx) {
  const { store, pipe } = ctx; const p = store.project; const sel = ctx.route.a || FOUNDATION[0].id;
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Course design'), el('p', {}, 'Six deliberations from the ADDIE model, run in order. Each one reads the deliverables before it, then the syllabus is split into chapters.')),
    el('div', { class: 'btn-row' }, button({ label: `Run all six (${(store.settings.deliberation === 'full' ? 3 : 1) * 6} calls)`, icon: 'fast-forward', variant: 'primary', disabled: !!ctx.busy, onClick: () => runAll(ctx) }))));

  const rail = el('div', { class: 'rail' }, el('div', { class: 'panel' }, el('div', { class: 'rail-head' }, 'Deliberations'), ...FOUNDATION.map((f, i) => { const st = stageStatus(pipe, p.foundation[f.id], pipe.foundationInputs(f.id)); return el('button', { class: 'rail-item', 'aria-current': String(sel === f.id), onClick: () => go('p', p.id, 'design', f.id) }, el('span', { class: 'n' }, i + 1), el('span', { class: 't' }, f.name), dot(st)); }),
    el('div', { class: 'rail-head', style: 'margin-top:8px' }, 'Chapters'), el('button', { class: 'rail-item', 'aria-current': String(sel === 'chapters'), onClick: () => go('p', p.id, 'design', 'chapters') }, icon('list', 'sm'), el('span', { class: 't' }, `Chapter list (${p.chapters.length})`), dot(stageStatus(pipe, p.chaptersStage)))));

  const main = el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' });
  if (sel === 'chapters') main.append(chaptersView(ctx));
  else {
    const f = FOUNDATION.find(x => x.id === sel) || FOUNDATION[0];
    const stage = store.foundationStage(f.id); const inputs = pipe.foundationInputs(f.id);
    const prompt = pipe.defaultFoundationPrompt(f.id);
    main.append(stageDetail(ctx, { key: `f:${f.id}`, title: f.name, subtitle: `${f.phase} phase · ${prompt.agents.map(a => a.name).join(' → ')} → Summarizer`, stage, inputs, kind: 'md', file: f.file, label: f.name, where: 'course', defaultPrompt: () => pipe.defaultFoundationPrompt(f.id),
      run: () => ctx.guarded(`Running ${f.name}`, async () => { if (!ctx.requireKey()) return; await pipe.runFoundation(f.id); toast(`${f.name} generated`, 'ok'); }),
      next: () => { const i = FOUNDATION.indexOf(f); go('p', p.id, 'design', i < FOUNDATION.length - 1 ? FOUNDATION[i + 1].id : 'chapters'); } }));
  }
  page.append(el('div', { class: 'two-pane' }, rail, main));
  return page;
}

async function runAll(ctx) {
  if (!ctx.requireKey()) return;
  await ctx.guarded('Running course design', async () => {
    for (const f of FOUNDATION) { const st = ctx.store.project.foundation[f.id]; if (st?.status === 'done' && !ctx.pipe.isStale(st, ctx.pipe.foundationInputs(f.id))) continue; go('p', ctx.store.id, 'design', f.id); await ctx.pipe.runFoundation(f.id); }
    toast('Course design complete. Next: extract chapters.', 'ok'); go('p', ctx.store.id, 'design', 'chapters');
  });
}

function chaptersView(ctx) {
  const { store, pipe } = ctx; const p = store.project; const stage = p.chaptersStage; const hasSyllabus = !!p.foundation.syllabus?.output;
  const box = el('div', {});
  box.append(el('div', { class: 'stage-head' }, el('div', {}, el('h2', {}, 'Chapters'), el('p', { class: 'muted', style: 'font-size:var(--fs-2);margin-top:4px' }, 'The Syllabus Processor agent splits the syllabus into chapters. Edit freely; each chapter then gets slides, assessments and a video.')), el('div', { class: 'meta-col' }, badge(stageStatus(pipe, stage)))));
  if (stage.error) box.append(el('div', { style: 'margin-top:12px' }, notice('error', stage.error)));
  box.append(el('div', { class: 'stage-actions' },
    button({ label: stage.status === 'done' ? 'Re-extract from syllabus' : 'Extract chapters from syllabus', icon: 'play', variant: 'primary', disabled: !!ctx.busy || !hasSyllabus, onClick: () => ctx.guarded('Extracting chapters', async () => { if (!ctx.requireKey()) return; await pipe.runChaptersExtraction(); toast(`${store.project.chapters.length} chapters extracted`, 'ok'); }) }),
    button({ label: 'Add chapter', icon: 'plus', onClick: () => { store.addChapter({ title: 'New chapter', description: '' }); store.log({ type: 'edit', stage: 'Chapter list', where: 'course', note: 'chapter added' }); store.save(); ctx.render(); } }),
    !hasSyllabus ? el('span', { class: 'meta' }, 'Generate the syllabus first.') : null));
  if (stage.transcript?.length) box.append(el('details', { class: 'turn' }, el('summary', {}, icon('chevron-right', 'sm chev'), 'Extraction prompt and response'), el('div', { class: 'turn-body' }, transcriptView(stage))));
  if (!p.chapters.length) { box.append(el('div', { style: 'margin-top:16px' }, empty({ icon: 'list', title: 'No chapters yet', body: hasSyllabus ? 'Extract them from the syllabus, or add chapters by hand.' : 'Run the Syllabus deliberation, then extract chapters here.' }))); return box; }
  const list = el('div', { class: 'list', style: 'margin-top:16px;border:1px solid var(--line-soft);border-radius:var(--r-2);overflow:hidden' });
  p.chapters.forEach((ch, i) => {
    const title = input({ value: ch.title, 'aria-label': `Chapter ${i + 1} title` }); const desc = textarea({ rows: 2, 'aria-label': `Chapter ${i + 1} description` }, ch.description);
    const commit = () => { if (title.value !== ch.title || desc.value !== ch.description) { ch.title = title.value; ch.description = desc.value; store.log({ type: 'edit', stage: 'Chapter list', where: ch.title, note: `chapter ${i + 1} edited` }); store.save(); } };
    title.onchange = commit; desc.onchange = commit;
    const done = CHAPTER_STAGES.filter(s => ch.stages[s.id]?.status === 'done').length;
    list.append(el('div', { class: 'list-row', style: 'grid-template-columns: 28px 1fr auto;align-items:start' }, el('span', { class: 'mono', style: 'color:var(--text-3);padding-top:8px' }, i + 1), el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, title, desc),
      el('div', { class: 'aside', style: 'flex-direction:column;align-items:flex-end;gap:6px' }, el('span', { class: 'meta' }, `${done}/${CHAPTER_STAGES.length} stages`), el('div', { class: 'btn-row' },
        button({ label: 'Slides', size: 'sm', variant: 'ghost', onClick: () => go('p', p.id, 'slides', ch.id) }),
        button({ icon: 'arrow-up', size: 'sm', variant: 'ghost', title: 'Move up', disabled: i === 0, onClick: () => { p.chapters.splice(i - 1, 0, p.chapters.splice(i, 1)[0]); store.save(); ctx.render(); } }),
        button({ icon: 'arrow-down', size: 'sm', variant: 'ghost', title: 'Move down', disabled: i === p.chapters.length - 1, onClick: () => { p.chapters.splice(i + 1, 0, p.chapters.splice(i, 1)[0]); store.save(); ctx.render(); } }),
        button({ icon: 'trash', size: 'sm', variant: 'ghost', title: 'Remove chapter', onClick: async () => { if (await confirmDialog({ title: `Remove “${ch.title}”?`, body: 'Its generated slides, assessments and video are removed too.', confirmLabel: 'Remove', danger: true })) { p.chapters.splice(i, 1); for (const k of ['audios', 'video']) await store.delMedia(ch.id, k); store.log({ type: 'edit', stage: 'Chapter list', note: `chapter removed: ${ch.title}` }); store.save(); ctx.render(); } } })))));
  });
  box.append(list);
  return box;
}
