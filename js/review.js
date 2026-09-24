// review.js — independent VLM reviewer for animated-lesson scenes (port of EduCast's stage2/reviewer.py).
// One structured vision call per scene, grounded twice: (1) the scene's key_elements must be visible,
// (2) deterministic guard findings (layout guard text overflow, blank frames, interactive DOM overflow)
// are passed in as evidence and, when they are blockers, fail the scene even if the model is lenient.
// The verdict carries structured repair ops that applyOps() patches onto the scene JSON.
import { extractJson } from './llm.js';

export const REVIEW_SYSTEM = `You are an independent visual QA auditor for teaching media. You did not write
the code that produced these frames; judge only what a student would see.

Grade the scene against (a) the VISUAL BRIEF, (b) the KEY ELEMENTS list and (c) the board contract.
Be strict about readability and about whether the scene actually shows what it was supposed to teach.

THE TEACHING BOARD (every scene except the opener and practice scenes): a title band across the top;
a lecture column on the left (about 28% of the width) whose short lines light up one by one as they are
spoken; a large main visual card on the right drawn from the scene's "visual" object (bullets, a formula
card with explaining bullets, a two-column compare, numbered steps, a stat row, a node/edge diagram, a
chart, an illustration, or a recap); a takeaway strip under the visual card that appears near the end of the
scene; a small cartoon character accent in the lower-right corner; a thin progress bar along the bottom.
Scene types (beats): title_card, bullets, formula, compare, steps, stat_row, diagram, chart, illustration,
recap, practice.
- title_card is the lesson opener on its own stage: deliberately NO board chrome — expect the title, one short
  subtitle/label and characters in the bottom corners. Do not ask it for lecture lines, bullets or a takeaway.
- practice scenes show a "Your turn" card: a badge, the prompt or question and a sketch of the controls
  (lettered choices, blanks, sortable chips, a number line or a lever) BEFORE the student acts. Judge whether
  a student can read the prompt and the choices; never expect feedback, explanations or the answer.
- The character accent is decoration: never list it as missing, never count it as a collision unless it
  covers text.
- Frames are sampled at different times; an element that is planned to appear late may be absent from an
  early frame. Judge presence on the LAST frame(s); judge motion by comparing frames.

BLOCKING issues (the scene fails):
- Text cut off at the edge of its card or the frame, or two texts overlapping so either is hard to read
- A label crossing or covering a curve, axis, arrow or another label
- Old/duplicate labels left visible after a state changes, or labels that collide during motion
- Foreground/background contrast too low to read
- Blank, corrupted, unrelated or placeholder content in the main visual card
- A KEY ELEMENT that is not visible at all (list it in missing_key_elements)
- A formula/number that is wrong or contradicts the brief
- Practice card whose prompt or choices cannot be read

MINOR issues (nits; never fail a scene for these alone):
- Palette/font drift, slightly cramped spacing, small alignment differences
- An element that IS visible but in a different position/size/style than the brief asked for, as long as it
  stays readable and its association with its object is clear. Position alone is never a reason to mark a key
  element missing. Do not classify actual collisions or unreadable text as minor.

Every blocking_issue must be a concrete observation about these frames ("the third bullet is cut off at the
bottom of the card"), never a restatement of this rubric. For animation defects give the frame time and the
exact visible text. Do not infer an unseen collision from the plan alone.

Scores: score = overall readability + polish (0-10); brief_adherence = how much of the brief's intent is
actually on screen (0-10). A scene with any blocking issue must score <= 5.

When the scene fails, propose the smallest repair:
- fix_action: "patch_artifact" when you can name exact fields to change (shorter text, fewer bullets, a
  corrected formula); "re_render" when the scene must be re-planned; "change_tool" only when this beat cannot
  show the brief (then say which beat would); "adjust_timing" for pacing only; "noop" when it passes.
- ops: at most 5 minimal edits against the PRIOR ARTIFACT. Each op: {"target", "op": "set"|"replace",
  "before" (exact unique substring of the current value, for replace), "after"/"value", "rationale"}.
  Allowed targets: title | takeaway | lecture_lines[i] | animations[i] | visual.<string field> |
  visual.<list field> | visual.<list field>[i] | visual.parameters.<key>. Never target beat, id or
  visual.template. Prefer shortening or splitting text over deleting content.
- fallback_instructions: concrete prose for the planner if the ops are not enough.

Also return layout_issues (spatial: overlap, occlusion, off-card, cut off) and temporal_issues (defects during
a transition or left in a later state), each stating the observed defect before its correction. Repeat
material collisions, unreadable text and stale labels in blocking_issues.

Return ONLY a JSON object with exactly these keys:
{"score": 0-10, "brief_adherence": 0-10, "present_key_elements": [], "missing_key_elements": [],
 "blocking_issues": [], "minor_issues": [], "layout_issues": [], "temporal_issues": [],
 "fix_action": "patch_artifact|re_render|change_tool|adjust_timing|noop", "ops": [], "fallback_instructions": ""}
List every KEY ELEMENT in exactly one of present_key_elements / missing_key_elements using its original wording.`;

const FIX_ACTIONS = new Set(['patch_artifact', 're_render', 'change_tool', 'adjust_timing', 'noop']);
const LAYOUT_BLOCKERS = new Set(['text_overflow', 'text_overlap', 'text_occluded', 'dom_overflow', 'blank_frame']);
const RUBRIC_PHRASES = ['list it in missing_key_elements', 'a key element that is not visible', 'blocking issues (the scene fails)'];

/** Progress points to render for review. */
export function samplePoints(scene) {
  if (scene?.beat === 'title_card') return [{ p: 0.6, label: 'uniform' }, { p: 0.985, label: 'final' }];
  const pts = [];
  // Elements build during the first half of a scene; sample after the main reveal, mid-way and at the final state
  // (a 'transition' frame is added for key scenes so the reviewer can catch stale or colliding labels while things move).
  if (scene?.key_scene) pts.push({ p: 0.22, label: 'transition' });
  pts.push({ p: 0.5, label: 'uniform' }, { p: 0.8, label: 'uniform' }, { p: 0.985, label: 'final' });
  return pts;
}

const artifactOf = scene => ({ title: scene.title, beat: scene.beat, lecture_lines: scene.lecture_lines || [], animations: scene.animations || [], takeaway: scene.takeaway || '', visual: scene.visual || {} });

/** The user prompt for one scene. frames: [{seconds, label}], guard: [{kind, severity, message, at_seconds?}]. */
export function reviewPrompt({ scene, frames = [], guard = [], course, chapter, narrationSeconds }) {
  const elements = (scene.key_elements || []).map(e => `  - ${e}`).join('\n') || '  (none listed — judge the brief)';
  const anim = (scene.animations || []).map((a, i) => `  ${i + 1}. ${a}`).join('\n');
  const frameLines = frames.map((f, i) => `Frame ${i + 1}: t=${Number(f.seconds || 0).toFixed(1)}s${f.label === 'final' ? ' (final state)' : f.label === 'transition' ? ' (early transition)' : f.label === 'screenshot' ? ' (interactive screenshot)' : ''}`).join('\n');
  const measured = guard.filter(g => g && g.message).map(g => `  - [${g.severity || 'major'}] ${g.kind}${g.at_seconds != null ? ` @ ${Number(g.at_seconds).toFixed(1)}s` : ''}: ${g.message}`);
  const opener = scene.beat === 'title_card', practice = scene.beat === 'practice';
  const contract = opener
    ? 'Lesson opener on its own stage — deliberately NOT the teaching board: expect the lesson title, one short subtitle and a small label in the middle of the frame, characters leaning in from the bottom corners. Judge readability, spelling and whether the title names this lesson.'
    : practice
      ? 'Practice ("Your turn") card in the main visual region of the board: badge, prompt/question and a sketch of the controls before the student answers; the lecture column explains the task without revealing the answer. Judge legibility of the prompt and controls only.'
      : `Teaching board: fixed title "${scene.title}"; lecture column with the lines ${JSON.stringify(scene.lecture_lines || [])}; main visual card for beat "${scene.beat}"; takeaway strip "${scene.takeaway || ''}" appears in the last third; character accent lower-right; progress bar bottom.`;
  let prompt = `SCENE ID: ${scene.id}
SCENE TYPE (beat): ${scene.beat}
SCENE TITLE: ${scene.title}
COURSE / CHAPTER: ${course || ''} / ${chapter || ''}
NARRATION (what the teacher says over this scene): ${scene.narration || '(none)'}
VISUAL BRIEF (the "visual" object the renderer draws, plus planned animations):
${JSON.stringify({ visual: scene.visual || {}, animations: scene.animations || [] }, null, 1)}
KEY ELEMENTS (each must be visible):
${elements}${narrationSeconds ? `\nVISUAL DURATION: ${Number(narrationSeconds).toFixed(1)}s (narration-driven)` : ''}${anim ? `\nPLANNED ANIMATION STEPS (each should be visible as a change between frames; count the ones you can actually see in brief_adherence):\n${anim}` : ''}

UNIFIED LAYOUT CONTRACT:
${contract}

FRAMES ATTACHED (${frames.length}):
${frameLines}
`;
  if (measured.length) prompt += `\nDETERMINISTIC LAYOUT GUARD FINDINGS (measured on the rendered frames, not guessed):\n${measured.join('\n')}\n`;
  prompt += `\nPRIOR ARTIFACT (the scene JSON; quote exact substrings of it in "before" for replace ops):\n${JSON.stringify(artifactOf(scene))}\n`;
  prompt += '\nReturn the structured verdict as JSON. List every KEY ELEMENT in exactly one of present_key_elements / missing_key_elements using its original wording. For any spatial or transition defect also include a concise actionable entry in layout_issues or temporal_issues.';
  return prompt;
}

/**
 * Review one scene with a vision-capable chat model. frames: [{dataUrl, seconds, label}].
 * Returns the finalized verdict plus {usage, raw, model, prompt}.
 */
export async function reviewScene(client, { scene, frames, guard = [], model, course, chapter, narrationSeconds, passScore = 7, detail = 'low' }) {
  if (!frames?.length) return { ...errorVerdict(scene, 'No preview frames available'), usage: null, raw: '', model };
  const prompt = reviewPrompt({ scene, frames, guard, course, chapter, narrationSeconds });
  const messages = [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: [{ type: 'text', text: prompt }, ...frames.map(f => ({ type: 'image_url', image_url: { url: f.dataUrl, detail } }))] }];
  let lastErr = null, usage = null, raw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.chat(messages, { json: true, model });
      usage = res.usage; raw = res.text;
      const out = extractJson(res.text, 'object');
      return { ...finalizeVerdict(out, scene, guard, passScore), usage, raw, model: res.model || model, prompt };
    } catch (e) { lastErr = e; }
  }
  return { ...errorVerdict(scene, `Reviewer unavailable or invalid: ${lastErr?.message || lastErr}`), usage, raw, model, prompt };
}

function errorVerdict(scene, message) {
  return { scene_id: scene?.id || '', passed: false, score: 0, brief_adherence: 0, severity: 'blocker', present_key_elements: [], missing_key_elements: [], blocking_issues: [message], minor_issues: [], layout_issues: [], temporal_issues: [], fix_action: 're_render', ops: [], fallback_instructions: '', review_error: true, summary: `REVIEW ERROR · ${message}` };
}

const strs = v => (Array.isArray(v) ? v : v == null ? [] : [v]).map(x => (typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.text ?? x.issue ?? x.message ?? JSON.stringify(x)) : String(x))).map(s => s.trim()).filter(Boolean);
const num01 = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : d; };
const rubricEcho = s => { const l = s.toLowerCase(); return RUBRIC_PHRASES.some(p => l.includes(p)); };
const guardLine = g => `[layout guard] ${g.message}${g.at_seconds != null ? ` at ${Number(g.at_seconds).toFixed(1)}s` : ''}`;
function sameIssue(a, b) { const x = a.toLowerCase().replace('[layout guard] ', ''), y = b.toLowerCase().replace('[layout guard] ', ''); return x === y || x.includes(y) || y.includes(x); }

/** Recognize concrete defects misplaced in a non-blocking field (port of _observed_visual_defect). */
export function observedVisualDefect(issue) {
  const clauses = String(issue).toLowerCase().split(/[;\n]|\.(?:\s|$)|\bbut\b/);
  for (const clause of clauses) {
    if (/\b(?:avoid|prevent|potential|risk|could|might|may)\b/.test(clause)) continue;
    if (/^\s*(?:move|place|reposition|keep|reserve|increase|decrease|consider)\b/.test(clause)) continue;
    const re = /(?<![\w-])(?:overlap(?:s|ping|ped)?|collid(?:e[sd]?|ing)|occlud(?:e[sd]?|ing)|obscur(?:e[sd]?|ing)|covered by|cut off|off[- ]screen|outside the (?:frame|viewport|card)|unreadable|illegible|duplicate objects?)(?![\w-])/g;
    let m;
    while ((m = re.exec(clause))) { const prefix = clause.slice(0, m.index); if (!/\b(?:no|not|never|without)\b(?:\s+[\w'-]+){0,3}\s*$/.test(prefix)) return true; }
    if (!/\b(?:label|annotation|text|formula|bullet)s?\b/.test(clause)) continue;
    if (/\b(?:stale|obsolete|duplicate)\b/.test(clause) && !/\b(?:no|not|without)\b/.test(clause)) return true;
    if (/\b(?:old|previous)\b/.test(clause) && /\b(?:remains?|persists?|lingers?|left visible|still visible)\b/.test(clause) && /\b(?:after|new state|state changes|final|replaced)\b/.test(clause)) return true;
    if (/\b(?:label|annotation|text|formula|bullet)s?\b.{0,100}\b(?:cross(?:es|ing)|intersect(?:s|ing)|cover(?:s|ing))\b/.test(clause) && /\b(?:curve|axis|axes|arrow)s?\b/.test(clause) && !/\b(?:no|not|without)\b/.test(clause)) return true;
  }
  return false;
}

/** Turn the model's raw JSON into a deterministic verdict (port of _to_repair + SceneRepair.finalize). */
export function finalizeVerdict(out, scene, guard = [], passScore = 7) {
  out = out && typeof out === 'object' ? out : {};
  const keyElements = (scene.key_elements || []).map(String);
  const known = new Map(keyElements.map(e => [e.trim().toLowerCase(), e]));
  const missing = [];
  for (const item of strs(out.missing_key_elements)) {
    const key = item.toLowerCase(); let original = known.get(key);
    if (!original) original = [...known.entries()].find(([k]) => key.includes(k) || k.includes(key))?.[1] || null;
    if (original && !missing.includes(original)) missing.push(original);
  }
  const present = strs(out.present_key_elements);
  let blocking = strs(out.blocking_issues).filter(i => !rubricEcho(i));
  let minor = strs(out.minor_issues).filter(i => !rubricEcho(i));
  const layout = strs(out.layout_issues).filter(i => !rubricEcho(i)), temporal = strs(out.temporal_issues).filter(i => !rubricEcho(i));
  for (const issue of [...minor, ...layout, ...temporal]) {
    if (observedVisualDefect(issue)) { if (!blocking.some(b => sameIssue(issue, b))) blocking.push(issue); }
    else if (!minor.includes(issue) && !blocking.includes(issue)) minor.push(issue);
  }
  minor = minor.filter(i => !blocking.some(b => sameIssue(i, b)));
  // Fail closed for elements the model left unclassified once it used the partition fields — but only when it
  // returned FEWER entries than there are key elements (it skipped some). Small models often paraphrase an
  // element or list its parts ("three explaining bullets" → the three bullet texts); with enough entries,
  // an unmatched element is treated as present rather than failing a good scene on wording.
  const rawMissing = strs(out.missing_key_elements);
  if (keyElements.length && (present.length || rawMissing.length) && present.length + rawMissing.length < keyElements.length) {
    const classified = new Set([...present, ...rawMissing].map(s => s.toLowerCase()));
    for (const element of keyElements) {
      const key = element.trim().toLowerCase(); if (classified.has(key)) continue;
      const fuzzy = [...classified].some(item => item.includes(key) || key.includes(item));
      if (!fuzzy && !missing.includes(element)) missing.push(element);
    }
  }
  // guard blockers are authoritative
  for (const g of guard || []) {
    if (!g || !g.message) continue; const line = guardLine(g);
    if (g.severity === 'blocker' || LAYOUT_BLOCKERS.has(g.kind)) { if (!blocking.some(b => sameIssue(line, b))) blocking.push(line); }
    else if (g.severity === 'major') { if (![...blocking, ...minor].some(b => sameIssue(line, b))) minor.push(line); }
  }
  for (const element of missing) { const note = `Missing key element: ${element}`; if (!blocking.includes(note)) blocking.push(note); }
  const score = num01(out.score, 0), brief = num01(out.brief_adherence, 0);
  let fix = FIX_ACTIONS.has(out.fix_action) ? out.fix_action : 're_render';
  const ops = (Array.isArray(out.ops) ? out.ops : []).filter(o => o && typeof o === 'object' && o.target).slice(0, 5).map(o => ({ target: String(o.target).trim(), op: ['replace', 'set', 'append_constraint'].includes(o.op) ? o.op : (o.before ? 'replace' : 'set'), before: o.before == null ? null : String(o.before), after: o.after == null ? null : (typeof o.after === 'string' ? o.after : JSON.stringify(o.after)), value: o.value === undefined ? null : o.value, rationale: String(o.rationale || '') }));
  const passed = !blocking.length && score >= passScore;
  let severity;
  if (passed) { severity = 'none'; fix = 'noop'; }
  else { severity = (score < 4 || missing.length) ? 'blocker' : 'major'; if (fix === 'noop') fix = ops.length ? 'patch_artifact' : 're_render'; }
  const summary = passed ? `PASS ${score}/10` : `FAIL ${score}/10${blocking.length ? ` · ${blocking.length} blocking` : ''}${missing.length ? ` · missing: ${missing.join(', ')}` : ''}${!blocking.length && score < passScore ? ` · below pass score ${passScore}` : ''}`;
  return { scene_id: scene.id || '', passed, score, brief_adherence: brief, severity, present_key_elements: present, missing_key_elements: missing, blocking_issues: blocking, minor_issues: minor, layout_issues: layout, temporal_issues: temporal, fix_action: fix, ops, fallback_instructions: String(out.fallback_instructions || '').trim(), review_error: false, summary };
}

/** Actionable feedback text for a re-plan (no scores). */
export function verdictFeedback(v) {
  const lines = (v.blocking_issues || []).map(i => `- MUST FIX: ${i}`);
  (v.minor_issues || []).slice(0, 3).forEach(i => lines.push(`- nice to have: ${i}`));
  if (v.fallback_instructions) lines.push(v.fallback_instructions);
  return lines.join('\n');
}

// ---------------------------------------------------------------- structured repair ops
const STRING_FIELDS = new Set(['title', 'takeaway']);
const LIST_FIELDS = new Set(['lecture_lines', 'animations']);
const FORBIDDEN = new Set(['beat', 'id', 'visual.template', 'template', 'visual.beat']);
const IDX = /^([a-zA-Z_][\w]*)\[(\d+)\]$/;
const toStrList = v => (Array.isArray(v) ? v : v == null ? [] : typeof v === 'string' ? v.split('\n') : [v]).map(x => (typeof x === 'string' ? x : x && typeof x === 'object' ? x : String(x))).filter(x => x !== '');

/** Apply repair ops to a scene (deep-copied). Never throws. */
export function applyOps(scene, ops) {
  const s = JSON.parse(JSON.stringify(scene || {})); s.visual = s.visual && typeof s.visual === 'object' ? s.visual : {};
  const applied = [], failed = [];
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = raw || {}; const target = String(op.target || '').trim(); const kind = op.op || (op.before ? 'replace' : 'set');
    const value = op.value !== undefined && op.value !== null ? op.value : op.after;
    try {
      if (!target) throw new Error('empty target');
      if (FORBIDDEN.has(target)) throw new Error('forbidden');
      const [container, key] = resolve(s, target);
      if (kind === 'set') setField(container, key, value);
      else if (kind === 'replace') replaceField(container, key, op.before || '', op.after ?? (typeof value === 'string' ? value : ''));
      else if (kind === 'append_constraint') { const cur = container.obj[container.key]; if (Array.isArray(cur)) cur.push(String(value ?? '')); else if (typeof cur === 'string' || cur == null) container.obj[container.key] = `${cur || ''}${cur ? ' ' : ''}${String(value ?? '')}`.trim(); else throw new Error('append on non-text'); }
      else throw new Error(`unsupported op ${kind}`);
      applied.push(`${kind}:${target}`);
    } catch (e) { failed.push(`${kind}:${target}:${e.message}`); }
  }
  return { scene: s, applied, failed };
}
/** Resolve a target to {obj, key, index?}. */
function resolve(s, target) {
  let obj = s, path = target;
  if (path.startsWith('visual.')) { obj = s.visual; path = path.slice(7); if (path.startsWith('parameters.')) { obj.parameters = obj.parameters && typeof obj.parameters === 'object' ? obj.parameters : {}; obj = obj.parameters; path = path.slice(11); if (!path || path.includes('.')) throw new Error('only one-level visual.parameters.<key> supported'); return [{ obj, key: path }, null]; } }
  else if (!STRING_FIELDS.has(path) && !LIST_FIELDS.has(path) && !IDX.test(path)) throw new Error('unsupported target');
  const m = IDX.exec(path);
  if (m) { const field = m[1], i = Number(m[2]); if (obj === s && !LIST_FIELDS.has(field)) throw new Error('unsupported target'); if (!Array.isArray(obj[field])) obj[field] = toStrList(obj[field]); return [{ obj, key: field, index: i }, null]; }
  if (path.includes('.') || path.includes('[')) throw new Error('unsupported target');
  return [{ obj, key: path }, null];
}
function setField(c, _k, value) {
  if (c.index != null) { const items = c.obj[c.key]; while (items.length <= c.index) items.push(''); items[c.index] = value == null ? '' : (typeof value === 'object' ? value : String(value)); return; }
  const cur = c.obj[c.key];
  if (Array.isArray(cur) || (c.obj !== undefined && LIST_FIELDS.has(c.key))) { c.obj[c.key] = Array.isArray(value) ? value.map(x => (typeof x === 'object' && x ? x : String(x))) : value == null ? [] : typeof value === 'string' && value.includes('\n') ? value.split('\n').filter(Boolean) : [typeof value === 'object' ? value : String(value)]; return; }
  if (typeof cur === 'number') { const n = Number(value); c.obj[c.key] = Number.isFinite(n) ? n : cur; return; }
  if (typeof cur === 'boolean') { c.obj[c.key] = typeof value === 'boolean' ? value : /^(true|yes|1)$/i.test(String(value)); return; }
  c.obj[c.key] = value == null ? '' : (typeof value === 'object' ? value : String(value));
}
function replaceField(c, _k, before, after) {
  if (c.index != null) { const items = c.obj[c.key]; if (c.index >= items.length) throw new Error('index out of range'); const cur = String(items[c.index]); if (before && cur.split(before).length - 1 !== 1) throw new Error('before-mismatch'); items[c.index] = before ? cur.replace(before, after) : after; return; }
  const cur = c.obj[c.key];
  if (Array.isArray(cur)) { const joined = cur.map(String).join('\n'); if (before && joined.split(before).length - 1 !== 1) throw new Error('before-mismatch'); c.obj[c.key] = before ? joined.replace(before, after).split('\n').filter(l => l !== '') : (after ? [after] : []); return; }
  const s = String(cur ?? '');
  if (before && s.split(before).length - 1 !== 1) throw new Error('before-mismatch');
  c.obj[c.key] = before ? s.replace(before, after) : after;
}

// ---------------------------------------------------------------- frame helpers (browser)
/** Findings for frames that are one flat colour. frames: [{canvas, seconds, label}]. */
export function blankFrameFindings(frames, { threshold = 3 } = {}) {
  const out = [];
  for (const f of frames || []) {
    const c = f.canvas; if (!c || f.label === 'transition' || (f.seconds != null && f.seconds <= 0.5)) continue;
    let ctx; try { ctx = c.getContext('2d', { willReadFrequently: true }); } catch { continue; }
    const n = 20, sx = c.width / n, sy = c.height / n; const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const sums = [0, 0, 0], vals = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const k = ((Math.floor(j * sy + sy / 2) * c.width) + Math.floor(i * sx + sx / 2)) * 4; const v = [px[k], px[k + 1], px[k + 2]]; vals.push(v); sums[0] += v[0]; sums[1] += v[1]; sums[2] += v[2]; }
    const mean = sums.map(s => s / vals.length);
    const mad = vals.reduce((a, v) => a + (Math.abs(v[0] - mean[0]) + Math.abs(v[1] - mean[1]) + Math.abs(v[2] - mean[2])) / 3, 0) / vals.length;
    if (mad < threshold) out.push({ kind: 'blank_frame', severity: 'blocker', message: `frame at ${Number(f.seconds || 0).toFixed(1)}s is a flat colour`, at_seconds: f.seconds });
  }
  return out;
}
/** Downscaled JPEG data URL of a canvas. */
export function frameDataUrl(canvas, { maxWidth = 960, quality = 0.7 } = {}) {
  const scale = Math.min(1, maxWidth / canvas.width); if (scale >= 1) return canvas.toDataURL('image/jpeg', quality);
  const c = document.createElement('canvas'); c.width = Math.round(canvas.width * scale); c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', quality);
}
