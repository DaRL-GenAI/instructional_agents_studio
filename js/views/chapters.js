// views/chapters.js — shared chapter rail + per-chapter stage tabs, used by Slides, Assessments and Videos.
import { el, button, dot, tabs, empty, icon, toast, notice } from '../ui.js';
import { CHAPTER_STAGES } from '../prompts.js';
import { stageDetail, stageStatus } from './stage.js';
import { go } from '../router.js';

export function chapterRail(ctx, module, stageIds, selectedId, extraTop = []) {
  const { store, pipe } = ctx; const p = store.project;
  return el('div', { class: 'rail' }, el('div', { class: 'panel' }, ...extraTop, el('div', { class: 'rail-head' }, 'Chapters'),
    ...p.chapters.map((ch, i) => el('button', { class: 'rail-item', 'aria-current': String(ch.id === selectedId), onClick: () => go('p', p.id, module, ch.id) }, el('span', { class: 'n' }, i + 1), el('span', { class: 't' }, ch.title), el('span', { class: 'dots' }, ...stageIds.map(s => dot(stageStatus(pipe, ch.stages[s], pipe.chapterInputs(ch.id, s)))))))));
}

export function noChapters(ctx, what) {
  return el('div', { class: 'page' }, empty({ icon: 'list', title: 'No chapters yet', body: `${what} are produced per chapter. Run the Syllabus deliberation and extract chapters under Course design first.`, actions: [button({ label: 'Go to Course design', variant: 'primary', onClick: () => go('p', ctx.store.id, 'design', 'chapters') })] }));
}

/** Stage tabs for one chapter. stageIds in order; ctx.route.b selects the stage. */
export function chapterStages(ctx, module, stageIds, chapterId) {
  const { store, pipe } = ctx; const p = store.project; const ch = store.chapter(chapterId);
  const idx = p.chapters.indexOf(ch);
  const stId = stageIds.includes(ctx.route.b) ? ctx.route.b : firstOpen(ch, stageIds);
  const st = CHAPTER_STAGES.find(s => s.id === stId);
  const box = el('div', {});
  box.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:12px' }, el('div', {}, el('span', { class: 'meta' }, `Chapter ${idx + 1} of ${p.chapters.length}`), el('h2', { style: 'margin-top:2px' }, ch.title), ch.description ? el('p', { class: 'muted', style: 'font-size:var(--fs-2);margin-top:4px;max-width:68ch' }, ch.description) : null),
    el('div', { class: 'btn-row' }, button({ icon: 'arrow-left', size: 'sm', variant: 'ghost', title: 'Previous chapter', disabled: idx === 0, onClick: () => go('p', p.id, module, p.chapters[idx - 1].id, stId) }), button({ icon: 'arrow-right', size: 'sm', variant: 'ghost', title: 'Next chapter', disabled: idx >= p.chapters.length - 1, onClick: () => go('p', p.id, module, p.chapters[idx + 1].id, stId) }))));
  box.append(tabs(stageIds.map(id => [id, CHAPTER_STAGES.find(s => s.id === id).name]), stId, k => go('p', p.id, module, ch.id, k)));
  const body = el('div', { class: 'tab-body' });
  const stage = store.chapterStage(ch.id, stId); const inputs = pipe.chapterInputs(ch.id, stId);
  const agent = pipe.defaultChapterPrompt(ch.id, stId).agents[0];
  const remaining = stageIds.filter(s => ch.stages[s]?.status !== 'done');
  body.append(stageDetail(ctx, { key: `c:${ch.id}:${stId}`, title: st.name, subtitle: `${agent.name} · ${agent.role}`, stage, inputs, kind: st.kind, file: st.file, label: `${ch.title} / ${st.name}`, where: ch.title, chapter: ch,
    defaultPrompt: () => pipe.defaultChapterPrompt(ch.id, stId),
    run: ({ feedback } = {}) => ctx.guarded(`${st.name} · ${ch.title}`, async () => { if (!ctx.requireKey()) return; await pipe.runChapterStage(ch.id, stId, { feedback }); toast(`${st.name} ${feedback ? 'revised' : 'generated'}`, 'ok'); }),
    runAll: remaining.length > 1 ? () => ctx.guarded(`Generating ${ch.title}`, async () => { if (!ctx.requireKey()) return; for (const s of stageIds) { if (ch.stages[s]?.status === 'done') continue; go('p', p.id, module, ch.id, s); await pipe.runChapterStage(ch.id, s); } toast(`${ch.title}: done`, 'ok'); }) : null,
    runAllLabel: `Generate remaining (${remaining.length})`,
    next: () => { const i = stageIds.indexOf(stId); if (i < stageIds.length - 1) go('p', p.id, module, ch.id, stageIds[i + 1]); else if (idx < p.chapters.length - 1) go('p', p.id, module, p.chapters[idx + 1].id, stageIds[0]); } }));
  box.append(body);
  return box;
}
const firstOpen = (ch, ids) => (ids.includes('slides') && ch.stages.slides?.status === 'done' ? 'slides' : null) || ids.find(s => ch.stages[s]?.status !== 'done') || ids[0];

export function runAllChapters(ctx, module, stageIds) {
  const { store, pipe } = ctx; const p = store.project;
  const remaining = p.chapters.reduce((a, ch) => a + stageIds.filter(s => ch.stages[s]?.status !== 'done').length, 0);
  return button({ label: `Generate all remaining (${remaining} calls)`, icon: 'fast-forward', variant: 'primary', disabled: !!ctx.busy || !remaining, onClick: () => ctx.guarded(`Generating ${module}`, async () => {
    if (!ctx.requireKey()) return;
    for (const ch of p.chapters) for (const s of stageIds) { if (ch.stages[s]?.status === 'done') continue; go('p', p.id, module, ch.id, s); await pipe.runChapterStage(ch.id, s); }
    toast('All chapters done', 'ok');
  }) });
}
