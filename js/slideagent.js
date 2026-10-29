// slideagent.js — targeted slide revision with the built-in harness. The model never writes code: it reads the
// chosen slides as a shape list and answers with a fixed set of edit operations, which one fixed Document Builder
// macro applies inside the editor (one undo step). Claude Code / Codex go through the local bridge instead.
import { extractJson } from './llm.js';

/** "2, 5-7" → [1, 4, 5, 6] (0-based, unique, within the deck). */
export function parseSlideRange(text, count) {
  const out = new Set();
  for (const part of String(text || '').split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/); if (!m) throw new Error(`“${part}” is not a slide number or range`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { if (i < 1 || i > count) throw new Error(`The deck has ${count} slides`); out.add(i - 1); }
  }
  if (!out.size) throw new Error('Choose at least one slide');
  return [...out].sort((x, y) => x - y);
}

// Shared by both macros: the text of a shape, paragraph by paragraph.
const HELPERS = `
const paras = sh => { const c = sh.GetDocContent && sh.GetDocContent(); if (!c) return null; const out = []; for (let i = 0; i < c.GetElementsCount(); i++) { const e = c.GetElement(i); out.push(e && e.GetText ? e.GetText().replace(/[\\r\\n]+$/, '') : ''); } return out; };
const phType = sh => { try { const p = sh.GetPlaceholder && sh.GetPlaceholder(); return p ? p.GetType() : null; } catch (e) { return null; } };
const box = sh => { const d = sh.Drawing || {}; const r = v => Math.round(v || 0); return [r(d.x), r(d.y), r(d.extX), r(d.extY)]; };
const notesShape = s => { try { const n = s.GetNotesPage && s.GetNotesPage(); return n ? n.GetBodyShape() : null; } catch (e) { return null; } };
`;

/** Read-only: the current slide index, slide count, and the shapes of the requested slides (null → current). */
export const READ_MACRO = HELPERS + `
const pr = Api.GetPresentation(); const count = pr.GetSlidesCount();
const current = pr.GetCurSlideIndex ? pr.GetCurSlideIndex() : 0;
const want = args && args.slides ? args.slides : [current];
const slides = want.filter(i => i >= 0 && i < count).map(i => {
  const s = pr.GetSlideByIndex(i);
  const shapes = s.GetAllShapes().map((sh, id) => ({ id, placeholder: phType(sh), box: box(sh), paragraphs: paras(sh) })).filter(x => x.paragraphs && x.paragraphs.some(t => t.trim()) || x.placeholder);
  const n = notesShape(s); const np = n ? paras(n) : null;
  return { slide: i + 1, shapes, notes: np ? np.join('\\n').trim() : '' };
});
const titles = []; for (let i = 0; i < count; i++) { const s = pr.GetSlideByIndex(i); const t = s.GetAllShapes().find(sh => ['title', 'ctrTitle'].includes(phType(sh))) || s.GetAllShapes().find(sh => { const p = paras(sh); return p && p.some(x => x.trim()); }); const p = t ? paras(t) : null; titles.push(p ? p.join(' ').trim() : ''); }
return { count, current, slides, titles };
`;

/** Apply operations (see OPS in the prompt). Slides are addressed by their number before any change. */
export const APPLY_MACRO = HELPERS + `
const pr = Api.GetPresentation(); const S = []; for (let i = 0; i < pr.GetSlidesCount(); i++) S.push(pr.GetSlideByIndex(i));
const slideOf = n => { const s = S[n - 1]; if (!s) throw new Error('No slide ' + n); return s; };
const shapeOf = (n, id) => { const sh = slideOf(n).GetAllShapes()[id]; if (!sh || !sh.GetDocContent || !sh.GetDocContent()) throw new Error('Slide ' + n + ' has no text shape ' + id); return sh; };
// Keep the paragraph (bullet, level, alignment) and the first run's formatting.
const setPara = (p, text) => {
  let pr = null; for (let i = 0; i < p.GetElementsCount(); i++) { const e = p.GetElement(i); if (e && e.GetClassType && e.GetClassType() === 'run') { try { pr = e.GetTextPr(); } catch (err) { pr = null; } break; } }
  p.RemoveAllElements(); const run = p.AddText(text);
  if (pr && run && run.SetTextPr) try { run.SetTextPr(pr); } catch (err) { /* keep the paragraph's default formatting */ }
};
const setLines = (sh, lines) => {
  const c = sh.GetDocContent(); lines = lines.length ? lines : [''];
  for (let i = 0; i < lines.length; i++) {
    if (i < c.GetElementsCount()) setPara(c.GetElement(i), lines[i]);
    else { const p = c.GetElement(c.GetElementsCount() - 1).Copy(); setPara(p, lines[i]); c.Push(p); }
  }
  for (let i = c.GetElementsCount() - 1; i >= lines.length; i--) c.RemoveElement(i);
};
// Builder wrappers are new objects on every call; compare the drawings they wrap.
const same = (a, b) => !!a && !!b && (a.Drawing || a) === (b.Drawing || b);
const hasText = sh => { const p = paras(sh); return !!p && p.some(x => x.trim()); };
// Title: the title placeholder, else the topmost text box (Studio-drawn decks use plain text boxes).
const titleOf = s => s.GetAllShapes().find(sh => ['title', 'ctrTitle'].includes(phType(sh))) || s.GetAllShapes().filter(hasText).sort((a, b) => box(a)[1] - box(b)[1])[0];
const bodyOf = (s, title) => s.GetAllShapes().filter(sh => !same(sh, title) && hasText(sh)).sort((a, b) => { const [, , aw, ah] = box(a), [, , bw, bh] = box(b); return bw * bh - aw * ah; })[0];
const done = []; const doomedShapes = []; const doomedSlides = [];
for (const op of args.ops) {
  if (op.op === 'set_text') { setLines(shapeOf(op.slide, op.shape), [].concat(op.paragraphs)); done.push(op); }
  else if (op.op === 'set_notes') { const n = notesShape(slideOf(op.slide)); if (!n) throw new Error('Slide ' + op.slide + ' has no notes'); setLines(n, String(op.text || '').split('\\n')); done.push(op); }
  else if (op.op === 'delete_shape') { doomedShapes.push(slideOf(op.slide).GetAllShapes()[op.shape]); done.push(op); }
  else if (op.op === 'add_slide') {
    const like = slideOf(op.like || op.after); const at = slideOf(op.after).GetSlideIndex() + 1;
    const s = like.Duplicate(at); const t = titleOf(s); const b = bodyOf(s, t);
    if (t && op.title !== undefined) setLines(t, [String(op.title)]);
    if (b && op.paragraphs) setLines(b, [].concat(op.paragraphs));
    // Other text on the copied slide (callouts, captions) belonged to the source slide.
    for (const sh of s.GetAllShapes()) if (!same(sh, t) && !same(sh, b) && paras(sh) && paras(sh).some(x => x.trim()) && !['dt', 'ftr', 'sldNum', 'hdr'].includes(phType(sh))) sh.Delete();
    const n = notesShape(s); if (n) setLines(n, String(op.notes || '').split('\\n'));
    done.push(op);
  }
  else if (op.op === 'move_slide') { slideOf(op.slide).MoveTo(Math.max(0, Math.min(pr.GetSlidesCount() - 1, op.to - 1))); done.push(op); }
  else if (op.op === 'delete_slide') { doomedSlides.push(slideOf(op.slide)); done.push(op); }
  else throw new Error('Unknown operation ' + op.op);
}
for (const sh of doomedShapes) if (sh) sh.Delete();
for (const s of doomedSlides) s.Delete();
return { applied: done.length, count: pr.GetSlidesCount() };
`;

const OPS_DOC = `Operations (slides are numbered as in the input, before any change; shapes by their "id"):
- {"op":"set_text","slide":N,"shape":ID,"paragraphs":["line", ...]}  replace a shape's text; one string per paragraph (bullet). Formatting of the first paragraph is kept.
- {"op":"set_notes","slide":N,"text":"speaker notes"}
- {"op":"delete_shape","slide":N,"shape":ID}
- {"op":"add_slide","after":N,"like":M,"title":"...","paragraphs":["..."],"notes":"..."}  new slide after slide N, copying the design of slide M (default N)
- {"op":"move_slide","slide":N,"to":K}
- {"op":"delete_slide","slide":N}`;

export function revisionMessages({ course, chapter, deck, instruction }) {
  const system = `You revise slides of a lecture deck inside a presentation editor. You cannot change layout, colors or images; you change text and slide structure only, by returning operations.
${OPS_DOC}
Rules: edit only the slides marked as targets unless the instruction asks for new, moved or deleted slides. Keep bullets short (at most ~12 words), keep the shape's role (titles stay one line). Text must fit roughly the shape's box (box = [x, y, width, height] in mm). Do not invent facts beyond the course material and the instruction.
Answer with JSON only: {"summary":"one sentence","ops":[...]}`;
  const user = `Course: ${course}\nChapter: ${chapter}\nAll slide titles: ${deck.titles.map((t, i) => `${i + 1}. ${t}`).join(' | ')}\n\nTarget slides:\n${JSON.stringify(deck.slides, null, 1)}\n\nInstruction: ${instruction}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Validate the model's answer against the slides it was shown. Throws with a readable reason. */
export function parseRevision(text, deck, targets) {
  const j = extractJson(text, 'object'); const ops = Array.isArray(j?.ops) ? j.ops : null;
  if (!ops) throw new Error('The model did not return any operations');
  const allowed = new Set(targets.map(i => i + 1)); const shapes = new Map(deck.slides.map(s => [s.slide, new Set(s.shapes.map(x => x.id))]));
  const inDeck = n => Number.isInteger(n) && n >= 1 && n <= deck.count;
  for (const op of ops) {
    const bad = m => { throw new Error(`Rejected ${op.op || 'operation'}: ${m}`); };
    if (['set_text', 'set_notes', 'delete_shape', 'delete_slide'].includes(op.op) && !allowed.has(op.slide)) bad(`slide ${op.slide} was not selected`);
    if (['set_text', 'delete_shape'].includes(op.op) && !shapes.get(op.slide)?.has(op.shape)) bad(`slide ${op.slide} has no shape ${op.shape}`);
    if (op.op === 'set_text') op.paragraphs = [].concat(op.paragraphs ?? []).map(String);
    else if (op.op === 'add_slide') { if (!inDeck(op.after) || (op.like !== undefined && !inDeck(op.like))) bad('slide number out of range'); if (op.paragraphs) op.paragraphs = [].concat(op.paragraphs).map(String); }
    else if (op.op === 'move_slide') { if (!allowed.has(op.slide) || !inDeck(op.to)) bad('slide number out of range'); }
    else if (!['set_notes', 'delete_shape', 'delete_slide'].includes(op.op)) bad('unknown operation');
  }
  if (ops.filter(o => o.op === 'delete_slide').length >= deck.count) throw new Error('Rejected: the revision would delete every slide');
  return { summary: String(j.summary || '').trim(), ops };
}

/** One-line descriptions of the operations, for the panel. */
export function describeOps(ops) {
  const d = { set_text: o => `Slide ${o.slide}: rewrote text`, set_notes: o => `Slide ${o.slide}: rewrote notes`, delete_shape: o => `Slide ${o.slide}: removed a text box`, add_slide: o => `New slide after ${o.after}${o.title ? `: ${o.title}` : ''}`, move_slide: o => `Moved slide ${o.slide} to ${o.to}`, delete_slide: o => `Deleted slide ${o.slide}` };
  return ops.map(o => d[o.op](o));
}

// ---------------------------------------------------------------- Claude Code / Codex via studio-bridge
export const AGENT_NAMES = { builtin: 'Built-in', claude: 'Claude Code', codex: 'Codex' };
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function bridgeFetch(s, route, init = {}) {
  const base = String(s.bridgeUrl || '').replace(/\/+$/, '');
  if (!s.bridgeToken) throw new Error('Add the bridge token under Account → Slides editor');
  let r;
  try { r = await fetch(`${base}${route}`, { ...init, headers: { Authorization: `Bearer ${s.bridgeToken}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new Error(`The agent bridge at ${base} is not reachable`); }
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `Bridge error ${r.status}`);
  return r;
}

/** { ok, busy, agents: { claude, codex } } */
export async function bridgeHealth(s) { return (await bridgeFetch(s, '/health', { signal: AbortSignal.timeout(5000) })).json(); }
export async function bridgeCancel(s) { try { await bridgeFetch(s, '/cancel', { method: 'POST' }); } catch { /* already gone */ } }

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Run one revision on the bridge; onProgress(text) gets the agent's steps. Resolves to { summary, file }. */
export async function bridgeRevise(s, { agent, slides, instruction, chapter, blob }, { onProgress, signal } = {}) {
  const r = await bridgeFetch(s, '/revise', { method: 'POST', signal, body: JSON.stringify({ agent, slides, instruction, chapter, pptx: await toBase64(blob) }) });
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (ev.type === 'progress') onProgress?.(ev.text);
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'done') { const bin = atob(ev.pptx); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k); return { summary: ev.summary, file: new File([bytes], 'slides.pptx', { type: PPTX_TYPE }) }; }
    }
  }
  throw new Error('The bridge closed the connection before the agent finished');
}
