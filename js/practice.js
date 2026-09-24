// practice.js — interactive practice scenes for animated lessons (EduCast's trusted templates).
// The Lesson Director only fills PARAMETERS of one of five hand-written templates; normalizePractice() validates
// them exactly like EduCast's registry (invalid → the template's defaults, atomically, with a warning), the video
// shows a "Your turn" card drawn by drawPracticeCard(), and the lesson player mounts the real interactive runtime
// (js/vendor/interactive-runtime.js). auditPracticeDom() is the deterministic overflow guard for that runtime.

export const PRACTICE_TEMPLATES = {
  multiple_choice: {
    id: 'multiple_choice', title: 'Multiple Choice Check',
    description: 'Single-select quiz with lettered choices, immediate feedback, an explanation after the correct answer and a Continue button.',
    parameters_schema: { question: 'string', choices: 'string[] (2-6 distinct options)', correct_index: 'integer 0-based', explanation: 'string shown after the correct answer', hint: 'string shown on request' },
    defaults: { question: 'What is the key idea?', choices: ['Option A', 'Option B', 'Option C', 'Option D'], correct_index: 0, explanation: 'Review the previous segment.', hint: '' },
    success_hint: 'student selects correct_index, then presses Continue',
  },
  fill_blank: {
    id: 'fill_blank', title: 'Fill in the Blank',
    description: 'Student types short answers. Write ___ in the prompt where each blank goes (one ___ per blank) or leave the prompt as a question. Answers are case-insensitive; separate accepted alternatives with |.',
    parameters_schema: { prompt: 'string, optionally containing ___ placeholders', blanks: '[{label: string, answer: string with | separated alternatives}] (1-6)', hint: 'string shown on request' },
    defaults: { prompt: 'Torque equals ___ times ___.', blanks: [{ label: 'quantity 1', answer: 'force|weight' }, { label: 'quantity 2', answer: 'distance|perpendicular distance|lever arm' }], hint: 'Think about what makes a lever turn.' },
    success_hint: 'every blank matches one of its accepted answers (case-insensitive)',
  },
  drag_sort: {
    id: 'drag_sort', title: 'Drag to Sort',
    description: 'Student drags (or nudges) items into the correct sequence and presses Check; wrong positions are highlighted.',
    parameters_schema: { prompt: 'string', items: 'string[] (2-8) in a SHUFFLED starting order', correct_order: 'string[] same multiset as items, in the correct order', hint: 'string shown on request' },
    defaults: { prompt: 'Put the steps in the correct order.', items: ['Step C', 'Step A', 'Step B'], correct_order: ['Step A', 'Step B', 'Step C'], hint: '' },
    success_hint: 'current order equals correct_order when Check is pressed',
  },
  number_line: {
    id: 'number_line', title: 'Number Line Placement',
    description: 'Student drags a marker along a labelled number line to the target value and submits; after three misses the target is revealed.',
    parameters_schema: { prompt: 'string', min: 'number', max: 'number', target: 'number inside [min, max]', tolerance: 'number, at most (max-min)/4', unit: 'string suffix shown after values (e.g. N·m)', hint: 'string shown on request' },
    defaults: { prompt: 'Place the marker at the correct value.', min: 0, max: 10, target: 5, tolerance: 0.5, unit: '', hint: '' },
    success_hint: 'abs(value - target) <= tolerance on Submit',
  },
  physics_lever: {
    id: 'physics_lever', title: 'Lever Balance Simulator',
    description: 'SVG lever with a fulcrum, two weights, live torque bars and a bubble level. The student adjusts weights (and distances) until clockwise and counter-clockwise torque match.',
    parameters_schema: { default_weight_A: 'number 1-50 (N), left weight at start', default_weight_B: 'number 1-50 (N), right weight at start', default_distance_A: 'number (m) left arm at start, <= max_distance', default_distance_B: 'number (m) right arm at start, <= max_distance', max_distance: 'number (m) slider maximum for both arms', fulcrum_offset: 'number -0.5..0.5, shifts the fulcrum along the beam (0 = centered)', target_balance: 'boolean; true = student must balance, false = free exploration with Continue', tolerance: 'number (N·m) |τ_left - τ_right| accepted as balanced', allow_distance: 'boolean; expose distance sliders (false = weights only)', instruction: 'string, student-facing task', hint: 'string shown when the student asks for a hint' },
    defaults: { default_weight_A: 8, default_weight_B: 12, default_distance_A: 0.6, default_distance_B: 0.6, max_distance: 1.0, fulcrum_offset: 0, target_balance: true, tolerance: 0.5, allow_distance: true, instruction: 'Adjust the weights or their distances until the lever balances.', hint: 'Torque = weight × distance. The heavier side needs a shorter arm.' },
    success_hint: '|weight_A × distance_A − weight_B × distance_B| ≤ tolerance (or Continue when target_balance is false)',
  },
};
export const PRACTICE_IDS = Object.keys(PRACTICE_TEMPLATES);
const BADGE = { multiple_choice: 'Check', fill_blank: 'Fill in', drag_sort: 'Sort', number_line: 'Estimate', physics_lever: 'Simulate' };

/** Template catalog for the planner prompt (mirrors EduCast's registry.catalog_for_prompt()). */
export function practiceCatalogText() {
  return PRACTICE_IDS.map(id => { const t = PRACTICE_TEMPLATES[id]; return `- ${t.id}: ${t.description}\n  parameters=${JSON.stringify(t.parameters_schema)}\n  defaults=${JSON.stringify(t.defaults)}\n  success=${t.success_hint}`; }).join('\n');
}

// ---------------------------------------------------------------- validation (port of EduCast registry.py)
const num = v => { if (typeof v === 'number') return v; if (typeof v === 'string' && v.trim()) { const n = Number(v.trim().replace(',', '.')); return Number.isFinite(n) ? n : NaN; } return NaN; };
const bool = (v, d) => (typeof v === 'boolean' ? v : typeof v === 'string' ? (/^(true|yes|1)$/i.test(v.trim()) ? true : /^(false|no|0)$/i.test(v.trim()) ? false : d) : v == null ? d : !!v);
const itemText = x => (typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.text ?? x.label ?? x.value ?? x.item ?? '') : String(x ?? ''));
const list = v => (Array.isArray(v) ? v.map(itemText) : typeof v === 'string' ? v.split(/\n|;/) : []).map(s => s.trim()).filter(Boolean);
const short = (v, what) => { const s = String(v ?? '').trim(); if (!s) throw new Error(`${what} is empty`); if (s.length > 240) throw new Error(`${what} is longer than 240 characters`); return s; };
const hint = v => String(v ?? '').trim().slice(0, 300);
const clampWarn = (v, lo, hi, what, warnings) => { if (v < lo || v > hi) { warnings.push(`${what} ${v} clamped to [${lo}, ${hi}]`); return Math.min(hi, Math.max(lo, v)); } return v; };

const VALIDATORS = {
  multiple_choice(p, w) {
    const question = short(p.question ?? p.prompt ?? p.instruction, 'question');
    const choices = list(p.choices ?? p.options).map(c => c.slice(0, 240));
    if (choices.length < 2 || choices.length > 6) throw new Error(`choices must have 2-6 items (got ${choices.length})`);
    if (new Set(choices.map(c => c.toLowerCase())).size !== choices.length) throw new Error('choices must be distinct');
    let ci = num(p.correct_index ?? p.answer_index ?? p.correct);
    if (!Number.isInteger(ci) && typeof (p.answer ?? p.correct) === 'string') { const k = choices.findIndex(c => c.toLowerCase() === String(p.answer ?? p.correct).trim().toLowerCase()); if (k >= 0) ci = k; }
    if (!Number.isInteger(ci) || ci < 0 || ci >= choices.length) throw new Error(`correct_index must refer to a choice (got ${p.correct_index})`);
    return { question, choices, correct_index: ci, explanation: String(p.explanation ?? '').trim().slice(0, 500), hint: hint(p.hint) };
  },
  fill_blank(p, w) {
    const prompt = short(p.prompt ?? p.question ?? p.instruction, 'prompt');
    const raw = Array.isArray(p.blanks) ? p.blanks : typeof p.blanks === 'string' ? p.blanks.split('\n') : [];
    const blanks = raw.map((b, i) => {
      if (typeof b === 'string') { const [a, ...rest] = b.split('|'); return rest.length ? { label: a.trim(), answer: rest.join('|').trim() } : { label: `blank ${i + 1}`, answer: a.trim() }; }
      if (b && typeof b === 'object') { const answer = Array.isArray(b.answer ?? b.answers) ? (b.answer ?? b.answers).map(String).join('|') : String(b.answer ?? b.answers ?? ''); return { label: String(b.label ?? `blank ${i + 1}`).trim() || `blank ${i + 1}`, answer: answer.trim() }; }
      return null;
    }).filter(b => b && b.answer);
    if (blanks.length < 1 || blanks.length > 6) throw new Error(`blanks must have 1-6 entries with answers (got ${blanks.length})`);
    for (const b of blanks) { if (b.label.length > 240 || b.answer.length > 240) throw new Error('blank label/answer longer than 240 characters'); }
    return { prompt, blanks, hint: hint(p.hint) };
  },
  drag_sort(p, w) {
    const prompt = short(p.prompt ?? p.question ?? p.instruction, 'prompt');
    const correct = list(p.correct_order ?? p.answer ?? p.order);
    let items = list(p.items ?? p.choices);
    if (!items.length && correct.length) { items = shuffleDet(correct); w.push('items missing; derived a shuffled order from correct_order'); }
    if (!correct.length) throw new Error('correct_order is missing');
    if (items.length < 2 || items.length > 8) throw new Error(`items must have 2-8 entries (got ${items.length})`);
    const ms = a => [...a].sort().join('\u0001');
    if (ms(items) !== ms(correct)) throw new Error('correct_order must contain the same items as items');
    if (items.every((x, i) => x === correct[i])) { items = shuffleDet(items); w.push('items were already in the correct order; shuffled the starting order'); }
    return { prompt, items, correct_order: correct, hint: hint(p.hint) };
  },
  number_line(p, w) {
    const prompt = short(p.prompt ?? p.question ?? p.instruction, 'prompt');
    const min = num(p.min), max = num(p.max), target = num(p.target ?? p.answer);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(min < max)) throw new Error(`min must be less than max (got ${p.min}, ${p.max})`);
    if (!Number.isFinite(target) || target < min || target > max) throw new Error(`target must be inside [min, max] (got ${p.target})`);
    let tolerance = num(p.tolerance); const span = max - min;
    if (!Number.isFinite(tolerance) || tolerance <= 0) { tolerance = +(span / 20).toPrecision(3); w.push(`tolerance missing or non-positive; set to ${tolerance}`); }
    if (tolerance > span / 4) { w.push(`tolerance ${tolerance} larger than a quarter of the range; clamped to ${+(span / 4).toPrecision(3)}`); tolerance = +(span / 4).toPrecision(3); }
    return { prompt, min, max, target, tolerance, unit: String(p.unit ?? '').trim().slice(0, 12), hint: hint(p.hint) };
  },
  physics_lever(p, w) {
    const d = PRACTICE_TEMPLATES.physics_lever.defaults;
    const g = (k, lo, hi, dflt, gt0 = false) => { let v = num(p[k]); if (!Number.isFinite(v)) v = dflt; if (gt0 && v <= 0) { w.push(`${k} must be positive; set to ${dflt}`); v = dflt; } return clampWarn(v, lo, hi, k, w); };
    const max_distance = g('max_distance', 0.01, 5, d.max_distance, true);
    const out = {
      default_weight_A: g('default_weight_A', 1, 50, d.default_weight_A), default_weight_B: g('default_weight_B', 1, 50, d.default_weight_B),
      default_distance_A: g('default_distance_A', 0.01, 5, d.default_distance_A, true), default_distance_B: g('default_distance_B', 0.01, 5, d.default_distance_B, true),
      max_distance, fulcrum_offset: g('fulcrum_offset', -0.5, 0.5, d.fulcrum_offset), target_balance: bool(p.target_balance, true), tolerance: g('tolerance', 0.01, 10, d.tolerance, true), allow_distance: bool(p.allow_distance, true),
      instruction: short(p.instruction ?? p.prompt ?? p.question ?? d.instruction, 'instruction'), hint: hint(p.hint ?? d.hint),
    };
    for (const k of ['default_distance_A', 'default_distance_B']) if (out[k] > out.max_distance) { w.push(`${k} ${out[k]} exceeds max_distance; clamped`); out[k] = out.max_distance; }
    if (out.target_balance) {
      const left = out.default_weight_A * out.default_distance_A, right = out.default_weight_B * out.default_distance_B;
      if (Math.abs(left - right) <= out.tolerance) { const nb = out.default_weight_B + 4 <= 50 ? out.default_weight_B + 4 : out.default_weight_B - 4; w.push(`initial state was already balanced; weight B changed ${out.default_weight_B} → ${nb}`); out.default_weight_B = nb; }
    }
    return out;
  },
};
function shuffleDet(a) { const n = a.length; if (n < 2) return a.slice(); const r = a.slice(1).concat(a[0]); if (r.every((x, i) => x === a[i])) return a.slice().reverse(); return n > 3 ? [r[n - 1], ...r.slice(0, n - 1)].map((x, i, arr) => (i % 2 ? arr[i - 1] : arr[i + 1] ?? x)) : r; }

/**
 * Validate a planner's practice scene. Returns { template, parameters, instruction, warnings }.
 * Invalid parameters restore the template's defaults atomically ("defaults restored: …") as in EduCast.
 */
export function normalizePractice(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  let template = String(raw.template || raw.kind || '').trim();
  const warnings = [];
  if (!PRACTICE_TEMPLATES[template]) { if (template) warnings.push(`unknown template "${template}"; using multiple_choice`); template = 'multiple_choice'; }
  const spec = PRACTICE_TEMPLATES[template];
  let params = raw.parameters && typeof raw.parameters === 'object' && !Array.isArray(raw.parameters) ? { ...raw.parameters } : { ...raw };
  delete params.template; delete params.warnings;
  let out;
  try { out = VALIDATORS[template](params, warnings); }
  catch (e) { warnings.push(`defaults restored: ${e.message}`); out = JSON.parse(JSON.stringify(spec.defaults)); }
  const instruction = String(raw.instruction ?? params.instruction ?? out.instruction ?? out.question ?? out.prompt ?? '').trim().slice(0, 240) || String(out.question ?? out.prompt ?? spec.title);
  return { template, parameters: out, instruction, warnings };
}

/** One student-facing line (never the answer). */
export function practiceSummary(pr) {
  const p = pr?.parameters || {}; const t = pr?.template;
  if (t === 'multiple_choice') return `${p.question || pr.instruction || ''} ${(p.choices || []).map((c, i) => `(${String.fromCharCode(65 + i)}) ${c}`).join('  ')}`.trim();
  if (t === 'fill_blank') return `${p.prompt || pr.instruction || ''}`.replace(/___/g, '____');
  if (t === 'drag_sort') return `${p.prompt || pr.instruction || ''} Items: ${(p.items || []).join(', ')}`;
  if (t === 'number_line') return `${p.prompt || pr.instruction || ''} (from ${p.min} to ${p.max}${p.unit ? ' ' + p.unit : ''})`;
  if (t === 'physics_lever') return `${p.instruction || pr.instruction || ''} Weights ${p.default_weight_A} N and ${p.default_weight_B} N.`;
  return pr?.instruction || '';
}
/** Caption text for the practice pause. */
export function practiceCaption(pr) {
  const t = PRACTICE_TEMPLATES[pr?.template]; const s = practiceSummary(pr);
  return `Your turn: ${s}${s.endsWith('.') || s.endsWith('?') ? '' : '.'} ${t ? t.title + ' — pause here and try it.' : ''}`.trim();
}

// ---------------------------------------------------------------- "Your turn" card (Canvas 2D, 1920×1080 board)
const FONT = "Calibri, Carlito, 'Segoe UI', Arial, sans-serif";
const MONO = "Consolas, Menlo, 'DejaVu Sans Mono', monospace";
const easeOut = x => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
const seg = (p, s, d) => easeOut((p - s) / d);
const rgba = (h, a = 1) => { const c = String(h).replace('#', ''); return `rgba(${parseInt(c.slice(0, 2), 16)},${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${a})`; };
function rr(ctx, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function wrapText(ctx, s, maxW) { const words = String(s ?? '').split(/\s+/).filter(Boolean); const lines = []; let cur = ''; for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines.length ? lines : ['']; }
/** Shrink-to-fit text; returns the height used. */
function fitText(ctx, s, x, y, w, h, { size = 32, min = 16, weight = 500, color = '#000', family = FONT, align = 'left', valign = 'top', lh = 1.28 } = {}) {
  if (!s) return 0; let fs = size, lines;
  for (; fs >= min; fs -= Math.max(1, fs * 0.07)) { ctx.font = `${weight} ${fs}px ${family}`; lines = wrapText(ctx, s, w); if (lines.length * fs * lh <= h && lines.every(l => ctx.measureText(l).width <= w)) break; }
  if (fs < min) { fs = min; ctx.font = `${weight} ${fs}px ${family}`; lines = wrapText(ctx, s, w).slice(0, Math.max(1, Math.floor(h / (fs * lh)))); }
  const total = lines.length * fs * lh; let cy = valign === 'middle' ? y + (h - total) / 2 : valign === 'bottom' ? y + h - total : y;
  ctx.save(); ctx.textBaseline = 'top'; ctx.textAlign = align; ctx.fillStyle = color;
  for (const l of lines) { ctx.fillText(l, align === 'center' ? x + w / 2 : align === 'right' ? x + w : x, cy); cy += fs * lh; }
  ctx.restore(); return total;
}
function pill(ctx, label, x, y, color, bg) { ctx.save(); ctx.font = `700 20px ${FONT}`; const w = ctx.measureText(label).width + 28; rr(ctx, x, y, w, 36, 18); ctx.fillStyle = bg; ctx.fill(); ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(label, x + 14, y + 19); ctx.restore(); return w; }
function rowIn(ctx, p, start, i, dur = 0.1, gap = 0.07) { const a = seg(p, start + i * gap, dur); ctx.globalAlpha *= a; ctx.translate((1 - a) * 24, 0); return a; }

/**
 * Draw the practice ("Your turn") card in the main visual box. scene.visual = {template, parameters, instruction}.
 * t = sceneTokens(theme); p = scene progress; box = {x,y,w,h} (main region of the 1920×1080 board).
 */
export function drawPracticeCard(ctx, scene, t, p, box) {
  const v = scene.visual || {}; const tpl = PRACTICE_TEMPLATES[v.template] ? v.template : 'multiple_choice'; const prm = v.parameters || PRACTICE_TEMPLATES[tpl].defaults;
  const pad = 34; const x = box.x + pad, w = box.w - pad * 2; let y = box.y + pad; const bottom = box.y + box.h - pad;
  ctx.save();
  // card
  rr(ctx, box.x, box.y, box.w, box.h, 14); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.fillStyle = rgba(t.primary, 0.04); ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = rgba(t.primary, 0.4); ctx.stroke();
  // header: badge + prompt
  const hp = seg(p, 0.02, 0.1);
  ctx.save(); ctx.globalAlpha = hp; ctx.translate(0, (1 - hp) * 10);
  let bx = x; bx += pill(ctx, 'YOUR TURN', bx, y, '#FFFFFF', t.secondary) + 10; pill(ctx, BADGE[tpl].toUpperCase(), bx, y, t.primary, rgba(t.primary, 0.12));
  y += 52;
  const prompt = tpl === 'multiple_choice' ? prm.question : tpl === 'physics_lever' ? prm.instruction : prm.prompt;
  const promptText = tpl === 'fill_blank' ? '' : (prompt || v.instruction || scene.title);
  if (promptText) y += fitText(ctx, promptText, x, y, w, Math.min(150, box.h * 0.26), { size: 40, min: 24, weight: 700, color: t.text }) + 18;
  ctx.restore();
  // footer
  const footerH = 40; const areaH = Math.max(80, bottom - footerH - y);
  ctx.save(); ctx.globalAlpha = seg(p, 0.5, 0.15); fitText(ctx, 'Pause the video and try it in the interactive player', x, bottom - footerH + 8, w, footerH - 8, { size: 22, min: 16, weight: 500, color: t.muted, valign: 'bottom' }); ctx.restore();
  // body per template
  const SK = { multiple_choice: sketchChoices, fill_blank: sketchBlanks, drag_sort: sketchSort, number_line: sketchNumberLine, physics_lever: sketchLever };
  SK[tpl](ctx, prm, t, p, x, y, w, areaH, v);
  ctx.restore();
}

function sketchChoices(ctx, prm, t, p, x, y, w, h) {
  const choices = (prm.choices || []).slice(0, 6); const n = Math.max(choices.length, 1); const gap = 12; const rowH = Math.min(96, (h - gap * (n - 1)) / n);
  choices.forEach((c, i) => {
    ctx.save(); const a = rowIn(ctx, p, 0.18, i); if (a <= 0) { ctx.restore(); return; }
    const ry = y + i * (rowH + gap); rr(ctx, x, ry, w, rowH, 12); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = rgba(t.muted, 0.4); ctx.stroke();
    const sq = Math.min(44, rowH - 20); rr(ctx, x + 18, ry + (rowH - sq) / 2, sq, sq, 8); ctx.fillStyle = rgba(t.primary, 0.12); ctx.fill();
    ctx.fillStyle = t.primary; ctx.font = `700 ${Math.round(sq * 0.5)}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String.fromCharCode(65 + i), x + 18 + sq / 2, ry + rowH / 2 + 1);
    fitText(ctx, c, x + 18 + sq + 18, ry + 8, w - sq - 60, rowH - 16, { size: 32, min: 18, weight: 600, color: t.text, valign: 'middle' });
    ctx.restore();
  });
}
function sketchBlanks(ctx, prm, t, p, x, y, w, h) {
  const prompt = String(prm.prompt || ''); const blanks = prm.blanks || []; const parts = prompt.split('___');
  const inline = parts.length - 1 === blanks.length && blanks.length > 0;
  const a = seg(p, 0.18, 0.14); ctx.save(); ctx.globalAlpha *= a; ctx.translate(0, (1 - a) * 12);
  let fs = 40; ctx.font = `600 ${fs}px ${FONT}`; const boxW = 210, boxH = 58, lh = boxH + 22;
  if (inline) {
    // flow text runs and blank boxes
    const tokens = []; parts.forEach((part, i) => { part.split(/(\s+)/).filter(s => s.length).forEach(s => tokens.push({ text: s })); if (i < blanks.length) tokens.push({ blank: blanks[i] }); });
    const layout = () => { const rows = [[]]; let cx = 0; for (const tk of tokens) { const tw = tk.blank ? boxW + 16 : ctx.measureText(tk.text).width; if (cx + tw > w && rows.at(-1).length) { rows.push([]); cx = 0; } if (/^\s+$/.test(tk.text || '') && cx === 0) continue; rows.at(-1).push({ ...tk, w: tw }); cx += tw; } return rows; };
    let rows = layout(); while (rows.length * lh > h && fs > 24) { fs -= 2; ctx.font = `600 ${fs}px ${FONT}`; rows = layout(); }
    rows.forEach((row, ri) => { let cx = x; const cy = y + ri * lh; for (const tk of row) { if (tk.blank) { rr(ctx, cx + 8, cy - 4, boxW, boxH, 8); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.primary; ctx.stroke(); ctx.fillStyle = t.muted; ctx.font = `500 ${Math.round(fs * 0.55)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(tk.blank.label || 'answer', cx + 8 + boxW / 2, cy - 4 + boxH / 2); ctx.font = `600 ${fs}px ${FONT}`; } else { ctx.fillStyle = t.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(tk.text, cx, cy + boxH / 2 - 4); } cx += tk.w; } });
  } else {
    let cy = y; cy += fitText(ctx, prompt, x, cy, w, Math.min(140, h * 0.4), { size: 38, min: 22, weight: 700, color: t.text }) + 20;
    blanks.slice(0, 6).forEach((b, i) => { ctx.save(); const ra = rowIn(ctx, p, 0.3, i); if (ra > 0) { const ry = cy + i * 72; fitText(ctx, b.label || `Answer ${i + 1}`, x, ry, w * 0.4, 56, { size: 28, min: 18, weight: 600, color: t.text, valign: 'middle' }); rr(ctx, x + w * 0.42, ry, Math.min(360, w * 0.5), 56, 8); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = t.primary; ctx.stroke(); } ctx.restore(); });
  }
  ctx.restore();
}
function sketchSort(ctx, prm, t, p, x, y, w, h) {
  const items = (prm.items || []).slice(0, 8); const n = Math.max(items.length, 1); const gap = 10; const rowH = Math.min(84, (h - gap * (n - 1)) / n);
  items.forEach((it, i) => {
    ctx.save(); const a = rowIn(ctx, p, 0.18, i, 0.1, 0.06); if (a <= 0) { ctx.restore(); return; }
    const ry = y + i * (rowH + gap); rr(ctx, x, ry, w, rowH, 12); ctx.fillStyle = '#FFFFFF'; ctx.fill(); ctx.setLineDash([]); ctx.lineWidth = 2; ctx.strokeStyle = rgba(t.muted, 0.45); ctx.stroke();
    const sq = Math.min(40, rowH - 18); rr(ctx, x + 16, ry + (rowH - sq) / 2, sq, sq, 8); ctx.fillStyle = rgba(t.primary, 0.12); ctx.fill();
    ctx.fillStyle = t.text; ctx.font = `700 ${Math.round(sq * 0.5)}px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x + 16 + sq / 2, ry + rowH / 2 + 1);
    fitText(ctx, it, x + 16 + sq + 16, ry + 6, w - sq - 140, rowH - 12, { size: 30, min: 18, weight: 600, color: t.text, valign: 'middle' });
    // grip + arrows
    ctx.fillStyle = rgba(t.muted, 0.9); ctx.font = `600 ${Math.round(rowH * 0.36)}px ${FONT}`; ctx.textAlign = 'right'; ctx.fillText('↑  ↓', x + w - 22, ry + rowH / 2 + 1);
    ctx.restore();
  });
}
function niceStep(span) { const raw = span / 10, mag = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= 12) || raw; }
function sketchNumberLine(ctx, prm, t, p, x, y, w, h) {
  const min = Number(prm.min) || 0, max = Number.isFinite(Number(prm.max)) ? Number(prm.max) : 10; const span = max - min || 1; const unit = prm.unit ? ' ' + prm.unit : '';
  const a = seg(p, 0.18, 0.14); ctx.save(); ctx.globalAlpha *= a;
  const ax = x + 40, aw = w - 80, ay = y + Math.min(h * 0.38, 130);
  ctx.strokeStyle = t.text; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(ax - 14, ay); ctx.lineTo(ax + aw + 14, ay); ctx.stroke();
  const step = niceStep(span); const digits = step < 1 ? Math.min(3, Math.ceil(-Math.log10(step))) : 0;
  ctx.font = `500 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.lineWidth = 3; ctx.strokeStyle = rgba(t.muted, 0.9); ctx.fillStyle = t.muted;
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) { const tx = ax + ((v - min) / span) * aw; ctx.beginPath(); ctx.moveTo(tx, ay - 14); ctx.lineTo(tx, ay + 14); ctx.stroke(); ctx.fillText(v.toFixed(digits), tx, ay + 22); }
  // marker in the middle, slides in with p
  const mp = seg(p, 0.3, 0.2); const mx = ax + aw * (0.5 - (1 - mp) * 0.2);
  ctx.strokeStyle = t.primary; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(mx, ay - 40); ctx.lineTo(mx, ay + 6); ctx.stroke();
  ctx.fillStyle = t.primary; ctx.beginPath(); ctx.arc(mx, ay - 52, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = t.text; ctx.font = `700 26px ${FONT}`; ctx.textBaseline = 'bottom'; ctx.fillText(`${(min + span / 2).toFixed(digits + 1)}${unit}`, mx, ay - 80);
  // controls sketch
  const cy = ay + 62; const room = y + h - cy;
  if (room >= 30) { ctx.fillStyle = t.muted; ctx.font = `500 24px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('Drag the marker, then press Submit', room >= 96 ? x : x + 170, room >= 96 ? cy : cy + 6); }
  if (room >= 96) { rr(ctx, x, cy + 40, 150, 46, 8); ctx.fillStyle = t.primary; ctx.fill(); ctx.fillStyle = '#FFFFFF'; ctx.font = `700 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Submit', x + 75, cy + 63); }
  else if (room >= 30) { rr(ctx, x, cy, 150, 40, 8); ctx.fillStyle = t.primary; ctx.fill(); ctx.fillStyle = '#FFFFFF'; ctx.font = `700 20px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Submit', x + 75, cy + 20); }
  ctx.restore();
}
function sketchLever(ctx, prm, t, p, x, y, w, h) {
  const a = seg(p, 0.18, 0.14); ctx.save(); ctx.globalAlpha *= a;
  const wA = Number(prm.default_weight_A) || 8, wB = Number(prm.default_weight_B) || 12, dA = Number(prm.default_distance_A) || 0.6, dB = Number(prm.default_distance_B) || 0.6, maxD = Number(prm.max_distance) || 1;
  const beamY = y + Math.min(h * 0.46, 170), left = x + 60, right = x + w - 60, pivot = (left + right) / 2 + (Number(prm.fulcrum_offset) || 0) * (right - left) * 0.6;
  const tilt = Math.max(-1, Math.min(1, (wB * dB - wA * dA) / Math.max(50 * maxD * 0.35, 1))) * 9 * seg(p, 0.35, 0.25);
  ctx.fillStyle = t.secondary; ctx.beginPath(); ctx.moveTo(pivot - 40, beamY + 110); ctx.lineTo(pivot, beamY + 6); ctx.lineTo(pivot + 40, beamY + 110); ctx.closePath(); ctx.fill();
  ctx.save(); ctx.translate(pivot, beamY); ctx.rotate(tilt * Math.PI / 180); ctx.translate(-pivot, -beamY);
  rr(ctx, left, beamY - 7, right - left, 14, 7); ctx.fillStyle = t.text; ctx.fill();
  const armL = pivot - left - 30, armR = right - pivot - 30; const xA = pivot - (dA / maxD) * armL, xB = pivot + (dB / maxD) * armR; const sA = 30 + Math.sqrt(wA) * 9, sB = 30 + Math.sqrt(wB) * 9;
  for (const [bx, s, wt] of [[xA, sA, wA], [xB, sB, wB]]) { rr(ctx, bx - s / 2, beamY - 7 - s, s, s, 8); ctx.fillStyle = t.primary; ctx.fill(); ctx.fillStyle = '#FFFFFF'; ctx.font = `700 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`${wt} N`, bx, beamY - 7 - s / 2); }
  ctx.fillStyle = t.muted; ctx.font = `500 20px ${FONT}`; ctx.textBaseline = 'top'; ctx.fillText(`${dA.toFixed(2)} m`, (xA + pivot) / 2, beamY + 22); ctx.fillText(`${dB.toFixed(2)} m`, (xB + pivot) / 2, beamY + 22);
  ctx.restore();
  // slider sketch row
  const sy = beamY + 128; if (sy + 48 > y + h) { ctx.restore(); return; } const labels = ['Weight A', 'Arm A', 'Weight B', 'Arm B'].filter((_, i) => prm.allow_distance !== false || i % 2 === 0); const colW = (w - 20 * (labels.length - 1)) / labels.length;
  labels.forEach((l, i) => { const cx = x + i * (colW + 20); ctx.fillStyle = t.muted; ctx.font = `700 16px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(l.toUpperCase(), cx, sy); rr(ctx, cx, sy + 30, colW, 8, 4); ctx.fillStyle = rgba(t.muted, 0.3); ctx.fill(); ctx.fillStyle = t.primary; ctx.beginPath(); ctx.arc(cx + colW * (0.3 + 0.15 * i), sy + 34, 12, 0, Math.PI * 2); ctx.fill(); });
  ctx.restore();
}

// ---------------------------------------------------------------- deterministic guard for the interactive runtime
let runtimeLoading = null;
function loadRuntime(url) {
  if (typeof window !== 'undefined' && window.EduHarnessInteractive) return Promise.resolve();
  runtimeLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = () => res(); s.onerror = () => { runtimeLoading = null; rej(new Error(`Could not load ${url}`)); }; document.head.appendChild(s); });
  return runtimeLoading;
}
/**
 * Mount a practice config in a hidden 1920×1080 panel with the trusted runtime and audit the DOM
 * (EduCast's screenshot_html guard): elements outside the panel, an empty root, or a runtime error.
 * Returns findings [{kind:'dom_overflow'|'runtime_error'|'empty', severity, message}].
 */
export async function auditPracticeDom(config, { runtimeUrl } = {}) {
  const findings = [];
  if (typeof document === 'undefined') return findings;
  try { await loadRuntime(runtimeUrl || new URL('./vendor/interactive-runtime.js', import.meta.url).href); }
  catch (e) { return [{ kind: 'runtime_error', severity: 'blocker', message: `interactive runtime unavailable: ${e.message}` }]; }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1920px;height:1080px;padding:40px;box-sizing:border-box;overflow:hidden;visibility:hidden;container-type:size;container-name:stage;font-size:16px;';
  document.body.appendChild(host);
  const errors = []; const onErr = e => errors.push(String(e.message || e.reason?.message || e.reason || e));
  window.addEventListener('error', onErr); window.addEventListener('unhandledrejection', onErr);
  let cleanup = null;
  try {
    cleanup = window.EduHarnessInteractive.mountInteractive(host, { template: config.template, parameters: config.parameters || {}, instruction: config.instruction || '' }, { onSuccess() {}, onEvent() {} });
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));
    const hr = host.getBoundingClientRect();
    if (!host.children.length || !host.querySelector('.eh')?.children.length) findings.push({ kind: 'empty', severity: 'blocker', message: 'interactive root rendered no elements' });
    let n = 0;
    for (const elm of host.querySelectorAll('*')) {
      const r = elm.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      if (r.right > hr.right + 1 || r.bottom > hr.bottom + 1 || r.left < hr.left - 1 || r.top < hr.top - 1) {
        findings.push({ kind: 'dom_overflow', severity: 'major', message: `element outside the panel: ${elm.tagName.toLowerCase()}${elm.className ? '.' + String(elm.className).split(' ')[0] : ''} [${Math.round(r.left - hr.left)},${Math.round(r.top - hr.top)} ${Math.round(r.width)}x${Math.round(r.height)}]` });
        if (++n >= 6) break;
      }
    }
    if (host.scrollHeight > host.clientHeight + 1) findings.push({ kind: 'dom_overflow', severity: 'major', message: `content taller than the panel (${host.scrollHeight}px of ${host.clientHeight}px)` });
  } catch (e) { findings.push({ kind: 'runtime_error', severity: 'blocker', message: `runtime JS error: ${String(e.message || e).slice(0, 200)}` }); }
  finally {
    window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onErr);
    try { cleanup?.(); } catch { /* ignore */ }
    host.remove();
  }
  for (const m of errors) findings.push({ kind: 'runtime_error', severity: 'blocker', message: `runtime JS error: ${m.slice(0, 200)}` });
  return findings;
}
