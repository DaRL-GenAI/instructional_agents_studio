// scenes.js — the animated lesson ("EduCast-style") renderer. A storyboard is {scenes:[...]}; each scene is a
// teaching board (title band, lecture column left, animated visual right, takeaway strip, progress bar) or a
// title card. drawScene() paints one frame for a progress value p∈[0,1] of the scene's narration, so the
// video is time-driven: lecture lines light up as the narration advances, the visual builds step by step.
import { PALETTES, resolveTheme } from './deck.js';
import { normalizePractice, drawPracticeCard } from './practice.js';

export const BEATS = ['title_card', 'bullets', 'formula', 'compare', 'steps', 'stat_row', 'recap', 'diagram', 'chart', 'illustration', 'practice'];

/** Deterministic layout guard: while `guard.on`, text that cannot fit its box even at the minimum size is recorded. */
export const guard = { on: false, findings: [] };
export function collectGuard(fn) { guard.on = true; guard.findings = []; try { fn(); } finally { guard.on = false; } return guard.findings.slice(); }
export const W = 1920, H = 1080;
const FONT = "Calibri, Carlito, 'Segoe UI', Arial, sans-serif";
const SERIF = "Cambria, 'Times New Roman', Georgia, serif";
const MONO = "Consolas, Menlo, 'DejaVu Sans Mono', monospace";

const str = v => (v == null ? '' : String(v));
const arr = v => (Array.isArray(v) ? v.map(x => (typeof x === 'string' ? x : x?.text || x?.label || JSON.stringify(x))).filter(Boolean) : []);
const easeOut = x => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const clamp01 = x => Math.min(1, Math.max(0, x));
/** progress of a sub-animation that starts at s and lasts d (both in 0..1 of the scene) */
const seg = (p, s, d) => easeOut((p - s) / d);
const hex = (h, a = 1) => { const c = h.replace('#', ''); const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16); return `rgba(${r},${g},${b},${a})`; };
const lum = h => { const c = h.replace('#', ''); const [r, g, b] = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

// ---------------------------------------------------------------- normalization
export function normalizeStoryboard(raw, slides = []) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.scenes) ? raw.scenes : []);
  const scenes = list.filter(x => x && typeof x === 'object').map((x, i) => {
    const beat = BEATS.includes(x.beat) ? x.beat : (x.scene_type === 'title_card' || (i === 0 && !x.beat) ? 'title_card' : 'bullets');
    // Merge beat fields wherever the model put them: inside "visual", nested one level deeper, or at the top level of the scene.
    const inner = x.visual && typeof x.visual === 'object' && !Array.isArray(x.visual) ? x.visual : (typeof x.visual === 'string' ? { caption: x.visual } : {});
    const v = { ...x, ...(inner.visual && typeof inner.visual === 'object' ? inner.visual : {}), ...inner, ...(inner.chart && typeof inner.chart === 'object' ? inner.chart : {}) };
    if (typeof v.formula === 'object' && v.formula) v.formula = v.formula.text || v.formula.latex || v.formula.formula || '';
    if (typeof v.steps === 'object' && v.steps && !Array.isArray(v.steps)) v.steps = Object.values(v.steps);
    const s = {
      id: str(x.id || `s${i + 1}`), beat, title: str(x.title || `Scene ${i + 1}`),
      narration: str(x.narration), lecture_lines: arr(x.lecture_lines).slice(0, 5), animations: arr(x.animations).slice(0, 5),
      takeaway: str(x.takeaway || x.caption), key_scene: !!x.key_scene, key_elements: arr(x.key_elements).slice(0, 8),
      target_seconds: Number(x.target_seconds) || Math.max(12, Math.round(str(x.narration).split(/\s+/).length / 2.6)),
      visual: {},
    };
    if (beat === 'title_card') s.visual = { subtitle: str(v.subtitle), accent_label: str(v.accent_label || v.label) };
    if (beat === 'bullets' || beat === 'recap') s.visual = { bullets: arr(v.bullets).slice(0, 5), formula: str(v.formula), highlights: arr(v.highlights) };
    if (beat === 'formula') s.visual = { formula: str(v.formula), bullets: arr(v.bullets).slice(0, 4), highlights: arr(v.highlights) };
    if (beat === 'compare') s.visual = { left_title: str(v.left_title), left_items: arr(v.left_items).slice(0, 4), right_title: str(v.right_title), right_items: arr(v.right_items).slice(0, 4), formula: str(v.formula) };
    if (beat === 'steps') s.visual = { steps: arr(v.steps).slice(0, 5) };
    if (beat === 'stat_row') s.visual = { stats: (Array.isArray(v.stats) ? v.stats : []).slice(0, 4).map(t => ({ value: str(t?.value), unit: str(t?.unit), name: str(t?.name || t?.label) })) };
    if (beat === 'diagram') s.visual = { nodes: (Array.isArray(v.nodes) ? v.nodes : []).slice(0, 8).map((n, k) => typeof n === 'string' ? { id: `n${k + 1}`, label: n } : { id: str(n?.id || `n${k + 1}`), label: str(n?.label || n?.text), kind: str(n?.kind) }), edges: (Array.isArray(v.edges) ? v.edges : []).slice(0, 12).map(e => ({ from: str(e?.from), to: str(e?.to), label: str(e?.label) })), caption: str(v.caption) };
    if (beat === 'chart') s.visual = { type: ['bar', 'line', 'pie'].includes(v.type || v.chart?.type) ? (v.type || v.chart.type) : 'bar', labels: arr(v.labels || v.chart?.labels), series: (Array.isArray(v.series || v.chart?.series) ? (v.series || v.chart.series) : []).map(sr => ({ name: str(sr?.name || 'Series'), values: (Array.isArray(sr?.values) ? sr.values : []).map(Number).map(n => (isFinite(n) ? n : 0)) })), unit: str(v.unit || v.chart?.unit), highlight: str(v.highlight) };
    if (beat === 'illustration') s.visual = { prompt: str(v.prompt || v.image_prompt || x.illustration_prompt || x.visual_brief), caption: str(v.caption || x.takeaway), labels: arr(v.labels).slice(0, 5) };
    if (beat === 'practice') {
      // Models put the template id and instruction either next to "parameters" or inside it; accept both.
      const pp = v.parameters && typeof v.parameters === 'object' && !Array.isArray(v.parameters) ? v.parameters : (x.parameters && typeof x.parameters === 'object' ? x.parameters : v);
      const params = { ...pp }; const tplId = v.template || x.template || pp.template || pp.template_id; delete params.template; delete params.template_id;
      const instr = v.instruction || x.instruction || pp.instruction || x.title; if (pp === v) { for (const k of ['template', 'instruction', 'warnings']) delete params[k]; }
      const pr = normalizePractice({ template: tplId, parameters: params, instruction: instr });
      s.visual = { template: pr.template, parameters: pr.parameters, instruction: pr.instruction, warnings: pr.warnings };
    }
    s.visual_brief = str(x.visual_brief);
    if (!hasVisual(s)) {
      // The model left the visual card empty: teach from the lecture lines / key elements instead of showing a blank card.
      const lines = s.lecture_lines.length ? s.lecture_lines : (s.key_elements.length ? s.key_elements : (s.takeaway ? [s.takeaway] : []));
      if (beat !== 'title_card' && lines.length) { s.beat = beat === 'recap' ? 'recap' : 'bullets'; s.visual = { bullets: lines.slice(0, 5), formula: '', highlights: [] }; s.visual_fallback = true; }
      else if (beat === 'title_card') s.visual = { subtitle: str(v.subtitle || x.title), accent_label: str(v.accent_label || v.label) };
    }
    return s;
  });
  return { scenes };
}

/** True when a scene's visual carries real content for its beat (a blank card means the model skipped it). */
export function hasVisual(s) {
  const v = s.visual || {}; const n = (a) => (Array.isArray(a) ? a.filter(Boolean).length : 0);
  switch (s.beat) {
    case 'title_card': return true;
    case 'bullets': case 'recap': return n(v.bullets) > 0 || !!v.formula;
    case 'formula': return !!v.formula || n(v.bullets) > 0;
    case 'compare': return n(v.left_items) + n(v.right_items) > 0;
    case 'steps': return n(v.steps) > 0;
    case 'stat_row': return n(v.stats) > 0 && v.stats.some(t => t.value);
    case 'diagram': return n(v.nodes) >= 2;
    case 'chart': return n(v.labels) > 0 && n(v.series) > 0 && v.series.some(sr => sr.values.length);
    case 'illustration': return !!v.prompt;
    case 'practice': return !!v.template && !!v.parameters;
    default: return false;
  }
}
/** Count of scenes whose visual had to be replaced by a fallback (used by the pipeline to decide on a retry). */
export function storyboardGaps(sb) { return (sb.scenes || []).filter(s => s.visual_fallback).length; }
export function storyboardOf(text) { try { return normalizeStoryboard(JSON.parse(text)); } catch { return { scenes: [] }; } }

// ---------------------------------------------------------------- text helpers
function wrap(ctx, text, maxW) { const words = String(text ?? '').split(/\s+/); const lines = []; let cur = ''; for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines.length ? lines : ['']; }
/** Fit text into a box: shrink font until it fits; returns lines and the font size. */
function fit(ctx, text, w, h, size, minSize, weight = 400, family = FONT, lh = 1.28) {
  let fs = size;
  for (; fs >= minSize; fs -= Math.max(1, fs * 0.06)) { ctx.font = `${weight} ${fs}px ${family}`; const lines = wrap(ctx, text, w); if (lines.length * fs * lh <= h && lines.every(l => ctx.measureText(l).width <= w)) return { lines, fs }; }
  ctx.font = `${weight} ${minSize}px ${family}`; const all = wrap(ctx, text, w); const keep = Math.max(1, Math.floor(h / (minSize * lh)));
  if (guard.on && (all.length > keep || all.some(l => ctx.measureText(l).width > w))) guard.findings.push({ kind: 'text_overflow', severity: 'major', message: `text "${String(text).slice(0, 48)}${String(text).length > 48 ? '…' : ''}" does not fit its box even at ${minSize}px${all.length > keep ? ` (${all.length - keep} line(s) clipped)` : ' (line wider than the box)'}` });
  return { lines: all.slice(0, keep), fs: minSize };
}
function text(ctx, t, x, y, w, h, { size = 32, min = 16, weight = 400, color = '#000', align = 'left', valign = 'top', family = FONT, alpha = 1, lh = 1.28, highlights = [], hlColor = null } = {}) {
  if (!t) return 0;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.textBaseline = 'top';
  const { lines, fs } = fit(ctx, t, w, h, size, min, weight, family, lh);
  const total = lines.length * fs * lh; let cy = valign === 'middle' ? y + (h - total) / 2 : valign === 'bottom' ? y + h - total : y;
  ctx.font = `${weight} ${fs}px ${family}`;
  for (const l of lines) {
    let cx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x; ctx.textAlign = align;
    if (highlights.length && hlColor) drawHighlighted(ctx, l, cx, cy, align, highlights, color, hlColor); else { ctx.fillStyle = color; ctx.fillText(l, cx, cy); }
    cy += fs * lh;
  }
  ctx.restore(); return total;
}
function drawHighlighted(ctx, line, cx, cy, align, highlights, color, hlColor) {
  const pattern = new RegExp(`(${highlights.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  const parts = line.split(pattern).filter(Boolean); const total = ctx.measureText(line).width;
  let x = align === 'center' ? cx - total / 2 : align === 'right' ? cx - total : cx; ctx.textAlign = 'left';
  for (const part of parts) { const hl = highlights.includes(part); ctx.fillStyle = hl ? hlColor : color; if (hl) { const f = ctx.font; ctx.font = f.replace(/^\d+/, '800').replace(/^normal|^400|^500|^600|^700/, '800'); ctx.fillText(part, x, cy); x += ctx.measureText(part).width; ctx.font = f; } else { ctx.fillText(part, x, cy); x += ctx.measureText(part).width; } }
}
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function card(ctx, x, y, w, h, color, bg, alpha = 1) { ctx.save(); ctx.globalAlpha *= alpha; rr(ctx, x, y, w, h, 14); ctx.fillStyle = bg; ctx.fill(); ctx.fillStyle = hex(color, 0.05); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = hex(color, 0.4); ctx.stroke(); ctx.restore(); }

// ---------------------------------------------------------------- theme → tokens
export function sceneTokens(theme) {
  const primary = '#' + theme.primary, secondary = '#' + theme.accent, bg = '#FAFBF8', textC = '#17201B', muted = '#66706A', danger = '#B4423D', soft = '#' + theme.secondary;
  return { primary, secondary, bg, text: textC, muted, danger, soft, onPrimary: lum(theme.primary) > 0.4 ? '#17201B' : '#FFFFFF' };
}

// ---------------------------------------------------------------- board geometry (EduHarness template)
const PAD = 60;
function regions() {
  const safeW = W - 2 * PAD, lectureW = Math.round(safeW * 0.28), gap = Math.round(safeW * 0.04), top = Math.round(H * 0.18), bottom = Math.round(H * 0.84);
  const visualX = PAD + lectureW + gap, visualW = safeW - lectureW - gap, resultH = Math.round((bottom - top) * 0.23), mainH = bottom - top - resultH - gap;
  return { title: { x: PAD, y: PAD, w: safeW, h: Math.round(H * 0.14) - PAD }, lecture: { x: PAD, y: top, w: lectureW, h: bottom - top }, main: { x: visualX, y: top, w: visualW, h: mainH }, result: { x: visualX, y: top + mainH + gap, w: visualW, h: resultH }, footer: { x: PAD, y: bottom, w: safeW, h: H - bottom - PAD } };
}

/** Draw one frame. p = progress 0..1 through the scene. assets: {images:{[sceneId]: HTMLImageElement}, characters:[img]} */
export function drawScene(ctx, scene, theme, p, { index = 0, total = 1, assets = {}, meta = {} } = {}) {
  const t = sceneTokens(theme); p = clamp01(p);
  ctx.save(); ctx.fillStyle = t.bg; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'top';
  if (scene.beat === 'title_card') { drawTitleCard(ctx, scene, t, p, assets, meta); ctx.restore(); return; }
  const r = regions();
  // frame + title band
  ctx.strokeStyle = hex(t.primary.slice(1), 0.2); ctx.lineWidth = 2; ctx.strokeRect(PAD * 0.55, PAD * 0.55, W - PAD * 1.1, H - PAD * 1.1);
  const tp = seg(p, 0, 0.08);
  ctx.save(); ctx.globalAlpha = tp; ctx.translate(0, (1 - tp) * 18);
  text(ctx, scene.title, r.title.x, r.title.y, r.title.w, r.title.h, { size: 58, min: 30, weight: 700, color: t.primary, family: SERIF, valign: 'middle' });
  ctx.fillStyle = t.secondary; ctx.fillRect(r.title.x, r.title.y + r.title.h - 6, 150, 7);
  ctx.restore();
  // lecture column: lines appear progressively, active line highlighted by narration progress
  const lines = scene.lecture_lines.length ? scene.lecture_lines : [scene.takeaway || scene.title];
  const weights = lines.map(l => Math.max(1, l.split(/\s+/).length)); const totalW = weights.reduce((a, b) => a + b, 0);
  let acc = 0; const bounds = weights.map(w => { const s = acc / totalW; acc += w; return [s, acc / totalW]; });
  const active = bounds.findIndex(([s, e]) => p >= s && p < e); const rowH = Math.min(150, r.lecture.h / lines.length);
  lines.forEach((l, i) => {
    const a = seg(p, Math.max(0, bounds[i][0] - 0.03), 0.06); if (a <= 0) return;
    const y = r.lecture.y + i * rowH; const isActive = i === active || (active === -1 && i === lines.length - 1);
    ctx.save(); ctx.globalAlpha = a; ctx.translate((1 - a) * -14, 0);
    if (isActive) { ctx.fillStyle = hex(t.secondary.slice(1), 0.12); rr(ctx, r.lecture.x - 10, y - 6, r.lecture.w + 20, rowH - 8, 10); ctx.fill(); }
    ctx.fillStyle = isActive ? t.secondary : hex(t.muted.slice(1), 0.75); ctx.beginPath(); ctx.arc(r.lecture.x + 14, y + 20, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `700 15px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), r.lecture.x + 14, y + 12); ctx.textAlign = 'left';
    text(ctx, l, r.lecture.x + 38, y + 4, r.lecture.w - 40, rowH - 14, { size: 28, min: 16, weight: isActive ? 600 : 500, color: isActive ? t.text : hex(t.text.slice(1), 0.78) });
    ctx.restore();
  });
  // main visual
  drawMain(ctx, scene, t, p, r.main, assets);
  // result strip: takeaway slides up during the last part
  const rp = seg(p, 0.62, 0.12);
  if (rp > 0 && (scene.takeaway || scene.visual.formula)) { ctx.save(); ctx.globalAlpha = rp; ctx.translate(0, (1 - rp) * 24); card(ctx, r.result.x, r.result.y, r.result.w, r.result.h, t.secondary, t.bg); text(ctx, scene.takeaway || scene.visual.formula, r.result.x + 24, r.result.y + 16, r.result.w - (assets.characters?.length ? W / 3 - 40 : 48), r.result.h - 32, { size: 34, min: 18, weight: 700, color: t.secondary, align: 'center', valign: 'middle' }); ctx.restore(); }
  // character accent
  const chars = assets.characters || []; if (chars.length) { const img = chars[index % chars.length]; const h = H / 3, w = h * (img.width / img.height); const cp = seg(p, 0.02, 0.1); ctx.save(); ctx.globalAlpha = 0.95 * cp; ctx.drawImage(img, W - PAD - w, H - PAD - h + (1 - cp) * 40, w, h); ctx.restore(); }
  // progress bar
  ctx.fillStyle = hex(t.primary.slice(1), 0.15); ctx.fillRect(PAD, H - PAD * 0.55 - 4, W - 2 * PAD, 4);
  ctx.fillStyle = t.primary; ctx.fillRect(PAD, H - PAD * 0.55 - 4, (W - 2 * PAD) * ((index + p) / Math.max(total, 1)), 4);
  if (meta.course) { ctx.fillStyle = t.muted; ctx.font = `500 20px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(meta.course, PAD, H - PAD * 0.55 - 34); }
  ctx.restore();
}

function drawTitleCard(ctx, scene, t, p, assets, meta) {
  const v = scene.visual || {};
  const a1 = seg(p, 0.05, 0.25), a2 = seg(p, 0.18, 0.25), a3 = seg(p, 0.35, 0.22);
  ctx.save(); ctx.globalAlpha = a1; ctx.translate(0, (1 - a1) * 28);
  text(ctx, scene.title, PAD * 2, H * 0.3, W - PAD * 4, H * 0.2, { size: 120, min: 48, weight: 700, color: t.primary, family: SERIF, align: 'center', valign: 'middle' });
  ctx.fillStyle = t.secondary; ctx.fillRect((W - W * 0.12) / 2, H * 0.525, W * 0.12, 7); ctx.restore();
  ctx.save(); ctx.globalAlpha = a2; ctx.translate(0, (1 - a2) * 22); text(ctx, v.subtitle || scene.narration.split(/[.!?]/)[0], PAD * 3, H * 0.57, W - PAD * 6, H * 0.1, { size: 46, min: 24, weight: 500, color: t.text, align: 'center', valign: 'middle' }); ctx.restore();
  ctx.save(); ctx.globalAlpha = a3; text(ctx, v.accent_label || meta.course || '', PAD * 2, H * 0.68, W - PAD * 4, H * 0.06, { size: 26, min: 16, weight: 600, color: t.muted, align: 'center', valign: 'middle' }); ctx.restore();
  const chars = assets.characters || []; if (chars.length) {
    const h = H * 0.52; const items = [[chars[0], 'left', 0], [chars[1 % chars.length], 'left', 1], [chars[2 % chars.length], 'right', 0], [chars[0], 'right', 1]];
    items.forEach(([img, side, k]) => { const w = h * (img.width / img.height); const rise = (1 - seg(p, 0.06 + k * 0.05, 0.28)) * h * 0.55; const off = k * w * 0.64 - w * 0.2; const x = side === 'left' ? off : W - off - w; ctx.drawImage(img, x, H - h * 0.83 + rise, w, h); });
  }
}

function drawMain(ctx, scene, t, p, box, assets) {
  const v = scene.visual || {}; const inset = 30; const x = box.x + inset, y = box.y + inset, w = box.w - inset * 2, h = box.h - inset * 2;
  const mp = seg(p, 0.06, 0.1); if (mp <= 0) return;
  ctx.save(); ctx.globalAlpha = mp;
  const beat = scene.beat;
  if (beat === 'illustration' && assets.images?.[scene.id]) {
    const img = assets.images[scene.id]; card(ctx, box.x, box.y, box.w, box.h, t.primary, t.bg);
    const z = 1 + 0.06 * p; const iw = w * z, ih = iw * (img.height / img.width); const ratio = Math.min(w / img.width, h / img.height); const dw = img.width * ratio * z, dh = img.height * ratio * z;
    ctx.save(); rr(ctx, x, y, w, h, 10); ctx.clip(); ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); ctx.restore();
    if (v.caption) { const cp = seg(p, 0.5, 0.15); ctx.save(); ctx.globalAlpha = cp; ctx.fillStyle = hex('FFFFFF', 0.88); rr(ctx, x + 16, y + h - 74, w - 32, 58, 10); ctx.fill(); text(ctx, v.caption, x + 28, y + h - 66, w - 56, 44, { size: 26, min: 16, weight: 600, color: t.text, valign: 'middle' }); ctx.restore(); }
    ctx.restore(); return;
  }
  if (beat === 'practice') { drawPracticeCard(ctx, scene, t, p, box); ctx.restore(); return; }
  if (beat === 'illustration') { beat_bullets(ctx, { bullets: v.labels?.length ? v.labels : [v.caption || scene.takeaway], highlights: [] }, t, p, x, y, w, h, box, true); ctx.restore(); return; }
  if (beat === 'bullets' || beat === 'recap') beat_bullets(ctx, { bullets: v.bullets, formula: beat === 'recap' ? v.formula : '', highlights: v.highlights }, t, p, x, y, w, h, box);
  else if (beat === 'formula') { card(ctx, box.x, box.y, box.w, box.h, t.primary, t.bg); const fp = seg(p, 0.1, 0.18); ctx.save(); ctx.globalAlpha = fp; const sc = 0.9 + 0.1 * fp; ctx.translate(x + w / 2, y + h * 0.22); ctx.scale(sc, sc); ctx.translate(-(x + w / 2), -(y + h * 0.22)); text(ctx, v.formula, x, y, w, h * 0.44, { size: 76, min: 30, weight: 700, color: t.primary, family: SERIF, align: 'center', valign: 'middle', highlights: v.highlights, hlColor: t.secondary }); ctx.restore(); (v.bullets || []).forEach((b, i) => { const bp = seg(p, 0.3 + i * 0.1, 0.1); if (bp <= 0) return; ctx.save(); ctx.globalAlpha = bp; ctx.translate((1 - bp) * 20, 0); text(ctx, `•  ${b}`, x + 20, y + h * 0.48 + i * (h * 0.5 / Math.max(v.bullets.length, 1)), w - 40, h * 0.5 / Math.max(v.bullets.length, 1) - 6, { size: 32, min: 18, color: t.text, valign: 'middle' }); ctx.restore(); }); }
  else if (beat === 'compare') {
    card(ctx, box.x, box.y, box.w, box.h, t.secondary, t.bg); const strip = v.formula ? h * 0.22 : 0; const colH = h - strip; const colW = w * 0.47;
    [[v.left_title, v.left_items, t.danger, x, 0.08], [v.right_title, v.right_items, t.secondary, x + w * 0.53, 0.3]].forEach(([title, items, color, cx, start]) => {
      const cp = seg(p, start, 0.14); if (cp <= 0) return; ctx.save(); ctx.globalAlpha = cp; ctx.translate((1 - cp) * (color === t.danger ? -30 : 30), 0);
      text(ctx, title, cx, y, colW, 50, { size: 34, min: 20, weight: 700, color }); (items || []).forEach((it, i) => { const ip = seg(p, start + 0.08 + i * 0.06, 0.08); ctx.save(); ctx.globalAlpha = ip; text(ctx, `•  ${it}`, cx, y + 60 + i * ((colH - 60) / Math.max(items.length, 1)), colW, (colH - 60) / Math.max(items.length, 1) - 4, { size: 30, min: 18, color: t.text, weight: 500 }); ctx.restore(); }); ctx.restore();
    });
    if (v.formula) { const fp = seg(p, 0.55, 0.12); ctx.save(); ctx.globalAlpha = fp; ctx.fillStyle = hex(t.primary.slice(1), 0.08); rr(ctx, x, y + colH + 8, w, strip - 16, 10); ctx.fill(); text(ctx, v.formula, x, y + colH + 8, w, strip - 16, { size: 44, min: 22, weight: 700, color: t.primary, family: SERIF, align: 'center', valign: 'middle' }); ctx.restore(); }
  }
  else if (beat === 'steps') {
    card(ctx, box.x, box.y, box.w, box.h, t.primary, t.bg); const steps = v.steps || []; const n = Math.max(steps.length, 1); const rowH = h / n;
    steps.forEach((s, i) => { const sp = seg(p, 0.08 + i * (0.5 / n), 0.12); if (sp <= 0) return; const yy = y + i * rowH; ctx.save(); ctx.globalAlpha = sp; ctx.translate((1 - sp) * 30, 0);
      ctx.fillStyle = t.primary; ctx.beginPath(); ctx.arc(x + 28, yy + rowH / 2, 26, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = t.onPrimary; ctx.font = `700 26px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x + 28, yy + rowH / 2 + 1); ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      if (i < n - 1) { ctx.strokeStyle = hex(t.primary.slice(1), 0.35); ctx.lineWidth = 4; ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.moveTo(x + 28, yy + rowH / 2 + 30); ctx.lineTo(x + 28, yy + rowH - 6); ctx.stroke(); ctx.setLineDash([]); }
      text(ctx, s, x + 76, yy + 8, w - 90, rowH - 16, { size: 34, min: 18, weight: 600, color: t.text, valign: 'middle' }); ctx.restore(); });
  }
  else if (beat === 'stat_row') {
    const stats = v.stats || []; const rows = Math.max(1, Math.ceil(stats.length / 2)); const cols = stats.length > 1 ? 2 : 1; const gap = 24; const cw = (w - gap * (cols - 1)) / cols, ch = (h - gap * (rows - 1)) / rows;
    stats.forEach((s, i) => { const sp = seg(p, 0.08 + i * 0.12, 0.2); if (sp <= 0) return; const cx = x + (i % cols) * (cw + gap), cy = y + Math.floor(i / cols) * (ch + gap); const color = i % 2 ? t.secondary : t.primary;
      ctx.save(); ctx.globalAlpha = sp; card(ctx, cx, cy, cw, ch, color, t.bg);
      const num = parseFloat(String(s.value).replace(/[^0-9.\-]/g, '')); const shown = isFinite(num) && /^[\s$€£¥]*-?[\d.,]+\s*[%kKmMx×]?$/.test(String(s.value).trim()) ? String(s.value).replace(/-?[\d.,]+/, m => { const dec = (m.split('.')[1] || '').length; return (num * seg(p, 0.08 + i * 0.12, 0.35)).toFixed(dec); }) : s.value;
      text(ctx, [shown, s.unit].filter(Boolean).join(' '), cx + 10, cy + 10, cw - 20, ch * 0.6, { size: 88, min: 36, weight: 700, color, family: SERIF, align: 'center', valign: 'middle' }); text(ctx, s.name, cx + 10, cy + ch * 0.64, cw - 20, ch * 0.32, { size: 28, min: 16, color: t.muted, align: 'center' }); ctx.restore(); });
  }
  else if (beat === 'diagram') drawDiagram(ctx, v, t, p, x, y, w, h, box);
  else if (beat === 'chart') drawChart(ctx, v, t, p, x, y, w, h, box);
  ctx.restore();
}

function beat_bullets(ctx, v, t, p, x, y, w, h, box, plain = false) {
  card(ctx, box.x, box.y, box.w, box.h, t.primary, t.bg);
  const bullets = v.bullets || []; const formulaH = v.formula ? h * 0.28 : 0; const n = Math.max(bullets.length, 1); const rowH = (h - formulaH) / n;
  bullets.forEach((b, i) => { const bp = seg(p, 0.08 + i * (0.55 / n), 0.12); if (bp <= 0) return; ctx.save(); ctx.globalAlpha = bp; ctx.translate((1 - bp) * 26, 0); ctx.fillStyle = t.secondary; ctx.beginPath(); ctx.arc(x + 14, y + i * rowH + Math.min(rowH / 2, 26), 8, 0, Math.PI * 2); ctx.fill(); text(ctx, b, x + 40, y + i * rowH + 4, w - 50, rowH - 8, { size: plain ? 40 : 36, min: 20, weight: 500, color: t.text, valign: 'top', highlights: v.highlights || [], hlColor: t.secondary }); ctx.restore(); });
  if (v.formula) { const fp = seg(p, 0.6, 0.15); ctx.save(); ctx.globalAlpha = fp; ctx.fillStyle = hex(t.primary.slice(1), 0.08); rr(ctx, x, y + h - formulaH + 10, w, formulaH - 10, 10); ctx.fill(); text(ctx, v.formula, x + 12, y + h - formulaH + 10, w - 24, formulaH - 10, { size: 48, min: 22, weight: 700, color: t.primary, family: SERIF, align: 'center', valign: 'middle' }); ctx.restore(); }
}

function drawDiagram(ctx, v, t, p, x, y, w, h, box) {
  card(ctx, box.x, box.y, box.w, box.h, t.primary, t.bg);
  const nodes = v.nodes || []; if (!nodes.length) return; const edges = v.edges || [];
  // simple layered left→right layout by longest path from sources
  const idx = new Map(nodes.map((n, i) => [n.id, i])); const depth = nodes.map(() => 0); const indeg = nodes.map(() => 0);
  edges.forEach(e => { if (idx.has(e.to)) indeg[idx.get(e.to)]++; });
  for (let iter = 0; iter < nodes.length; iter++) edges.forEach(e => { if (idx.has(e.from) && idx.has(e.to)) depth[idx.get(e.to)] = Math.max(depth[idx.get(e.to)], depth[idx.get(e.from)] + 1); });
  const layers = Math.max(...depth) + 1; const byLayer = Array.from({ length: layers }, () => []); nodes.forEach((n, i) => byLayer[depth[i]].push(i));
  const capH = v.caption ? 56 : 0; const nodeW = Math.min(300, (w - 40) / layers - 40), nodeH = 84; const pos = nodes.map(() => null);
  byLayer.forEach((ids, L) => { const cx = x + (layers === 1 ? w / 2 : 40 + nodeW / 2 + L * ((w - 80 - nodeW) / (layers - 1))); ids.forEach((i, k) => { const cy = y + (h - capH) * (k + 1) / (ids.length + 1); pos[i] = { x: cx - nodeW / 2, y: cy - nodeH / 2 }; }); });
  const order = nodes.map((_, i) => i).sort((a, b) => depth[a] - depth[b]); const nStart = i => 0.06 + order.indexOf(i) * (0.5 / nodes.length);
  edges.forEach(e => { const a = idx.get(e.from), b = idx.get(e.to); if (a == null || b == null) return; const ep = seg(p, nStart(b) - 0.04, 0.12); if (ep <= 0) return; const A = pos[a], B = pos[b]; const x1 = A.x + nodeW, y1 = A.y + nodeH / 2, x2 = B.x, y2 = B.y + nodeH / 2; const ex = x1 + (x2 - x1) * ep, ey = y1 + (y2 - y1) * ep;
    ctx.save(); ctx.strokeStyle = t.secondary; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1 + 40, y1, ex - 40, ey, ex, ey); ctx.stroke(); if (ep > 0.98) { ctx.fillStyle = t.secondary; ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 16, y2 - 9); ctx.lineTo(x2 - 16, y2 + 9); ctx.closePath(); ctx.fill(); }
    if (e.label && ep > 0.9) { ctx.globalAlpha = seg(p, nStart(b) + 0.06, 0.08); text(ctx, e.label, (x1 + x2) / 2 - 90, (y1 + y2) / 2 - 34, 180, 30, { size: 20, min: 14, weight: 600, color: t.muted, align: 'center' }); } ctx.restore(); });
  nodes.forEach((n, i) => { const np = seg(p, nStart(i), 0.1); if (np <= 0) return; const P = pos[i]; ctx.save(); ctx.globalAlpha = np; const sc = 0.85 + 0.15 * np; ctx.translate(P.x + nodeW / 2, P.y + nodeH / 2); ctx.scale(sc, sc); ctx.translate(-(P.x + nodeW / 2), -(P.y + nodeH / 2));
    const fill = n.kind === 'result' || n.kind === 'output' ? t.secondary : n.kind === 'danger' ? t.danger : n.kind === 'input' ? t.soft : t.primary; const fg = fill === t.soft ? t.text : (lum(fill.slice(1)) > 0.4 ? '#17201B' : '#FFFFFF');
    rr(ctx, P.x, P.y, nodeW, nodeH, 14); ctx.fillStyle = fill; ctx.fill(); text(ctx, n.label, P.x + 10, P.y + 6, nodeW - 20, nodeH - 12, { size: 28, min: 16, weight: 600, color: fg, align: 'center', valign: 'middle' }); ctx.restore(); });
  if (v.caption) { ctx.save(); ctx.globalAlpha = seg(p, 0.55, 0.15); text(ctx, v.caption, x, y + h - capH + 8, w, capH - 8, { size: 26, min: 16, weight: 500, color: t.muted, align: 'center', valign: 'middle' }); ctx.restore(); }
}

function drawChart(ctx, v, t, p, x, y, w, h, box) {
  card(ctx, box.x, box.y, box.w, box.h, t.primary, t.bg);
  const labels = v.labels || [], series = v.series || []; if (!labels.length || !series.length) return;
  const colors = [t.primary, t.secondary, t.danger, t.muted]; const padL = 90, padB = 70, padT = 30; const pw = w - padL - 20, ph = h - padT - padB; const gp = seg(p, 0.1, 0.5);
  if (v.type === 'pie') { const vals = series[0].values; const tot = vals.reduce((a, b) => a + b, 0) || 1; let a0 = -Math.PI / 2; const cx = x + w * 0.32, cy = y + h / 2, r = Math.min(w, h) * 0.36; vals.forEach((val, i) => { const a1 = a0 + 2 * Math.PI * val / tot * gp; ctx.fillStyle = colors[i % colors.length]; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a0, a1); ctx.closePath(); ctx.fill(); a0 = a1; }); labels.forEach((l, i) => { ctx.fillStyle = colors[i % colors.length]; ctx.fillRect(x + w * 0.62, y + 60 + i * 46, 22, 22); ctx.fillStyle = t.text; ctx.font = `500 26px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(`${l}  ${Math.round(100 * (vals[i] || 0) / tot)}%`, x + w * 0.62 + 34, y + 58 + i * 46); }); return; }
  const maxV = Math.max(...series.flatMap(s => s.values), 0) || 1; const n = labels.length; const gw = pw / n;
  ctx.strokeStyle = hex(t.muted.slice(1), 0.25); ctx.lineWidth = 2; for (let g = 0; g <= 4; g++) { const gy = y + padT + ph - ph * g / 4; ctx.beginPath(); ctx.moveTo(x + padL, gy); ctx.lineTo(x + w - 20, gy); ctx.stroke(); ctx.fillStyle = t.muted; ctx.font = `500 20px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText(fmt(maxV * g / 4), x + padL - 10, gy - 10); }
  ctx.textAlign = 'center'; labels.forEach((l, i) => { const hl = isHighlight(l, v.highlight); ctx.fillStyle = hl ? t.secondary : t.text; ctx.font = `${hl ? 800 : 500} 22px ${FONT}`; ctx.fillText(String(l).slice(0, 14), x + padL + gw * i + gw / 2, y + h - padB + 16); });
  if (v.type === 'line') series.forEach((s, si) => { ctx.strokeStyle = colors[si % colors.length]; ctx.lineWidth = 6; ctx.beginPath(); const pts = s.values.map((val, i) => [x + padL + gw * i + gw / 2, y + padT + ph - ph * val / maxV]); const upto = gp * (pts.length - 1); pts.forEach(([px, py], i) => { if (i > Math.ceil(upto)) return; if (i === 0) ctx.moveTo(px, py); else if (i <= Math.floor(upto)) ctx.lineTo(px, py); else { const f = upto - Math.floor(upto); const [qx, qy] = pts[i - 1]; ctx.lineTo(qx + (px - qx) * f, qy + (py - qy) * f); } }); ctx.stroke(); });
  else { const bw = gw / (series.length + 1); series.forEach((s, si) => s.values.forEach((val, i) => { const bh = ph * val / maxV * seg(p, 0.1 + i * (0.4 / n), 0.25); const bx = x + padL + gw * i + bw * (si + 0.5), by = y + padT + ph - bh; const hl = isHighlight(labels[i], v.highlight); ctx.fillStyle = hl ? t.secondary : colors[si % colors.length]; rr(ctx, bx, by, bw, bh, 6); ctx.fill(); if (hl && bh > 4) { ctx.save(); ctx.strokeStyle = t.secondary; ctx.lineWidth = 4; rr(ctx, bx - 6, by - 6, bw + 12, bh + 12, 9); ctx.stroke(); ctx.restore(); } if (bh > 4 && gp > 0.95) { ctx.fillStyle = hl ? t.secondary : t.text; ctx.font = `${hl ? 800 : 600} ${hl ? 24 : 20}px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(fmt(val), bx + bw / 2, by - (hl ? 32 : 26)); } })); }
  if (v.unit) { ctx.fillStyle = t.muted; ctx.font = `500 20px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(v.unit, x + padL, y + 2); }
}
function isHighlight(label, h) { if (!h) return false; const a = String(label).trim().toLowerCase(), b = String(h).trim().toLowerCase(); return !!a && !!b && (a === b || a.includes(b) || b.includes(a)); }
const fmt = v => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1));

/** Load character art (optional accent) and scene illustrations (data URLs) into Image objects. */
export async function loadSceneAssets({ characters = true, images = {} } = {}) {
  const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  const out = { characters: [], images: {} };
  if (characters) for (const n of [1, 2, 3]) { try { out.characters.push(await load(`assets/characters/character-${n}.png`)); } catch { /* optional */ } }
  for (const [id, src] of Object.entries(images)) { try { out.images[id] = await load(src); } catch { /* skip */ } }
  return out;
}
