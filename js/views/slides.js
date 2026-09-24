// views/slides.js — per-chapter outline, slides and lecture script, plus the deck template chooser.
import { el, button, field, input, notice, toast, icon, confirmDialog } from '../ui.js';
import { chapterRail, chapterStages, noChapters, runAllChapters } from './chapters.js';
import { PALETTES, PALETTE_NAMES, resolveTheme, slideToHtml, DECK_CSS, DECK_CSS_SCALE } from '../deck.js';
import { parseTemplate } from '../template.js';
const IDS = ['outline', 'slides', 'script'];

let cssInjected = false;
function ensureCss() { if (cssInjected) return; const st = document.createElement('style'); st.textContent = DECK_CSS + DECK_CSS_SCALE; document.head.append(st); cssInjected = true; }

export function render(ctx) {
  ensureCss();
  const p = ctx.store.project; const ui = ctx.ui.slidesPage ||= {};
  const page = el('div', { class: 'page wide' });
  const deck = p.deck || (p.deck = { template: 'auto' });
  const theme = resolveTheme(null, deck);
  const tplLabel = deck.template === 'auto' ? 'Auto: the agents choose a palette per chapter' : deck.template.startsWith('builtin:') ? `Template: ${theme.name}` : `Your template: ${theme.name}`;
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Slides'), el('p', {}, 'Outline → slides → lecture script for each chapter. Slides are designed as PowerPoint decks: preview them here, edit any slide, download the .pptx.')),
    el('div', { class: 'btn-row' }, button({ label: tplLabel, icon: 'sliders', variant: ui.templateOpen ? 'ghost' : '', onClick: () => { ui.templateOpen = !ui.templateOpen; ctx.render(); } }), p.chapters.length ? runAllChapters(ctx, 'slides', IDS) : null)));
  if (ui.templateOpen) page.append(templatePanel(ctx, ui));
  if (!p.chapters.length) { page.append(noChapters(ctx, 'Slides').firstChild); return page; }
  const chId = ctx.store.chapter(ctx.route.a) ? ctx.route.a : p.chapters[0].id;
  page.append(el('div', { class: 'two-pane' }, chapterRail(ctx, 'slides', IDS, chId), el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' }, chapterStages(ctx, 'slides', IDS, chId))));
  return page;
}

const SAMPLE = [
  { slide_id: 1, layout: 'title', title: 'Chapter title', subtitle: 'What this session covers' },
  { slide_id: 2, layout: 'icon_rows', title: 'Three ideas', items: [{ header: 'First', text: 'A short explanation' }, { header: 'Second', text: 'A short explanation' }, { header: 'Third', text: 'A short explanation' }] },
];
function mini(themeObj, meta) { return el('div', { class: 'tpl-mini' }, ...SAMPLE.map((s, i) => el('div', { class: 'tpl-mini-slide' }, el('div', { class: 'thumb-scale', html: slideToHtml(s, themeObj, i, 2, meta) })))); }

function templatePanel(ctx, ui) {
  const { store } = ctx; const p = store.project; const deck = p.deck; const meta = { course: p.course.name || 'Course', chapter: 'Chapter' };
  const set = (patch, note) => { Object.assign(deck, patch); store.log({ type: 'settings', deck: { template: deck.template, name: deck.name } , note }); store.save(); toast(note, 'ok'); ctx.render(); };
  const box = el('section', { class: 'panel', style: 'padding:22px 24px;margin-bottom:22px' });
  box.append(el('h2', {}, 'Deck template'), el('p', { class: 'section-desc' }, 'Applies to every chapter of this project. Changing it re-themes existing decks immediately (no regeneration needed); the agents are told which palette is in use.'));
  const grid = el('div', { class: 'tpl-grid' });
  const card = (key, name, themeObj, sub, extra) => el('button', { class: 'tpl-card', 'aria-pressed': String(deck.template === key), onClick: () => set({ template: key }, `Template: ${name}`) }, mini(themeObj, meta), el('b', {}, name), sub ? el('small', {}, sub) : null, extra);
  grid.append(card('auto', 'Auto', resolveTheme({ palette: 'Midnight Executive' }, null), 'The agents pick a palette that fits each chapter’s subject'));
  for (const n of PALETTE_NAMES) grid.append(card(`builtin:${n}`, n, resolveTheme({ palette: n }, null), `${PALETTES[n].primary} · ${PALETTES[n].accent}`));
  if (deck.palette) grid.append(card('custom', deck.name || 'Your template', resolveTheme(null, { ...deck, template: 'custom' }), `${deck.tpl?.layouts?.length ? `${deck.tpl.layouts.length} layouts · ` : ''}${deck.palette.primary} · ${deck.palette.accent}${deck.fonts?.body ? ` · ${deck.fonts.body}` : ''}${deck.background ? ' · background image' : ''}`));
  box.append(grid);
  // upload
  const file = el('input', { type: 'file', accept: '.pptx,.potx', class: 'input', style: 'max-width:360px' });
  const status = el('span', { class: 'meta' });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return; status.textContent = 'Reading template…';
    try {
      const t = await parseTemplate(f); const { blob, background, ...rest } = t;
      await store.putMedia('project', 'template', { blob: f, name: f.name, size: f.size, at: new Date().toISOString() });
      const tpl = { size: rest.size, layouts: rest.layouts || [], master: rest.master || null, fonts: rest.fonts || {}, scheme: rest.scheme || null, name: t.name, background: null };
      set({ template: 'custom', name: t.name, palette: t.palette, fonts: t.fonts, background, scheme: t.scheme, tpl }, `Template “${t.name}” applied${tpl.layouts.length ? ` · ${tpl.layouts.length} layouts` : ''}`);
    } catch (e) { status.textContent = ''; toast(`Could not read the template: ${e.message}`, 'error'); }
  };
  box.append(el('div', { class: 'section', style: 'margin-top:20px' }, el('h3', {}, 'Use your own PowerPoint template'), el('p', { class: 'section-desc', style: 'font-size:var(--fs-2)' }, 'Upload a .pptx or .potx. Studio reads it in your browser (nothing is uploaded anywhere): its slide layouts, placeholders, master background, theme fonts and colours. Generated slides are then built on YOUR layouts (Title Slide, Title and Content, Two Content, …) — the downloaded .pptx is your template file with the new slides inside, so it opens and edits exactly like the original. Slides that use Studio-only visuals (stat callouts, process flows, grids, charts) keep your background and title placeholder and draw their content in the layout’s content area.'),
    el('div', { class: 'btn-row' }, file, status, deck.palette ? button({ label: 'Remove uploaded template', size: 'sm', variant: 'danger', onClick: async () => { if (await confirmDialog({ title: 'Remove the uploaded template?', confirmLabel: 'Remove', danger: true })) { delete deck.palette; delete deck.fonts; delete deck.background; delete deck.scheme; delete deck.name; delete deck.tpl; await store.delMedia('project', 'template').catch(() => {}); set({ template: 'auto' }, 'Template removed'); } } }) : null)));
  return box;
}
