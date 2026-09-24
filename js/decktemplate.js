// decktemplate.js — lay generated slides out on an instructor's own PowerPoint template.
// A parsed template (see template.js) knows its slide layouts and their placeholders; this module picks a
// layout for each deck slide and produces elements in deck.js's element schema. Text that sits in a
// template placeholder carries `ph: { type, idx }` so the .pptx writer emits a real placeholder (inheriting
// the template's position, fonts, bullets and colours) instead of a free text box.

const DEF_W = 10, DEF_H = 5.625, M = 0.5;
const BODY_TYPES = new Set(['body', 'obj']);
const CHROME = new Set(['dt', 'ftr', 'sldNum']);

/** Preferred template layouts per deck layout: OOXML layout types first, then name patterns. */
export const LAYOUT_ROLE = {
  title:      { types: ['title'], names: [/^title slide/i, /\btitle\b(?!.*(only|content))/i, /cover/i] },
  bullets:    { types: ['obj', 'tx'], names: [/title and (content|text)/i, /^content/i, /bullets?/i] },
  summary:    { types: ['obj', 'tx'], names: [/title and (content|text)/i, /^content/i, /summary|closing|conclusion/i] },
  icon_rows:  { types: ['titleOnly', 'obj', 'tx'], names: [/title only/i, /title and content/i] },
  two_column: { types: ['twoObj', 'twoTxTwoObj', 'twoColTx'], names: [/two content/i, /comparison/i, /two column/i] },
  quote:      { types: ['secHead', 'titleOnly'], names: [/section header/i, /section/i, /title only/i, /quote|statement/i] },
  stats:      { types: ['titleOnly', 'obj'], names: [/title only/i, /title and content/i] },
  process:    { types: ['titleOnly', 'obj'], names: [/title only/i, /title and content/i] },
  grid:       { types: ['titleOnly', 'obj'], names: [/title only/i, /title and content/i] },
  chart:      { types: ['titleOnly', 'obj', 'chart'], names: [/title only/i, /title and content/i] },
  code:       { types: ['titleOnly', 'obj'], names: [/title only/i, /title and content/i] },
};
const NATIVE = new Set(['title', 'bullets', 'two_column', 'summary', 'quote']);

const textPh = l => (l?.placeholders || []).filter(p => !CHROME.has(p.type));
const titleOf = l => textPh(l).find(p => p.type === 'title' || p.type === 'ctrTitle') || null;
const bodiesOf = l => textPh(l).filter(p => BODY_TYPES.has(p.type)).sort((a, b) => (a.idx ?? 99) - (b.idx ?? 99));
const subtitleOf = l => textPh(l).find(p => p.type === 'subTitle') || null;

/** Choose the template layout for a slide: instructor override → role mapping → any layout with a title → first. */
export function pickTemplateLayout(slide, tpl) {
  const layouts = tpl?.layouts || []; if (!layouts.length) return null;
  const want = String(slide?.template_layout || '').trim().toLowerCase();
  if (want) { const hit = layouts.find(l => l.name.toLowerCase() === want) || layouts.find(l => l.id.toLowerCase() === want); if (hit) return hit; }
  const role = LAYOUT_ROLE[slide?.layout] || LAYOUT_ROLE.bullets;
  const needsBody = ['bullets', 'summary', 'two_column'].includes(slide?.layout);
  for (const t of role.types) { const hit = layouts.find(l => l.type === t && (!needsBody || bodiesOf(l).length || subtitleOf(l))); if (hit) return hit; }
  for (const re of role.names) { const hit = layouts.find(l => re.test(l.name) && (!needsBody || bodiesOf(l).length)); if (hit) return hit; }
  if (needsBody) { const hit = layouts.find(l => titleOf(l) && bodiesOf(l).length); if (hit) return hit; }
  return layouts.find(l => titleOf(l)) || layouts[0];
}

/**
 * Elements for one slide on the template. Returns { layout, els, contentBox, native }.
 * native=true: the slide is fully expressed with placeholders. native=false: els hold the background and the
 * title only; the caller draws the slide's body into contentBox (inches) with its own elements.
 */
export function templateFrame(slide, th, index, total, meta = {}, tpl = {}) {
  const W = tpl.size?.w || DEF_W, H = tpl.size?.h || DEF_H;
  const master = tpl.master || {}; const mt = master.title || {}, mb = master.body || {};
  const layout = pickTemplateLayout(slide, tpl);
  const L = slide?.layout || 'bullets';
  const els = [];
  // background: layout-specific → master picture → master colour → white
  els.push({ kind: 'rect', x: 0, y: 0, w: W, h: H, fill: layout?.bgColor || tpl.bgColor || master.bgColor || 'FFFFFF', bgImage: layout?.background || tpl.background || master.background || null, isBackground: true });

  const tph = titleOf(layout), bodies = bodiesOf(layout), sub = subtitleOf(layout);
  const mTitle = (master.placeholders || []).find(p => p.type === 'title'), mBody = (master.placeholders || []).find(p => p.type === 'body');
  const titleBox = box(tph) || box(mTitle) || { x: M, y: 0.3, w: W - 2 * M, h: H * 0.16 };
  const bodyBox = box(bodies[0]) || box(mBody) || { x: M, y: titleBox.y + titleBox.h + 0.25, w: W - 2 * M, h: H - (titleBox.y + titleBox.h + 0.25) - 0.75 };
  const title = str(slide?.title || `Slide ${index + 1}`);
  const tSize = mt.size || 44, bSize = mb.size || 28;
  // Contrast guard: a dark layout/master background with dark master text (or a light one with light text) gets an explicit readable colour.
  const bgLum = layout?.bgLum ?? tpl.bgLum ?? master.bgLum ?? (layout?.bgColor ? lumHex(layout.bgColor) : 1);
  const contrast = (c) => { const l = lumHex(c); if (bgLum != null && bgLum < 0.35 && l < 0.45) return { color: 'FFFFFF', colorFixed: true }; if (bgLum != null && bgLum > 0.7 && l > 0.75) return { color: '1F2933', colorFixed: true }; return { color: c, colorFixed: false }; };
  const tc = contrast(clean(mt.color) || '1F2933'), bc = contrast(clean(mb.color) || '1F2933');
  const titleColor = tc.color, bodyColor = bc.color; const fixColor = tc.colorFixed || bc.colorFixed;

  const titleEl = (text, ph, b, o = {}) => { const size = o.size || fitTitle(text, tSize, b); return { kind: 'text', ...b, text, size, shrunk: size < tSize, font: 'head', color: titleColor, colorFixed: tc.colorFixed, align: o.align || mt.align || 'left', valign: o.valign || mt.anchor || 'middle', bold: false, margin: 0.1, ...(ph ? { ph: mark(ph) } : {}), ...o }; };
  const bodyEl = (paras, ph, b, o = {}) => {
    const items = paras.map(x => typeof x === 'string' ? { text: x, level: 0 } : { text: str(x.text ?? x), level: Number(x.level) || 0, heading: !!x.heading, plain: !!x.plain });
    const size = o.size || fitBody(items, bSize, b);
    return { kind: 'text', ...b, bullets: items.map(i => i.text), levels: items.map(i => i.level), headings: items.map(i => !!i.heading), plains: items.map(i => !!i.plain), size, shrunk: size < bSize, font: 'body', color: bodyColor, colorFixed: bc.colorFixed, align: 'left', valign: mb.anchor || 'top', margin: 0.1, paraSpace: 6, ...(ph ? { ph: mark(ph) } : {}), ...o };
  };

  if (!NATIVE.has(L)) {
    els.push(titleEl(title, tph, titleBox));
    // content area: this layout's body, else the master body, else the space under the title
    const cb = box(bodies[0]) || box(mBody) || { x: M, y: titleBox.y + titleBox.h + 0.2, w: W - 2 * M, h: H - (titleBox.y + titleBox.h + 0.2) - 0.75 };
    return { layout, els, contentBox: shrink(cb, W, H), native: false, size: { w: W, h: H } };
  }

  if (L === 'title') {
    els.push(titleEl(title, tph, titleBox, { align: mt.align || (tph?.type === 'ctrTitle' ? 'center' : 'left') }));
    const subText = [str(slide.subtitle), [meta.course, meta.presenter].filter(Boolean).join('  ·  ')].filter(Boolean);
    const target = sub || bodies[0];
    if (subText.length) {
      const b = box(target) || { x: titleBox.x, y: titleBox.y + titleBox.h + 0.2, w: titleBox.w, h: Math.min(1.5, H - titleBox.y - titleBox.h - 0.6) };
      els.push({ kind: 'text', ...b, bullets: subText, levels: subText.map(() => 0), plain: true, size: Math.round(Math.min(bSize, 24)), font: 'body', color: bodyColor, colorFixed: bc.colorFixed, align: tph?.type === 'ctrTitle' || mt.align === 'center' ? 'center' : 'left', valign: 'top', margin: 0.1, paraSpace: 4, ...(target ? { ph: mark(target) } : {}) });
    }
    return { layout, els, contentBox: null, native: true, size: { w: W, h: H } };
  }

  if (L === 'bullets' || L === 'summary') {
    els.push(titleEl(title, tph, titleBox));
    const pts = S(slide.bullets || slide.points).slice(0, 8);
    const callout = slide.callout && (slide.callout.text || slide.callout.label) ? slide.callout : null;
    const paras = L === 'summary' ? pts.map((p, i) => ({ text: p, level: 0 })) : pts.map(p => ({ text: p, level: 0 }));
    if (L === 'summary' && slide.next) paras.push({ text: `Next: ${str(slide.next)}`, level: 0, plain: true });
    if (callout && bodies.length >= 2) {
      els.push(bodyEl(paras, bodies[0], box(bodies[0]) || bodyBox, L === 'summary' ? { numbered: true } : {}));
      const cb = box(bodies[1]) || { x: bodyBox.x + bodyBox.w * 0.6, y: bodyBox.y, w: bodyBox.w * 0.4, h: bodyBox.h };
      els.push(bodyEl([{ text: str(callout.label || 'Key idea'), level: 0 }, { text: str(callout.text), level: 1 }], bodies[1], cb));
    } else {
      if (callout) paras.push({ text: `${str(callout.label || 'Key idea')}: ${str(callout.text)}`.replace(/:\s*$/, ''), level: 0 });
      els.push(bodyEl(paras, bodies[0], bodyBox, L === 'summary' ? { numbered: true } : {}));
    }
    return { layout, els, contentBox: null, native: true, size: { w: W, h: H } };
  }

  if (L === 'two_column') {
    els.push(titleEl(title, tph, titleBox));
    const cols = [slide.left, slide.right].map((c, i) => ({ heading: str(c?.heading || c?.title || (i === 0 ? 'Left' : 'Right')), items: S(c?.bullets || c?.points || c?.items).slice(0, 6) }));
    if (bodies.length >= 4) { // Comparison: heading, content, heading, content
      cols.forEach((c, i) => { const hp = bodies[i * 2], cp = bodies[i * 2 + 1]; els.push(bodyEl([{ text: c.heading, level: 0 }], hp, box(hp) || bodyBox, { plain: true, bold: true })); els.push(bodyEl(c.items, cp, box(cp) || bodyBox)); });
    } else if (bodies.length >= 2) {
      cols.forEach((c, i) => els.push(bodyEl([{ text: c.heading, level: 0, heading: true }, ...c.items.map(t => ({ text: t, level: 1 }))], bodies[i], box(bodies[i]) || half(bodyBox, i))));
    } else if (bodies.length === 1) {
      els.push(bodyEl(cols.flatMap(c => [{ text: c.heading, level: 0, heading: true }, ...c.items.map(t => ({ text: t, level: 1 }))]), bodies[0], bodyBox));
    } else {
      cols.forEach((c, i) => els.push(bodyEl([{ text: c.heading, level: 0, heading: true }, ...c.items.map(t => ({ text: t, level: 1 }))], null, half(bodyBox, i))));
    }
    return { layout, els, contentBox: null, native: true, size: { w: W, h: H } };
  }

  if (L === 'quote') {
    const q = `“${str(slide.quote || slide.statement || title)}”`; const who = slide.attribution ? `— ${str(slide.attribution)}` : '';
    if (layout?.type === 'secHead' || (tph && bodies.length)) {
      els.push(titleEl(q, tph, titleBox, { italic: true, size: fitTitle(q, Math.min(tSize, 40), titleBox) }));
      if (who) els.push(bodyEl([{ text: who, level: 0 }], bodies[0], box(bodies[0]) || { x: titleBox.x, y: titleBox.y + titleBox.h + 0.15, w: titleBox.w, h: 0.6 }, { plain: true, size: Math.min(bSize, 20) }));
    } else {
      const b = { x: M + 0.3, y: H * 0.22, w: W - 2 * M - 0.6, h: H * 0.45 };
      els.push(titleEl(q, tph, tph ? titleBox : b, { italic: true, size: fitTitle(q, Math.min(tSize, 36), tph ? titleBox : b) }));
      if (who) els.push({ kind: 'text', x: b.x, y: (tph ? titleBox.y + titleBox.h : b.y + b.h) + 0.1, w: b.w, h: 0.6, text: who, size: Math.min(bSize, 18), font: 'body', color: bodyColor, align: 'right', valign: 'top', margin: 0.1 });
    }
    return { layout, els, contentBox: null, native: true, size: { w: W, h: H } };
  }
  return { layout, els, contentBox: shrink(bodyBox, W, H), native: false, size: { w: W, h: H } };
}

// ---------------------------------------------------------------- helpers
const str = v => (v == null ? '' : String(v));
const S = v => (Array.isArray(v) ? v : []).map(x => (typeof x === 'string' ? x : x?.text || x?.point || String(x ?? ''))).filter(Boolean);
const clean = h => { const s = str(h).replace('#', '').toUpperCase().slice(0, 6); return /^[0-9A-F]{6}$/.test(s) ? s : null; };
function box(p) { return p && p.x != null && p.w > 0 && p.h > 0 ? { x: p.x, y: p.y, w: p.w, h: p.h } : null; }
function half(b, i) { const gap = 0.3; const w = (b.w - gap) / 2; return { x: b.x + i * (w + gap), y: b.y, w, h: b.h }; }
function shrink(b, W, H) { return { x: Math.max(0, b.x), y: Math.max(0, b.y), w: Math.min(b.w, W - Math.max(0, b.x)), h: Math.min(b.h, H - Math.max(0, b.y)) }; }
function mark(p) { return { type: p.hasType ? p.type : null, idx: p.idx ?? null }; }
/** Shrink a title so long titles stay inside the placeholder (points). */
function fitTitle(text, base, b) {
  const chars = str(text).length; const capacity = Math.max(12, (b?.w || 9) * 72 / (base * 0.5)) * Math.max(1, Math.floor(((b?.h || 1.2) * 72) / (base * 1.2)));
  let size = base; while (size > 18 && chars > capacity * (base / size) ** 2 * 0.9) size -= 2;
  return Math.round(size);
}
/** Shrink body text to the placeholder: estimate line count at each size until it fits (points). */
function fitBody(items, base, b) {
  const w = (b?.w || 9) * 72, h = (b?.h || 4) * 72;
  let size = base;
  for (; size > 12; size -= 2) {
    const perLine = Math.max(8, Math.floor(w / (size * 0.52)));
    const lines = items.reduce((a, it) => a + Math.max(1, Math.ceil((it.text.length + it.level * 4) / perLine)), 0);
    if (lines * size * 1.3 + items.length * 6 <= h) break;
  }
  return Math.round(size);
}

function lumHex(hex) { const c = String(hex || '').replace('#', ''); if (!/^[0-9A-Fa-f]{6}$/.test(c)) return 0; const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
