// agent/live.js — light edits of the selection in an open .pptx/.docx, applied in the live document. The model reads
// the selected slides or paragraphs and answers with a fixed set of operations; one fixed macro applies them all in
// the editor, so the change shows at once and nothing is saved until the instructor saves (or undoes it). Slides
// reuse slideagent.js (READ_MACRO / APPLY_MACRO); Word documents get the same here (replace a paragraph's text,
// insert a paragraph after one, set a heading level). Heavier work (restructuring, layout) goes to a CLI agent.
import { extractJson } from '../llm.js';
import { READ_MACRO, APPLY_MACRO, revisionMessages, parseRevision, describeOps } from '../slideagent.js';

/** Read paragraphs (0-based element positions) with two neighbours each side: { count, paras: [{ n, text, heading, style, target }] }. */
export const DOC_READ_MACRO = `
const d = Api.GetDocument(); const count = d.GetElementsCount();
const want = new Set(args.paras); const show = new Set();
for (const i of want) for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < count) show.add(k);
const styleOf = p => { try { const s = p.GetStyle && p.GetStyle(); return s && s.GetName ? s.GetName() : ''; } catch (e) { return ''; } };
const paras = [...show].sort((a, b) => a - b).map(i => {
  const e = d.GetElement(i); const isP = e && e.GetClassType && e.GetClassType() === 'paragraph';
  const style = isP ? styleOf(e) : ''; const h = /heading\\s*(\\d)/i.exec(style);
  return { n: i + 1, kind: isP ? 'paragraph' : (e && e.GetClassType ? e.GetClassType() : 'other'), text: e && e.GetText ? e.GetText().replace(/[\\r\\n]+$/, '') : '', style, heading: h ? +h[1] : 0, target: want.has(i) };
});
return { count, paras };
`;

/** Apply operations; paragraphs are addressed by their number before any change. */
export const DOC_APPLY_MACRO = `
const d = Api.GetDocument(); const E = []; for (let i = 0; i < d.GetElementsCount(); i++) E.push(d.GetElement(i));
const at = n => { const e = E[n - 1]; if (!e || !e.GetClassType || e.GetClassType() !== 'paragraph') throw new Error('No paragraph ' + n); return e; };
const setPara = (p, text) => {
  let pr = null; for (let i = 0; i < p.GetElementsCount(); i++) { const e = p.GetElement(i); if (e && e.GetClassType && e.GetClassType() === 'run') { try { pr = e.GetTextPr(); } catch (err) { pr = null; } break; } }
  p.RemoveAllElements(); const run = p.AddText(text);
  if (pr && run && run.SetTextPr) try { run.SetTextPr(pr); } catch (err) { /* the paragraph's own formatting */ }
};
const styleName = p => { try { const s = p.GetStyle && p.GetStyle(); return s && s.GetName ? s.GetName() : ''; } catch (e) { return ''; } };
const heading = (p, level) => { const st = d.GetStyle(level ? 'Heading ' + level : 'Normal'); if (!st) throw new Error('No style for heading ' + level); p.SetStyle(st); };
const ops = args.ops.map((o, i) => Object.assign({ i }, o)).sort((a, b) => (b.para - a.para) || (b.i - a.i));
for (const op of ops) {
  if (op.op === 'set_text') setPara(at(op.para), String(op.text));
  else if (op.op === 'set_heading') heading(at(op.para), op.level);
  else if (op.op === 'insert_after') {
    const ref = at(op.para); const fromHeading = /heading/i.test(styleName(ref));
    const p = !fromHeading && ref.Copy ? ref.Copy() : Api.CreateParagraph();
    setPara(p, String(op.text)); d.AddElement(op.para, p);
    if (op.heading) heading(p, op.heading); else if (fromHeading) heading(p, 0);
  } else throw new Error('Unknown operation ' + op.op);
}
return { applied: ops.length, count: d.GetElementsCount() };
`;

const DOC_OPS = `Operations (paragraphs are numbered as shown, before any change):
- {"op":"set_text","para":N,"text":"new text"}  replace a paragraph's text (its style and formatting stay)
- {"op":"insert_after","para":N,"text":"...","heading":0}  a new paragraph after paragraph N (heading: 0 = body text, 1–6 = heading level)
- {"op":"set_heading","para":N,"level":L}  make a paragraph a heading of level L (0 = body text)`;

export function docMessages({ course, where, doc, instruction }) {
  const system = `You edit selected paragraphs of a Word document inside a document editor. You change text and heading levels only, by returning operations.
${DOC_OPS}
Rules: change or add after only the paragraphs marked "target"; the others are context. Keep the document's tone and terminology; do not invent facts beyond the document and the instruction. Do not repeat a paragraph's numbering or bullet characters in its text.
Answer with JSON only: {"summary":"one sentence","ops":[...]}`;
  const user = `Course: ${course}${where ? `\nPart: ${where}` : ''}\n\nParagraphs:\n${doc.paras.map(p => `[${p.n}${p.target ? ' target' : ''}${p.heading ? ` heading ${p.heading}` : ''}${p.kind !== 'paragraph' ? ` ${p.kind}` : ''}] ${p.text}`).join('\n')}\n\nInstruction: ${instruction}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Validate the model's Word operations against the paragraphs it was shown. */
export function parseDocOps(text, doc) {
  const j = extractJson(text, 'object'); const ops = Array.isArray(j?.ops) ? j.ops : null;
  if (!ops || !ops.length) throw new Error('The model did not return any operations');
  const targets = new Set(doc.paras.filter(p => p.target && p.kind === 'paragraph').map(p => p.n));
  for (const op of ops) {
    const bad = m => { throw new Error(`Rejected ${op.op || 'operation'}: ${m}`); };
    if (!['set_text', 'insert_after', 'set_heading'].includes(op.op)) bad('unknown operation');
    if (!targets.has(op.para)) bad(`paragraph ${op.para} was not selected`);
    if (op.op !== 'set_heading') { if (typeof op.text !== 'string') bad('no text'); op.text = op.text.replace(/[\r\n]+/g, ' ').trim(); }
    if (op.op === 'set_heading') { op.level = Number(op.level); if (!(op.level >= 0 && op.level <= 6)) bad('heading level 0–6'); }
    if (op.op === 'insert_after' && op.heading !== undefined) { op.heading = Number(op.heading) || 0; if (op.heading < 0 || op.heading > 6) bad('heading level 0–6'); }
  }
  return { summary: String(j.summary || '').trim(), ops };
}
export function describeDocOps(ops) {
  const d = { set_text: o => `¶${o.para}: rewrote`, insert_after: o => `New paragraph after ¶${o.para}${o.heading ? ` (heading ${o.heading})` : ''}`, set_heading: o => `¶${o.para}: ${o.level ? `heading ${o.level}` : 'body text'}` };
  return ops.map(o => d[o.op](o));
}

/**
 * One light edit in the open document. office: the tab's OfficeFrame; chip: the selection ({ slides } or { paragraphs },
 * 1-based); llm: LLMClient. Returns { summary, lines, ops, snapshot } — snapshot: the document as it was (for Undo).
 */
export async function liveEdit({ office, chip, instruction, course, where, llm, model, signal, onStep = () => {}, log = () => {} }) {
  const pptx = office.format === 'pptx';
  let messages, parse;
  if (pptx) {
    const targets = [...new Set(chip.slides || [])].map(n => n - 1).filter(i => i >= 0);
    if (!targets.length) throw new Error('Select a slide first');
    onStep(`read slide${targets.length > 1 ? 's' : ''} ${targets.map(i => i + 1).join(', ')}`);
    const deck = await office.macro(READ_MACRO, { slides: targets }, true);
    messages = revisionMessages({ course, chapter: where || '', deck, instruction });
    parse = t => parseRevision(t, deck, targets);
  } else {
    const paras = [...new Set(chip.paragraphs || [])].map(n => n - 1).filter(i => i >= 0);
    if (!paras.length) throw new Error('Select some text first');
    onStep(`read ¶${paras[0] + 1}${paras.length > 1 ? `–${paras.at(-1) + 1}` : ''}`);
    const doc = await office.macro(DOC_READ_MACRO, { paras }, true);
    messages = docMessages({ course, where, doc, instruction });
    parse = t => parseDocOps(t, doc);
  }
  onStep('ask the model');
  const r = await llm.chat(messages, { json: true, signal, model }); log(r);
  const { summary, ops } = parse(r.text);
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const { file: snapshot } = await office.save(); // the document before the change, unsaved edits included
  onStep(`apply ${ops.length} change${ops.length > 1 ? 's' : ''}`);
  await office.macro(pptx ? APPLY_MACRO : DOC_APPLY_MACRO, { ops }, false);
  return { summary, ops, lines: pptx ? describeOps(ops) : describeDocOps(ops), snapshot, usage: r.usage };
}
