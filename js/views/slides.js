// views/slides.js — per-chapter outline, slides and lecture script.
import { el, segmented, toast } from '../ui.js';
import { chapterRail, chapterStages, noChapters, runAllChapters } from './chapters.js';
const IDS = ['outline', 'slides', 'script'];
const FMT = { html: 'HTML deck', latex: 'LaTeX Beamer', pptx: 'PowerPoint' };
const FMT_HELP = {
  html: 'HTML deck rendered in the browser; “Save as PDF” opens it in print view (landscape, one slide per page). Nothing leaves your browser.',
  latex: 'The agents also write a Beamer frame body per slide (one extra call per chapter). Download the .tex and compile it with pdflatex or Overleaf; each frame is editable in the Slides stage.',
  pptx: 'Editable PowerPoint built in the browser with PptxGenJS (title master, bullets, code block, speaker notes from the script).',
};
export function render(ctx) {
  const p = ctx.store.project;
  if (!p.chapters.length) return noChapters(ctx, 'Slides');
  const chId = ctx.store.chapter(ctx.route.a) ? ctx.route.a : p.chapters[0].id;
  const page = el('div', { class: 'page wide' });
  const fmt = ctx.store.settings.slideFormat || 'pptx';
  const setFmt = v => { ctx.store.project.overrides = { ...(ctx.store.project.overrides || {}), slideFormat: v }; ctx.store.log({ type: 'settings', overrides: { slideFormat: v } }); ctx.store.save(); toast(`Deck format: ${FMT[v]}`); ctx.render(); };
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Slides'), el('p', {}, 'Outline → slides → lecture script for each chapter. The deck format decides how slides are written and exported; content stays editable in one place.')),
    el('div', { class: 'btn-row' }, el('div', { class: 'field' }, el('span', { class: 'label' }, 'Deck format'), segmented([['pptx', 'PowerPoint'], ['html', 'HTML → PDF'], ['latex', 'LaTeX → PDF']], fmt, setFmt)), runAllChapters(ctx, 'slides', IDS))));
  page.append(el('p', { class: 'meta', style: 'margin:-12px 0 16px' }, FMT_HELP[fmt]));
  page.append(el('div', { class: 'two-pane' }, chapterRail(ctx, 'slides', IDS, chId), el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' }, chapterStages(ctx, 'slides', IDS, chId))));
  return page;
}
