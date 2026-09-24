// deck.js — slide layout engine. A deck is JSON ({theme, slides[]}); each slide names a layout and its
// fields. layoutSlide() turns one slide into absolutely positioned elements on a 10in × 5.625in canvas,
// and three backends draw the same elements: HTML (preview), pptxgenjs (.pptx) and Canvas 2D (video).
// Design rules follow the PowerPoint guidance: content-informed palette with one dominant colour,
// dark title/closing slides, every slide carries a visual element, varied layouts, no accent stripes.

import { templateFrame } from './decktemplate.js';
import { buildTemplatePptx } from './pptxtemplate.js';

export const W = 10, H = 5.625;           // inches (pptxgenjs LAYOUT_16x9)
const M = 0.5;                            // outer margin

export const PALETTES = {
  'Midnight Executive': { primary: '1E2761', secondary: 'CADCFC', accent: 'F2B134' },
  'Forest & Moss':      { primary: '2C5F2D', secondary: 'DDE8CF', accent: 'E4B04A' },
  'Coral Energy':       { primary: '2F3C7E', secondary: 'FCE3E4', accent: 'F96167' },
  'Warm Terracotta':    { primary: '8A3B2E', secondary: 'EFE9DC', accent: 'A7BEAE' },
  'Ocean Gradient':     { primary: '065A82', secondary: 'D7E9F0', accent: '21C1B0' },
  'Charcoal Minimal':   { primary: '2B3440', secondary: 'ECEEF1', accent: 'E8A33D' },
  'Teal Trust':         { primary: '02657A', secondary: 'D6F1EE', accent: 'F4A261' },
  'Berry & Cream':      { primary: '6D2E46', secondary: 'F1E8DC', accent: 'C9A227' },
  'Sage Calm':          { primary: '3F6B60', secondary: 'E3ECE6', accent: 'D98C4A' },
  'Cherry Bold':        { primary: '990011', secondary: 'FBEDEC', accent: '2F3C7E' },
};
export const PALETTE_NAMES = Object.keys(PALETTES);
export const LAYOUTS = ['title', 'bullets', 'two_column', 'icon_rows', 'grid', 'stats', 'process', 'code', 'chart', 'quote', 'summary'];

export const FONTS = { head: 'Cambria', body: 'Calibri', mono: 'Consolas' };
const CSS_FONTS = { head: "Cambria, 'Times New Roman', Georgia, serif", body: "Calibri, Carlito, 'Segoe UI', Arial, sans-serif", mono: "Consolas, Menlo, 'DejaVu Sans Mono', monospace" };

// ---------------------------------------------------------------- theme
function lum(hex) { const c = hex.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
const onColor = hex => (lum(hex) > 0.4 ? '1F2933' : 'FFFFFF');
const clean = h => String(h || '').replace('#', '').toUpperCase().slice(0, 6);
const isHex = h => /^[0-9A-F]{6}$/.test(h);

/** Resolve the effective theme: project template override > deck theme from the model > default. */
export function resolveTheme(deckTheme, projectDeck) {
  let base = null, name = 'Midnight Executive', fonts = { ...FONTS }, background = null, source = 'auto';
  if (projectDeck && projectDeck.template && projectDeck.template !== 'auto') {
    if (projectDeck.template.startsWith('builtin:')) { name = projectDeck.template.slice(8); base = PALETTES[name] || null; source = 'builtin'; }
    else if (projectDeck.template === 'custom' && projectDeck.palette) { base = projectDeck.palette; name = projectDeck.name || 'Your template'; fonts = { ...FONTS, ...(projectDeck.fonts || {}) }; background = projectDeck.background || null; source = 'custom'; }
  }
  if (!base && deckTheme) {
    if (typeof deckTheme.palette === 'string' && PALETTES[deckTheme.palette]) { name = deckTheme.palette; base = PALETTES[name]; source = 'model'; }
    else if (deckTheme.palette && typeof deckTheme.palette === 'object') { const p = { primary: clean(deckTheme.palette.primary), secondary: clean(deckTheme.palette.secondary), accent: clean(deckTheme.palette.accent) }; if (isHex(p.primary) && isHex(p.secondary) && isHex(p.accent)) { base = p; name = deckTheme.palette.name || 'Custom'; source = 'model'; } }
  }
  if (!base) base = PALETTES[name];
  const primary = clean(base.primary), secondary = clean(base.secondary), accent = clean(base.accent);
  const tpl = projectDeck?.template === 'custom' && projectDeck.tpl && Array.isArray(projectDeck.tpl.layouts) && projectDeck.tpl.layouts.length ? { ...projectDeck.tpl, background: projectDeck.tpl.background || projectDeck.background || null, fonts: { ...FONTS, ...(projectDeck.fonts || {}) } } : null;
  return {
    name, source, fonts, background, tpl, size: tpl?.size?.w && tpl?.size?.h ? { w: tpl.size.w, h: tpl.size.h } : { w: W, h: H },
    primary, secondary, accent,
    bg: 'FFFFFF', text: '1F2933', muted: '5B6470', panel: secondary, onPrimary: onColor(primary), onAccent: onColor(accent), onSecondary: onColor(secondary),
    motif: deckTheme?.motif || 'numbered circles',
  };
}

// ---------------------------------------------------------------- helpers
const t = (x, y, w, h, text, o = {}) => ({ kind: 'text', x, y, w, h, text, size: 16, font: 'body', align: 'left', valign: 'top', ...o });
const rect = (x, y, w, h, fill, o = {}) => ({ kind: 'rect', x, y, w, h, fill, ...o });
const ell = (x, y, w, h, fill, o = {}) => ({ kind: 'ellipse', x, y, w, h, fill, ...o });
const S = v => (Array.isArray(v) ? v : []).map(x => (typeof x === 'string' ? x : x?.text || x?.point || String(x ?? ''))).filter(Boolean);
const str = v => (v == null ? '' : String(v));
const items = (v, keys = ['header', 'text']) => (Array.isArray(v) ? v : []).map(x => typeof x === 'string' ? { header: x, text: '' } : { header: str(x?.header ?? x?.title ?? x?.label ?? x?.name), text: str(x?.text ?? x?.description ?? x?.body ?? x?.detail) });

function titleBlock(th, title, y = M, h = 0.9) {
  return t(M, y, W - 2 * M, h, title, { size: 30, bold: true, font: 'head', color: th.primary, valign: 'middle', isTitle: true });
}
function footer(th, meta, index, total) {
  return [t(M, H - 0.42, 6, 0.3, meta.course || '', { size: 10, color: th.muted, valign: 'middle', isFooter: true }), t(W - M - 1.5, H - 0.42, 1.5, 0.3, `${index + 1} / ${total}`, { size: 10, color: th.muted, align: 'right', valign: 'middle', isFooter: true })];
}
function numberCircle(th, x, y, d, n, dark = false) {
  return [ell(x, y, d, d, dark ? th.accent : th.primary), t(x, y, d, d, String(n), { size: d * 26, bold: true, color: dark ? th.onAccent : th.onPrimary, align: 'center', valign: 'middle', margin: 0 })];
}
function bulletText(th, x, y, w, h, arr, size = 16, color) {
  return { kind: 'text', x, y, w, h, bullets: S(arr), size, font: 'body', color: color || th.text, valign: 'top', paraSpace: size * 0.5 };
}

// ---------------------------------------------------------------- layouts
export function layoutSlide(slide, th, index, total, meta = {}) {
  if (th?.tpl) return templateSlide(slide, th, index, total, meta).els;
  return builtinLayout(slide, th, index, total, meta);
}

/**
 * Template mode: the instructor's own .pptx layouts. Placeholder-backed slides come straight from
 * decktemplate.js; for our richer layouts (stats, process, grid, rows, chart, code) the template supplies
 * background + title placeholder and our body elements are fitted into the layout's content area.
 * Returns { layout, els }.
 */
export function templateSlide(slide, th, index, total, meta = {}) {
  let frame;
  try { frame = templateFrame(slide, th, index, total, meta, th.tpl); } catch (e) { console.warn('templateFrame failed; using the built-in layout', e); return { layout: null, els: builtinLayout(slide, th, index, total, meta) }; }
  if (!frame || !Array.isArray(frame.els)) return { layout: null, els: builtinLayout(slide, th, index, total, meta) };
  if (frame.native || !frame.contentBox) return { layout: frame.layout || null, els: frame.els };
  const body = builtinLayout(slide, th, index, total, meta).filter(e => !e.isBackground && !e.isTitle && !e.isFooter);
  const box = frame.contentBox; const srcX = M, srcY = 1.55, srcW = W - 2 * M, srcH = H - 1.55 - 0.6;
  const sc = Math.min(box.w / srcW, box.h / srcH) || 1; const ox = box.x + (box.w - srcW * sc) / 2, oy = box.y;
  const fitted = body.map(e => ({ ...e, x: ox + (e.x - srcX) * sc, y: oy + (e.y - srcY) * sc, w: e.w * sc, h: e.h * sc, ...(e.size ? { size: e.size * sc } : {}), ...(e.radius ? { radius: e.radius * sc } : {}), ...(e.paraSpace ? { paraSpace: e.paraSpace * sc } : {}) }));
  return { layout: frame.layout || null, els: [...frame.els, ...fitted] };
}

function builtinLayout(slide, th, index, total, meta = {}) {
  const L = LAYOUTS.includes(slide.layout) ? slide.layout : (slide.code ? 'code' : 'bullets');
  const els = [];
  const title = str(slide.title || `Slide ${index + 1}`);
  const dark = L === 'title' || L === 'summary' || L === 'quote';
  els.push(rect(0, 0, W, H, dark ? th.primary : th.bg, { bgImage: !dark && th.background ? th.background : null, isBackground: true }));

  if (L === 'title') {
    els.push(t(M, 1.55, W - 2 * M, 1.5, title, { size: 40, bold: true, font: 'head', color: th.onPrimary, valign: 'bottom' }));
    if (slide.subtitle) els.push(t(M, 3.15, W - 2 * M, 0.9, str(slide.subtitle), { size: 20, color: th.onPrimary, opacity: 0.85 }));
    els.push(t(M, H - 0.9, W - 2 * M, 0.4, [meta.course, meta.presenter].filter(Boolean).join('  ·  '), { size: 12, color: th.onPrimary, opacity: 0.75 }));
    return els;
  }
  if (L === 'summary') {
    els.push(t(M, M, W - 2 * M, 0.9, title, { size: 32, bold: true, font: 'head', color: th.onPrimary, valign: 'middle' }));
    const pts = S(slide.bullets || slide.points).slice(0, 5);
    const rowH = Math.min(0.72, (H - 1.9) / Math.max(pts.length, 1));
    pts.forEach((p, i) => { const y = 1.55 + i * rowH; els.push(...numberCircle(th, M, y + 0.06, 0.42, i + 1, true)); els.push(t(M + 0.62, y, W - 2 * M - 0.62, rowH, p, { size: 18, color: th.onPrimary, valign: 'middle' })); });
    if (slide.next) els.push(t(M, H - 0.8, W - 2 * M, 0.4, `Next: ${str(slide.next)}`, { size: 12, color: th.onPrimary, opacity: 0.75 }));
    return els;
  }
  if (L === 'quote') {
    els.push(t(M + 0.2, 0.9, W - 2 * M - 0.4, 2.6, `“${str(slide.quote || slide.statement || title)}”`, { size: 28, italic: true, font: 'head', color: th.onPrimary, valign: 'middle', align: 'left' }));
    if (slide.attribution) els.push(t(M + 0.2, 3.7, W - 2 * M - 0.4, 0.5, `— ${str(slide.attribution)}`, { size: 14, color: th.onPrimary, opacity: 0.8 }));
    return els;
  }

  els.push(titleBlock(th, title));
  const top = 1.55, bodyH = H - top - 0.6;

  if (L === 'bullets') {
    const pts = S(slide.bullets).slice(0, 6);
    const callout = slide.callout && (slide.callout.text || slide.callout.label) ? slide.callout : null;
    const textW = callout ? 5.6 : W - 2 * M;
    els.push(bulletText(th, M, top, textW, bodyH, pts, pts.length > 4 ? 16 : 18));
    if (callout) {
      const cx = M + textW + 0.4, cw = W - M - cx;
      els.push(rect(cx, top, cw, bodyH - 0.2, th.panel, { radius: 0.12 }));
      els.push(t(cx + 0.25, top + 0.25, cw - 0.5, 0.4, str(callout.label || 'Key idea').toUpperCase(), { size: 11, bold: true, color: th.primary, charSpacing: 1 }));
      els.push(t(cx + 0.25, top + 0.7, cw - 0.5, bodyH - 1.2, str(callout.text), { size: 16, color: th.onSecondary === 'FFFFFF' ? 'FFFFFF' : th.text, valign: 'top' }));
    }
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'two_column') {
    const cols = [slide.left, slide.right].map(c => c || {});
    const colW = (W - 2 * M - 0.4) / 2;
    cols.forEach((c, i) => {
      const x = M + i * (colW + 0.4);
      els.push(rect(x, top, colW, bodyH - 0.2, i === 0 ? th.panel : th.bg, { radius: 0.12, line: i === 1 ? th.panel : null }));
      els.push(t(x + 0.25, top + 0.2, colW - 0.5, 0.5, str(c.heading || c.title || (i === 0 ? 'Left' : 'Right')), { size: 18, bold: true, font: 'head', color: th.primary, valign: 'middle' }));
      els.push(bulletText(th, x + 0.25, top + 0.8, colW - 0.5, bodyH - 1.2, S(c.bullets || c.points).slice(0, 5), 15));
    });
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'icon_rows') {
    const rows = items(slide.items).slice(0, 4);
    const rowH = Math.min(0.95, (bodyH - 0.1) / Math.max(rows.length, 1));
    rows.forEach((r, i) => {
      const y = top + i * rowH;
      els.push(...numberCircle(th, M, y + 0.1, 0.55, i + 1));
      els.push(t(M + 0.8, y + 0.02, W - 2 * M - 0.8, 0.4, r.header, { size: 17, bold: true, color: th.primary, valign: 'middle' }));
      els.push(t(M + 0.8, y + 0.42, W - 2 * M - 0.8, rowH - 0.45, r.text, { size: 14, color: th.text }));
    });
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'grid') {
    const cells = items(slide.items).slice(0, 4);
    const gw = (W - 2 * M - 0.3) / 2, gh = (bodyH - 0.4) / 2;
    cells.forEach((c, i) => {
      const x = M + (i % 2) * (gw + 0.3), y = top + Math.floor(i / 2) * (gh + 0.3);
      els.push(rect(x, y, gw, gh, i === 0 ? th.primary : th.panel, { radius: 0.12 }));
      const fg = i === 0 ? th.onPrimary : th.text;
      els.push(t(x + 0.25, y + 0.2, gw - 0.5, 0.45, c.header, { size: 17, bold: true, font: 'head', color: i === 0 ? th.onPrimary : th.primary, valign: 'middle' }));
      els.push(t(x + 0.25, y + 0.7, gw - 0.5, gh - 0.85, c.text, { size: 13, color: fg }));
    });
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'stats') {
    const stats = (Array.isArray(slide.stats) ? slide.stats : []).slice(0, 4).map(s => ({ value: str(s?.value ?? s?.number ?? ''), label: str(s?.label ?? s?.text ?? '') }));
    const n = Math.max(stats.length, 1), gap = 0.3, cw = (W - 2 * M - gap * (n - 1)) / n;
    stats.forEach((s, i) => {
      const x = M + i * (cw + gap);
      els.push(rect(x, top, cw, 2.2, th.panel, { radius: 0.12 }));
      els.push(t(x + 0.15, top + 0.25, cw - 0.3, 1.1, s.value, { size: n > 3 ? 40 : 54, bold: true, font: 'head', color: th.primary, align: 'center', valign: 'middle' }));
      els.push(t(x + 0.15, top + 1.4, cw - 0.3, 0.7, s.label, { size: 13, color: th.text, align: 'center' }));
    });
    if (slide.note || slide.caption) els.push(t(M, top + 2.5, W - 2 * M, 0.9, str(slide.note || slide.caption), { size: 14, italic: true, color: th.muted }));
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'process') {
    const steps = items(slide.steps || slide.items).slice(0, 5);
    const n = Math.max(steps.length, 1), gap = 0.35, sw = (W - 2 * M - gap * (n - 1)) / n;
    steps.forEach((s, i) => {
      const x = M + i * (sw + gap);
      els.push(...numberCircle(th, x, top, 0.5, i + 1));
      if (i < n - 1) els.push({ kind: 'line', x: x + 0.55, y: top + 0.25, w: sw + gap - 0.6, h: 0, color: th.accent, width: 2, arrow: true });
      els.push(t(x, top + 0.7, sw, 0.5, s.header, { size: 15, bold: true, color: th.primary, valign: 'middle' }));
      els.push(t(x, top + 1.2, sw, bodyH - 1.4, s.text, { size: 12.5, color: th.text }));
    });
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'code') {
    const code = str(slide.code); const pts = S(slide.bullets).slice(0, 5);
    const cw = pts.length ? 5.4 : W - 2 * M;
    els.push({ kind: 'code', x: M, y: top, w: cw, h: bodyH - 0.2, text: code, language: str(slide.language || slide.code_language), fill: '1E2430', color: 'E6EDF3', size: code.split('\n').length > 12 ? 10 : 12 });
    if (pts.length) els.push(bulletText(th, M + cw + 0.4, top, W - M - (M + cw + 0.4), bodyH, pts, 15));
    return [...els, ...footer(th, meta, index, total)];
  }
  if (L === 'chart') {
    const ch = slide.chart || {}; const labels = S(ch.labels || ch.categories); const series = (Array.isArray(ch.series) ? ch.series : []).map(s => ({ name: str(s?.name || 'Series'), values: (Array.isArray(s?.values) ? s.values : []).map(Number).map(v => (isFinite(v) ? v : 0)) })).filter(s => s.values.length);
    const pts = S(slide.bullets || slide.takeaways).slice(0, 4);
    const cw = pts.length ? 5.9 : W - 2 * M;
    els.push({ kind: 'chart', x: M, y: top, w: cw, h: bodyH - 0.2, chartType: ['bar', 'line', 'pie', 'doughnut'].includes(ch.type) ? ch.type : 'bar', labels, series, unit: str(ch.unit), title: str(ch.title), colors: [th.primary, th.accent, th.secondary, '8892A0'] });
    if (pts.length) els.push(bulletText(th, M + cw + 0.4, top, W - M - (M + cw + 0.4), bodyH - 0.6, pts, 14));
    if (slide.source) els.push(t(M, H - 0.75, W - 2 * M, 0.3, `Source: ${str(slide.source)}`, { size: 9, italic: true, color: th.muted }));
    return [...els, ...footer(th, meta, index, total)];
  }
  return [...els, ...footer(th, meta, index, total)];
}

// ---------------------------------------------------------------- HTML backend (preview)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function slideToHtml(slide, th, index, total, meta) {
  const SW = th?.size?.w || W, SH = th?.size?.h || H;
  const inch = v => `${(v / SW * 100).toFixed(3)}%`;
  const inchH = v => `${(v / SH * 100).toFixed(3)}%`;
  const cq = v => `${(v / SW * 100).toFixed(3)}cqw`;   // inches → container width units
  const els = layoutSlide(slide, th, index, total, meta);
  const parts = els.map(e => {
    const pos = `left:${inch(e.x)};top:${inchH(e.y)};width:${inch(e.w)};height:${inchH(e.h)};`;
    if (e.kind === 'rect') { const bg = e.bgImage ? `background:#${e.fill} url(${e.bgImage}) center/cover no-repeat;` : `background:#${e.fill};`; return `<div class="de" style="${pos}${bg}${e.radius ? `border-radius:${cq(e.radius)};` : ''}${e.line ? `border:1px solid #${e.line};` : ''}"></div>`; }
    if (e.kind === 'ellipse') return `<div class="de" style="${pos}background:#${e.fill};border-radius:50%"></div>`;
    if (e.kind === 'line') return `<div class="de dl" style="${pos}height:0;border-top:${e.width || 1}px solid #${e.color};"><i style="border-color:#${e.color}"></i></div>`;
    if (e.kind === 'code') { return `<pre class="de dc" style="${pos}background:#${e.fill};color:#${e.color};font-size:${cq(e.size / 72)};">${esc(e.text)}</pre>`; }
    if (e.kind === 'chart') return `<div class="de" style="${pos}">${chartSvg(e)}</div>`;
    // text
    const style = `${pos}font-family:${CSS_FONTS[e.font || 'body']};font-size:${cq(e.size / 72)};color:#${e.color || th.text};text-align:${e.align || 'left'};font-weight:${e.bold ? 700 : 400};font-style:${e.italic ? 'italic' : 'normal'};opacity:${e.opacity ?? 1};padding:${e.margin === 0 ? 0 : `${cq(0.05)} ${cq(0.08)}`};display:flex;flex-direction:column;justify-content:${{ top: 'flex-start', middle: 'center', bottom: 'flex-end' }[e.valign || 'top']};${e.charSpacing ? `letter-spacing:${cq(e.charSpacing / 72)};` : ''}`;
    if (e.bullets) {
      const gap = cq((e.paraSpace || 8) / 72); const lv = e.levels || []; const hd = e.headings || []; const pl = e.plains || [];
      if (e.plain) return `<div class="de dt" style="${style}"><div>${e.bullets.map((b, k) => `<div style="margin-bottom:${gap};${hd[k] || e.bold ? 'font-weight:700;' : ''}${lv[k] ? `padding-left:${lv[k] * 1.2}em;` : ''}">${esc(b)}</div>`).join('')}</div></div>`;
      const tag = e.numbered ? 'ol' : 'ul';
      return `<div class="de dt" style="${style}"><${tag} style="margin:0;padding-left:1.1em">${e.bullets.map((b, k) => `<li style="margin-bottom:${gap};${hd[k] ? 'font-weight:700;' : ''}${pl[k] ? 'list-style:none;margin-left:-1.1em;' : ''}${lv[k] ? `margin-left:${lv[k] * 1.2}em;font-size:0.9em;` : ''}">${esc(b)}</li>`).join('')}</${tag}></div>`;
    }
    return `<div class="de dt" style="${style}"><span>${esc(e.text)}</span></div>`;
  });
  return `<div class="deck-slide" style="aspect-ratio:${SW}/${SH}">${parts.join('')}</div>`;
}
export const DECK_CSS = `
.deck-slide{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#fff;container-type:inline-size}
.deck-slide .de{position:absolute;box-sizing:border-box;overflow:hidden}
.deck-slide .dt span,.deck-slide .dt li{line-height:1.25;overflow-wrap:anywhere}
.deck-slide .dl i{position:absolute;right:-1px;top:-0.55cqw;width:0.9cqw;height:0.9cqw;border-right:0.2cqw solid;border-top:0.2cqw solid;transform:rotate(45deg)}
.deck-slide .dc{margin:0;padding:1.4cqw 1.8cqw;border-radius:1.2cqw;font-family:${CSS_FONTS.mono};white-space:pre;line-height:1.4}
`;
// font sizes are expressed in inches; scale them with the container via cqw (1in = 10cqw on a 10in-wide slide)
export const DECK_CSS_SCALE = ``;

function chartSvg(e) {
  const w = 600, h = 340, pad = { l: 46, r: 12, t: e.title ? 30 : 12, b: 40 };
  const { labels, series, colors } = e; if (!series.length || !labels.length) return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%"><text x="20" y="40" font-size="16" fill="#888">chart data missing</text></svg>`;
  let out = `<svg viewBox="0 0 ${w} ${h}" width="100%" height="100%" font-family="${CSS_FONTS.body}">`;
  if (e.title) out += `<text x="${pad.l}" y="20" font-size="15" font-weight="700" fill="#${colors[0]}">${esc(e.title)}</text>`;
  if (e.chartType === 'pie' || e.chartType === 'doughnut') {
    const vals = series[0].values, tot = vals.reduce((a, b) => a + b, 0) || 1; let a0 = -Math.PI / 2; const cx = w * 0.32, cy = h / 2 + 8, r = Math.min(w, h) * 0.36;
    vals.forEach((v, i) => { const a1 = a0 + 2 * Math.PI * v / tot; const large = a1 - a0 > Math.PI ? 1 : 0; const p = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`; out += `<path d="${p}" fill="#${colors[i % colors.length]}"/>`; a0 = a1; });
    if (e.chartType === 'doughnut') out += `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#fff"/>`;
    labels.forEach((l, i) => { out += `<rect x="${w * 0.62}" y="${60 + i * 26}" width="14" height="14" fill="#${colors[i % colors.length]}"/><text x="${w * 0.62 + 22}" y="${72 + i * 26}" font-size="13" fill="#333">${esc(l)} (${Math.round(100 * (vals[i] || 0) / tot)}%)</text>`; });
    return out + '</svg>';
  }
  const maxV = Math.max(...series.flatMap(s => s.values), 0) || 1; const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  for (let g = 0; g <= 4; g++) { const y = pad.t + ph - ph * g / 4; out += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" stroke="#E5E7EB"/><text x="${pad.l - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="#666">${fmtNum(maxV * g / 4)}</text>`; }
  const n = labels.length, gw = pw / n;
  labels.forEach((l, i) => out += `<text x="${pad.l + gw * i + gw / 2}" y="${h - 14}" font-size="12" text-anchor="middle" fill="#444">${esc(String(l).slice(0, 14))}</text>`);
  if (e.chartType === 'line') {
    series.forEach((s, si) => { const pts = s.values.map((v, i) => `${pad.l + gw * i + gw / 2},${pad.t + ph - ph * v / maxV}`).join(' '); out += `<polyline points="${pts}" fill="none" stroke="#${colors[si % colors.length]}" stroke-width="3"/>`; s.values.forEach((v, i) => out += `<circle cx="${pad.l + gw * i + gw / 2}" cy="${pad.t + ph - ph * v / maxV}" r="4" fill="#${colors[si % colors.length]}"/>`); });
  } else {
    const bw = gw / (series.length + 1);
    series.forEach((s, si) => s.values.forEach((v, i) => { const bh = ph * v / maxV, x = pad.l + gw * i + bw * (si + 0.5), y = pad.t + ph - bh; out += `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="#${colors[si % colors.length]}" rx="2"/><text x="${x + bw / 2}" y="${y - 4}" font-size="11" text-anchor="middle" fill="#333">${fmtNum(v)}</text>`; }));
  }
  if (series.length > 1) series.forEach((s, i) => out += `<rect x="${pad.l + i * 120}" y="${pad.t - 8}" width="12" height="12" fill="#${colors[i % colors.length]}"/><text x="${pad.l + i * 120 + 16}" y="${pad.t + 3}" font-size="11" fill="#333">${esc(s.name)}</text>`);
  return out + '</svg>';
}
const fmtNum = v => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));

// ---------------------------------------------------------------- Canvas backend (video)
export function drawSlideCanvas(ctx, slide, th, index, total, meta, pxW, pxH, images = {}) {
  const SW = th?.size?.w || W, SH = th?.size?.h || H; const s = Math.min(pxW / SW, pxH / SH); const px = v => v * s;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, pxW, pxH); ctx.save(); ctx.translate((pxW - SW * s) / 2, (pxH - SH * s) / 2);
  const els = layoutSlide(slide, th, index, total, meta);
  ctx.save(); ctx.textBaseline = 'top';
  for (const e of els) {
    const x = px(e.x), y = px(e.y), w = px(e.w), h = px(e.h);
    if (e.kind === 'rect') {
      ctx.fillStyle = '#' + e.fill; if (e.radius) { rr(ctx, x, y, w, h, px(e.radius)); ctx.fill(); } else ctx.fillRect(x, y, w, h);
      if (e.bgImage && images[e.bgImage]) ctx.drawImage(images[e.bgImage], x, y, w, h);
      if (e.line) { ctx.strokeStyle = '#' + e.line; ctx.lineWidth = 1; rr(ctx, x, y, w, h, px(e.radius || 0)); ctx.stroke(); }
    } else if (e.kind === 'ellipse') { ctx.fillStyle = '#' + e.fill; ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
    else if (e.kind === 'line') { ctx.strokeStyle = '#' + e.color; ctx.lineWidth = e.width || 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.stroke(); if (e.arrow) { ctx.beginPath(); ctx.moveTo(x + w - px(0.12), y - px(0.08)); ctx.lineTo(x + w, y); ctx.lineTo(x + w - px(0.12), y + px(0.08)); ctx.stroke(); } }
    else if (e.kind === 'code') {
      ctx.fillStyle = '#' + e.fill; rr(ctx, x, y, w, h, px(0.12)); ctx.fill();
      ctx.fillStyle = '#' + e.color; const fs = px(e.size / 72); ctx.font = `${fs}px ${CSS_FONTS.mono}`; let cy = y + px(0.14);
      for (const line of e.text.split('\n')) { if (cy > y + h - fs) break; ctx.fillText(truncate(ctx, line.replace(/\t/g, '  '), w - px(0.36)), x + px(0.18), cy); cy += fs * 1.4; }
    } else if (e.kind === 'chart') { drawChartCanvas(ctx, e, x, y, w, h, s); }
    else {
      const fs = px(e.size / 72); const pad = e.margin === 0 ? 0 : px(0.08);
      ctx.globalAlpha = e.opacity ?? 1; ctx.fillStyle = '#' + (e.color || th.text);
      ctx.font = `${e.italic ? 'italic ' : ''}${e.bold ? '700' : '400'} ${fs}px ${CSS_FONTS[e.font || 'body']}`;
      const lines = [];
      if (e.bullets) e.bullets.forEach((b, k) => { const lv = e.levels?.[k] || 0; const plain = e.plain || e.plains?.[k]; const indent = plain ? lv * fs * 1.2 : fs * 1.1 + lv * fs * 1.2; const ls = wrap(ctx, b, w - 2 * pad - indent); ls.forEach((l, i) => lines.push({ text: l, bullet: i === 0 && !plain, num: e.numbered ? k + 1 : null, indent, gapAfter: i === ls.length - 1, bold: !!(e.headings?.[k]) })); });
      else wrap(ctx, e.text, w - 2 * pad).forEach(l => lines.push({ text: l }));
      const lh = fs * 1.25, gap = e.bullets ? px((e.paraSpace || 8) / 72) : 0;
      const totalH = lines.reduce((a, l) => a + lh + (l.gapAfter ? gap : 0), 0);
      let cy = e.valign === 'middle' ? y + (h - totalH) / 2 : e.valign === 'bottom' ? y + h - totalH - pad : y + pad;
      for (const l of lines) {
        if (cy > y + h - lh * 0.6) break;
        let cx = x + pad; if (e.align === 'center') cx = x + w / 2; if (e.align === 'right') cx = x + w - pad;
        ctx.textAlign = e.align || 'left';
        if (e.bullets) { const base = x + pad + (l.indent - (l.bullet || l.num ? fs * 1.1 : 0)); if (l.bullet && l.num) { ctx.textAlign = 'left'; ctx.fillText(`${l.num}.`, base, cy); } else if (l.bullet) { ctx.beginPath(); ctx.arc(base + fs * 0.3, cy + fs * 0.55, fs * 0.15, 0, Math.PI * 2); ctx.fill(); } cx = x + pad + l.indent; ctx.textAlign = e.plain && e.align === 'center' ? 'center' : 'left'; if (ctx.textAlign === 'center') cx = x + w / 2; if (l.bold) ctx.font = ctx.font.replace(/^(italic )?(400|700)/, '$1700'); }
        ctx.fillText(l.text, cx, cy); cy += lh + (l.gapAfter ? gap : 0);
      }
      ctx.globalAlpha = 1; ctx.textAlign = 'left';
    }
  }
  ctx.restore(); ctx.restore();
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function wrap(ctx, text, maxW) { const words = String(text ?? '').split(/\s+/); const lines = []; let cur = ''; for (const w of words) { const t2 = cur ? cur + ' ' + w : w; if (ctx.measureText(t2).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t2; } if (cur) lines.push(cur); return lines.length ? lines : ['']; }
function truncate(ctx, text, maxW) { let t2 = String(text); if (ctx.measureText(t2).width <= maxW) return t2; while (t2.length && ctx.measureText(t2 + '…').width > maxW) t2 = t2.slice(0, -1); return t2 + '…'; }
function drawChartCanvas(ctx, e, x, y, w, h, s) {
  const { labels, series, colors } = e; ctx.font = `${12 * s / 96 * 1.33}px ${CSS_FONTS.body}`;
  if (!series.length || !labels.length) { ctx.fillStyle = '#888'; ctx.fillText('chart data missing', x + 10, y + 10); return; }
  const padL = 46 * s / 60, padB = 36 * s / 60, padT = 20 * s / 60; const pw = w - padL - 10, ph = h - padT - padB;
  if (e.chartType === 'pie' || e.chartType === 'doughnut') { const vals = series[0].values, tot = vals.reduce((a, b) => a + b, 0) || 1; let a0 = -Math.PI / 2; const cx = x + w * 0.32, cy = y + h / 2, r = Math.min(w, h) * 0.36; vals.forEach((v, i) => { const a1 = a0 + 2 * Math.PI * v / tot; ctx.fillStyle = '#' + colors[i % colors.length]; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a0, a1); ctx.closePath(); ctx.fill(); a0 = a1; }); if (e.chartType === 'doughnut') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fill(); } labels.forEach((l, i) => { ctx.fillStyle = '#' + colors[i % colors.length]; ctx.fillRect(x + w * 0.62, y + 40 + i * 26 * s / 60, 12, 12); ctx.fillStyle = '#333'; ctx.fillText(`${l} (${Math.round(100 * (vals[i] || 0) / tot)}%)`, x + w * 0.62 + 18, y + 40 + i * 26 * s / 60); }); return; }
  const maxV = Math.max(...series.flatMap(sr => sr.values), 0) || 1; const n = labels.length, gw = pw / n;
  ctx.strokeStyle = '#E5E7EB'; for (let g = 0; g <= 4; g++) { const gy = y + padT + ph - ph * g / 4; ctx.beginPath(); ctx.moveTo(x + padL, gy); ctx.lineTo(x + w - 10, gy); ctx.stroke(); ctx.fillStyle = '#666'; ctx.textAlign = 'right'; ctx.fillText(fmtNum(maxV * g / 4), x + padL - 6, gy - 6); }
  ctx.textAlign = 'center'; ctx.fillStyle = '#444'; labels.forEach((l, i) => ctx.fillText(String(l).slice(0, 14), x + padL + gw * i + gw / 2, y + h - padB + 8));
  if (e.chartType === 'line') { series.forEach((sr, si) => { ctx.strokeStyle = '#' + colors[si % colors.length]; ctx.lineWidth = 3; ctx.beginPath(); sr.values.forEach((v, i) => { const px2 = x + padL + gw * i + gw / 2, py = y + padT + ph - ph * v / maxV; i ? ctx.lineTo(px2, py) : ctx.moveTo(px2, py); }); ctx.stroke(); }); }
  else { const bw = gw / (series.length + 1); series.forEach((sr, si) => sr.values.forEach((v, i) => { const bh = ph * v / maxV, bx = x + padL + gw * i + bw * (si + 0.5), by = y + padT + ph - bh; ctx.fillStyle = '#' + colors[si % colors.length]; ctx.fillRect(bx, by, bw, bh); ctx.fillStyle = '#333'; ctx.fillText(fmtNum(v), bx + bw / 2, by - 16); })); }
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------- pptxgenjs backend
const PPTX_SOURCES = ['https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js', 'https://unpkg.com/pptxgenjs@3.12.0/dist/pptxgen.bundle.js'];
let pptxLoading;
export function loadPptx() {
  if (window.PptxGenJS) return Promise.resolve();
  pptxLoading ||= (async () => {
    let lastErr;
    for (const src of PPTX_SOURCES) { try { await new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Could not load ${src}`)); document.head.appendChild(s); }); if (window.PptxGenJS) return; } catch (e) { lastErr = e; } }
    pptxLoading = null; throw new Error(`The PowerPoint library could not be loaded (${lastErr?.message || 'network'}). Check your connection or content blockers, then try again.`);
  })();
  return pptxLoading;
}

/** Build a .pptx Blob from a deck ({theme, slides}) with the resolved theme. script = [{slide_id, narration}] for notes. */
export async function deckToPptx(deck, th, meta, script = [], { templateBlob = null } = {}) {
  const slidesN = (deck.slides || []).length;
  if (th?.tpl && templateBlob) {
    return await buildTemplatePptx({ templateBlob, tpl: th.tpl, deck, theme: th, meta, script, elementsFor: (sl, i) => templateSlide(sl, th, i, slidesN, meta), rasterize: chartPng });
  }
  await loadPptx();
  const pptx = new window.PptxGenJS();
  if (th?.size && (Math.abs(th.size.w - W) > 0.01 || Math.abs(th.size.h - H) > 0.01)) { pptx.defineLayout({ name: 'STUDIO_TPL', width: th.size.w, height: th.size.h }); pptx.layout = 'STUDIO_TPL'; } else pptx.layout = 'LAYOUT_16x9'; pptx.author = 'Instructional Agents Studio'; pptx.title = meta.chapter || 'Lecture';
  const notes = new Map((script || []).map(s => [s.slide_id, s.narration]));
  const slides = deck.slides || [];
  slides.forEach((sl, i) => {
    const s = pptx.addSlide();
    const els = layoutSlide(sl, th, i, slides.length, meta);
    for (const e of els) {
      if (e.kind === 'rect' && e.isBackground) { if (e.bgImage) s.background = { data: e.bgImage }; else s.background = { color: e.fill }; continue; }
      if (e.kind === 'rect') { s.addShape(e.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { x: e.x, y: e.y, w: e.w, h: e.h, fill: { color: e.fill }, line: e.line ? { color: e.line, width: 0.75 } : { color: e.fill, width: 0 }, ...(e.radius ? { rectRadius: e.radius } : {}) }); continue; }
      if (e.kind === 'ellipse') { s.addShape(pptx.ShapeType.ellipse, { x: e.x, y: e.y, w: e.w, h: e.h, fill: { color: e.fill }, line: { color: e.fill, width: 0 } }); continue; }
      if (e.kind === 'line') { s.addShape(pptx.ShapeType.line, { x: e.x, y: e.y, w: e.w, h: 0, line: { color: e.color, width: e.width || 1, ...(e.arrow ? { endArrowType: 'triangle' } : {}) } }); continue; }
      if (e.kind === 'code') { s.addText(e.text || ' ', { x: e.x, y: e.y, w: e.w, h: e.h, fontFace: FONTS.mono, fontSize: e.size, color: e.color, fill: { color: e.fill }, valign: 'top', margin: 10, isTextBox: true, rectRadius: 0.1, shape: pptx.ShapeType.roundRect }); continue; }
      if (e.kind === 'chart') { addChart(pptx, s, e); continue; }
      const font = FONTS[e.font || 'body'];
      const common = { x: e.x, y: e.y, w: e.w, h: e.h, fontFace: font, fontSize: e.size, color: e.color, bold: !!e.bold, italic: !!e.italic, align: e.align || 'left', valign: e.valign || 'top', margin: e.margin === 0 ? 0 : 6, isTextBox: true, ...(e.opacity != null && e.opacity < 1 ? { transparency: Math.round((1 - e.opacity) * 100) } : {}), ...(e.charSpacing ? { charSpacing: e.charSpacing } : {}) };
      if (e.bullets) s.addText(e.bullets.map((b, k) => ({ text: b, options: { bullet: { indent: 14 }, breakLine: k < e.bullets.length - 1, paraSpaceAfter: e.paraSpace || 8 } })), common);
      else s.addText(e.text || ' ', common);
    }
    const n = notes.get(sl.slide_id) || sl.notes; if (n) s.addNotes(String(n));
  });
  return await pptx.write({ outputType: 'blob' });
}
/** Rasterize a chart element to a PNG data URL (used when exporting into a user template, where native charts are not written). */
export function chartPng(e, pxW = 1400) {
  const c = document.createElement('canvas'); const ratio = e.h && e.w ? e.h / e.w : 0.56; c.width = pxW; c.height = Math.round(pxW * ratio);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, c.width, c.height);
  drawChartCanvas(ctx, e, 0, 0, c.width, c.height, pxW / (e.w || W));
  return c.toDataURL('image/png');
}
function addChart(pptx, s, e) {
  if (!e.series.length || !e.labels.length) { s.addText('Chart data missing', { x: e.x, y: e.y, w: e.w, h: e.h, fontSize: 12, color: '888888', isTextBox: true }); return; }
  const type = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie, doughnut: pptx.ChartType.doughnut }[e.chartType] || pptx.ChartType.bar;
  const data = e.series.map(sr => ({ name: sr.name, labels: e.labels, values: sr.values }));
  const opts = { x: e.x, y: e.y, w: e.w, h: e.h, chartColors: e.colors, showTitle: !!e.title, title: e.title, titleFontSize: 14, titleColor: e.colors[0], showValue: true, dataLabelFontSize: 10, dataLabelPosition: e.chartType === 'pie' || e.chartType === 'doughnut' ? 'bestFit' : 'outEnd', showLegend: e.series.length > 1 || e.chartType === 'pie' || e.chartType === 'doughnut', legendPos: 'b', legendFontSize: 10, catAxisLabelColor: '666666', valAxisLabelColor: '666666', catAxisLabelFontSize: 10, valAxisLabelFontSize: 10, valGridLine: { color: 'E5E7EB', size: 0.5 }, catGridLine: { style: 'none' }, barDir: 'col' };
  if (e.chartType === 'pie' || e.chartType === 'doughnut') { delete opts.valGridLine; delete opts.catGridLine; }
  s.addChart(type, data, opts);
}

// ---------------------------------------------------------------- deck normalization (from model JSON or legacy arrays)
export function normalizeDeck(raw, outline = []) {
  let theme = null, arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object') { theme = raw.theme || (raw.palette ? { palette: raw.palette } : null); arr = Array.isArray(raw.slides) ? raw.slides : (Array.isArray(raw.deck) ? raw.deck : []); }
  const slides = arr.filter(x => x && typeof x === 'object').map((x, i) => {
    const layout = LAYOUTS.includes(x.layout) ? x.layout : (x.code ? 'code' : x.stats ? 'stats' : x.steps ? 'process' : x.chart ? 'chart' : x.quote ? 'quote' : (x.left || x.right) ? 'two_column' : i === 0 && arr.length > 2 && !x.bullets ? 'title' : 'bullets');
    const s = { slide_id: i + 1, layout, title: str(x.title || x.heading || outline[i]?.title || `Slide ${i + 1}`), notes: str(x.notes || x.speaker_notes || x.teaching_notes) };
    const copy = k => { if (x[k] !== undefined) s[k] = x[k]; };
    ['subtitle', 'bullets', 'callout', 'left', 'right', 'items', 'stats', 'note', 'steps', 'code', 'language', 'chart', 'source', 'quote', 'attribution', 'next'].forEach(copy);
    if (x.points && !s.bullets) s.bullets = x.points;
    if (s.bullets && !Array.isArray(s.bullets)) s.bullets = typeof s.bullets === 'string' ? s.bullets.split('\n').map(b => b.replace(/^[-*•]\s*/, '').trim()).filter(Boolean) : [];
    if (x.code_language && !s.language) s.language = x.code_language;
    return s;
  });
  return { theme, slides };
}
/** Read a stage output (new {theme,slides} or legacy array) into a deck. */
export function deckOf(text) { try { const v = JSON.parse(text); return normalizeDeck(v); } catch { return { theme: null, slides: [] }; } }
