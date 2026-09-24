// views/deckeditor.js — the Slides output: PowerPoint-style preview frame, thumbnails, per-layout form.
import { el, button, field, input, textarea, select, notice, empty, toast, icon, confirmDialog } from '../ui.js';
import { deckOf, slideToHtml, resolveTheme, LAYOUTS, PALETTES, deckToPptx, DECK_CSS, DECK_CSS_SCALE } from '../deck.js';
import { download, slug } from '../export.js';

let cssInjected = false;
function ensureCss() { if (cssInjected) return; const st = document.createElement('style'); st.textContent = DECK_CSS + DECK_CSS_SCALE; document.head.append(st); cssInjected = true; }

const LAYOUT_LABEL = { title: 'Title slide', bullets: 'Bullets + callout', two_column: 'Two columns', icon_rows: 'Numbered rows', grid: '2 × 2 grid', stats: 'Stat callouts', process: 'Process flow', code: 'Code', chart: 'Chart', quote: 'Statement', summary: 'Summary (closing)' };

// field schema per layout: kind = text | lines | pairs | code | chart | callout | column
const SCHEMA = {
  title: [['subtitle', 'Subtitle', 'text']],
  bullets: [['bullets', 'Bullets (one per line)', 'lines'], ['callout', 'Callout panel', 'callout']],
  two_column: [['left', 'Left column', 'column'], ['right', 'Right column', 'column']],
  icon_rows: [['items', 'Rows — "Header | text" per line', 'pairs']],
  grid: [['items', 'Blocks — "Header | text" per line (4)', 'pairs']],
  stats: [['stats', 'Stats — "Value | label" per line', 'pairs'], ['note', 'Context line', 'text']],
  process: [['steps', 'Steps — "Header | text" per line', 'pairs']],
  code: [['code', 'Code', 'code'], ['language', 'Language', 'text'], ['bullets', 'Bullets (one per line)', 'lines']],
  chart: [['chart', 'Chart', 'chart'], ['bullets', 'Takeaways (one per line)', 'lines'], ['source', 'Source', 'text']],
  quote: [['quote', 'Statement', 'text'], ['attribution', 'Attribution', 'text']],
  summary: [['bullets', 'Takeaways (one per line)', 'lines'], ['next', 'Next chapter preview', 'text']],
};

export function deckEditor(ctx, o) {
  ensureCss();
  const { store } = ctx; const st = o.stage; const ch = o.chapter; const p = store.project;
  const deck = deckOf(st.output);
  if (!deck.slides.length) return null;
  const theme = resolveTheme(deck.theme, p.deck);
  const meta = { course: p.course.name, chapter: ch.title };
  const ui = ctx.ui[o.key] ||= {}; let current = Math.min(ui.slide || 0, deck.slides.length - 1);

  const frame = el('div', { class: 'deck-frame' });
  const big = el('div', { class: 'deck-big' });
  const strip = el('div', { class: 'deck-strip', role: 'listbox', 'aria-label': 'Slides' });
  const form = el('div', { class: 'slide-form' });
  const counter = el('span', { class: 'meta' });
  const renderBig = () => { big.innerHTML = slideToHtml(deck.slides[current], theme, current, deck.slides.length, meta); counter.textContent = `${current + 1} / ${deck.slides.length} · ${LAYOUT_LABEL[deck.slides[current].layout] || deck.slides[current].layout}`; };
  const renderStrip = () => { strip.innerHTML = ''; deck.slides.forEach((s, i) => strip.append(el('button', { class: 'deck-thumb', role: 'option', 'aria-current': String(i === current), title: s.title, onClick: () => { current = i; ui.slide = i; renderStrip(); renderBig(); buildForm(); } }, el('div', { class: 'deck-thumb-img', html: slideToHtml(s, theme, i, deck.slides.length, meta) }), el('span', {}, `${i + 1}`)))); };
  const go = d => { current = Math.max(0, Math.min(deck.slides.length - 1, current + d)); ui.slide = current; renderStrip(); renderBig(); buildForm(); };
  const renumber = () => deck.slides.forEach((s, i) => { s.slide_id = i + 1; });

  const buildForm = () => {
    const s = deck.slides[current]; form.innerHTML = '';
    const layoutSel = select(LAYOUTS.map(l => [l, LAYOUT_LABEL[l]]), s.layout); layoutSel.onchange = () => { s.layout = layoutSel.value; renderBig(); renderStrip(); buildForm(); };
    const title = input({ value: s.title }); title.oninput = () => { s.title = title.value; renderBig(); renderStrip(); };
    form.append(el('div', { class: 'form-grid' }, field('Layout', layoutSel), field('Title', title)));
    for (const [key, label, kind] of SCHEMA[s.layout] || []) form.append(fieldControl(s, key, label, kind, () => { renderBig(); renderStrip(); }));
    const notes = textarea({ rows: 3 }, s.notes || ''); notes.oninput = () => { s.notes = notes.value; };
    form.append(field('Teaching notes (speaker notes in the .pptx)', notes));
    form.append(el('div', { class: 'btn-row' },
      button({ label: 'Insert slide after', icon: 'plus', size: 'sm', onClick: () => { deck.slides.splice(current + 1, 0, { slide_id: 0, layout: 'bullets', title: 'New slide', bullets: [], callout: { label: 'Key idea', text: '' }, notes: '' }); current++; renumber(); renderStrip(); renderBig(); buildForm(); } }),
      button({ label: 'Move up', icon: 'arrow-up', size: 'sm', variant: 'ghost', disabled: current === 0, onClick: () => { deck.slides.splice(current - 1, 0, deck.slides.splice(current, 1)[0]); current--; renumber(); renderStrip(); renderBig(); buildForm(); } }),
      button({ label: 'Move down', icon: 'arrow-down', size: 'sm', variant: 'ghost', disabled: current === deck.slides.length - 1, onClick: () => { deck.slides.splice(current + 1, 0, deck.slides.splice(current, 1)[0]); current++; renumber(); renderStrip(); renderBig(); buildForm(); } }),
      button({ label: 'Delete slide', icon: 'trash', size: 'sm', variant: 'danger', disabled: deck.slides.length < 2, onClick: () => { deck.slides.splice(current, 1); current = Math.max(0, current - 1); renumber(); renderStrip(); renderBig(); buildForm(); } })));
  };

  const save = () => { if (store.userEdit(st, o.label, JSON.stringify(deck, null, 2), o.where)) { toast('Slides saved and logged', 'ok'); ctx.render(); } else toast('No changes'); };
  const box = el('div', { class: 'deck-editor' });
  box.append(el('div', { class: 'editor-bar' }, el('span', {}, `${deck.slides.length} slides · theme: ${theme.name}${theme.source === 'model' ? ' (chosen by the agents)' : theme.source === 'auto' ? '' : ' (project template)'}`), button({ label: 'Save edits', size: 'sm', variant: 'primary', onClick: save }), button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => ctx.render() })));
  frame.append(el('div', { class: 'deck-toolbar' }, button({ icon: 'arrow-left', size: 'sm', variant: 'ghost', title: 'Previous slide', onClick: () => go(-1) }), counter, button({ icon: 'arrow-right', size: 'sm', variant: 'ghost', title: 'Next slide', onClick: () => go(1) }), el('span', { class: 'spacer' }), button({ label: 'Present', icon: 'presentation', size: 'sm', variant: 'ghost', onClick: () => present(deck, theme, meta, current) })), big, strip);
  box.append(el('div', { class: 'deck-grid' }, frame, form));
  renderStrip(); renderBig(); buildForm();
  return box;
}

function fieldControl(s, key, label, kind, onChange) {
  if (kind === 'text') { const i = input({ value: s[key] || '' }); i.oninput = () => { s[key] = i.value; onChange(); }; return field(label, i); }
  if (kind === 'lines') { const t = textarea({ rows: 5 }, (Array.isArray(s[key]) ? s[key] : []).join('\n')); t.oninput = () => { s[key] = t.value.split('\n').map(x => x.trim()).filter(Boolean); onChange(); }; return field(label, t); }
  if (kind === 'code') { const t = textarea({ rows: 8, class: 'textarea mono' }, s[key] || ''); t.oninput = () => { s[key] = t.value; onChange(); }; return field(label, t); }
  if (kind === 'pairs') { const arr = Array.isArray(s[key]) ? s[key] : []; const t = textarea({ rows: 5 }, arr.map(x => typeof x === 'string' ? x : `${x.header ?? x.value ?? ''} | ${x.text ?? x.label ?? ''}`).join('\n')); t.oninput = () => { s[key] = t.value.split('\n').filter(l => l.trim()).map(l => { const [a, ...rest] = l.split('|'); const b = rest.join('|').trim(); return key === 'stats' ? { value: a.trim(), label: b } : { header: a.trim(), text: b }; }); onChange(); }; return field(label, t, { hint: 'One item per line, header and text separated by |' }); }
  if (kind === 'callout') { const c = s.callout ||= { label: 'Key idea', text: '' }; const l = input({ value: c.label || '' }); const t = textarea({ rows: 3 }, c.text || ''); l.oninput = () => { c.label = l.value; onChange(); }; t.oninput = () => { c.text = t.value; onChange(); }; return el('div', { class: 'form-grid' }, field(`${label} label`, l), el('div', { class: 'span-2' }, field(`${label} text (empty = no panel)`, t))); }
  if (kind === 'column') { const c = s[key] ||= { heading: '', bullets: [] }; const h = input({ value: c.heading || '' }); const t = textarea({ rows: 4 }, (c.bullets || []).join('\n')); h.oninput = () => { c.heading = h.value; onChange(); }; t.oninput = () => { c.bullets = t.value.split('\n').map(x => x.trim()).filter(Boolean); onChange(); }; return el('div', { class: 'form-grid' }, field(`${label} heading`, h), el('div', { class: 'span-2' }, field(`${label} bullets`, t))); }
  if (kind === 'chart') {
    const c = s.chart ||= { type: 'bar', title: '', labels: [], series: [{ name: 'Series', values: [] }] };
    const type = select([['bar', 'Bar'], ['line', 'Line'], ['pie', 'Pie'], ['doughnut', 'Doughnut']], c.type); type.onchange = () => { c.type = type.value; onChange(); };
    const title = input({ value: c.title || '' }); title.oninput = () => { c.title = title.value; onChange(); };
    const unit = input({ value: c.unit || '' }); unit.oninput = () => { c.unit = unit.value; onChange(); };
    const data = textarea({ rows: 5, class: 'textarea mono' }, [`labels: ${(c.labels || []).join(', ')}`, ...(c.series || []).map(sr => `${sr.name}: ${(sr.values || []).join(', ')}`)].join('\n'));
    data.oninput = () => { const lines = data.value.split('\n').map(l => l.trim()).filter(Boolean); const parsed = { labels: [], series: [] }; for (const l of lines) { const [name, rest] = [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]; if (!rest) continue; const vals = rest.split(',').map(v => v.trim()).filter(Boolean); if (name.trim().toLowerCase() === 'labels') parsed.labels = vals; else parsed.series.push({ name: name.trim(), values: vals.map(Number).map(v => isFinite(v) ? v : 0) }); } c.labels = parsed.labels; c.series = parsed.series; onChange(); };
    return el('div', { class: 'form-grid' }, field('Chart type', type), field('Chart title', title), field('Unit', unit), el('div', { class: 'span-2' }, field('Data — "labels: a, b, c" then one "Series name: 1, 2, 3" line per series', data)));
  }
  return el('div');
}

function present(deck, theme, meta, start = 0) {
  const w = window.open('', '_blank'); if (!w) return toast('Allow pop-ups to open the presentation view', 'error');
  const slides = deck.slides.map((s, i) => slideToHtml(s, theme, i, deck.slides.length, meta)).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${meta.chapter || 'Slides'}</title><style>${DECK_CSS}${DECK_CSS_SCALE}html,body{margin:0;height:100%;background:#111;display:flex;align-items:center;justify-content:center;font-family:Calibri,Arial,sans-serif}#stage{width:min(100vw,177.78vh)}#stage .deck-slide{display:none}#stage .deck-slide.on{display:block}.hud{position:fixed;bottom:10px;right:14px;color:#aaa;font:13px Arial}@media print{html,body{background:#fff;display:block}#stage{width:100%}#stage .deck-slide{display:block;page-break-after:always;break-after:page}.hud{display:none}@page{size:landscape;margin:0}}</style></head><body><div id="stage">${slides}</div><div class="hud">← → to navigate · P to print/save PDF · Esc to close</div><script>const s=[...document.querySelectorAll('.deck-slide')];let i=${start};const show=()=>s.forEach((x,k)=>x.classList.toggle('on',k===i));show();addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')i=Math.min(s.length-1,i+1);if(e.key==='ArrowLeft')i=Math.max(0,i-1);if(e.key==='Escape')close();if(e.key==='p'||e.key==='P')print();show()});document.body.onclick=()=>{i=Math.min(s.length-1,i+1);show()}<\/script></body></html>`);
  w.document.close();
}

export async function downloadPptx(ctx, o) {
  const st = o.stage; const ch = o.chapter; const p = ctx.store.project;
  const deck = deckOf(st.output); if (!deck.slides.length) return toast('No slides to export', 'error');
  const theme = resolveTheme(deck.theme, p.deck);
  const script = (() => { try { const v = JSON.parse(ch.stages.script?.output || 'null'); return Array.isArray(v) ? v : []; } catch { return []; } })();
  try { const blob = await deckToPptx(deck, theme, { course: p.course.name, chapter: ch.title }, script); download(blob, `${slug(ch.title)}_slides.pptx`); ctx.store.log({ type: 'export', stage: o.label, file: `${slug(ch.title)}_slides.pptx`, bytes: blob.size }); }
  catch (e) { toast(e.message, 'error'); }
}
