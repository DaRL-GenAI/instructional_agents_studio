// views/slides.js — per-chapter outline, slides and lecture script.
import { el } from '../ui.js';
import { chapterRail, chapterStages, noChapters, runAllChapters } from './chapters.js';
const IDS = ['outline', 'slides', 'script'];
export function render(ctx) {
  const p = ctx.store.project;
  if (!p.chapters.length) return noChapters(ctx, 'Slides');
  const chId = ctx.store.chapter(ctx.route.a) ? ctx.route.a : p.chapters[0].id;
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Slides'), el('p', {}, 'Outline → slides → lecture script for each chapter. Export a chapter as an HTML deck, Beamer source or PowerPoint from the Slides stage.')), el('div', { class: 'btn-row' }, runAllChapters(ctx, 'slides', IDS))));
  page.append(el('div', { class: 'two-pane' }, chapterRail(ctx, 'slides', IDS, chId), el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' }, chapterStages(ctx, 'slides', IDS, chId))));
  return page;
}
