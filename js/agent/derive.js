// agent/derive.js — drafting upstream stages from downstream material: a chapter's outline or lecture script from its
// slides, the learning objectives or the chapter list from the syllabus. Each is one model call whose answer goes into
// the built-in agent's overlay, so it is reviewed (and kept or discarded) like any agent change.
import { extractJson } from '../llm.js';
import { emptyStage } from '../model.js';
import { chapterDir } from '../fs/serialize.js';
import { layout } from '../ws/stages.js';
import { textOf } from '../linkage.js';

export const DERIVE = {
  outline: { label: 'Draft outline', from: 'slides', title: 'Draft the slide outline from the slides' },
  script: { label: 'Draft script', from: 'slides', title: 'Draft the lecture script from the slides (speaker notes included)' },
  objectives: { label: 'Draft objectives', from: 'syllabus', title: 'Draft the learning objectives from the syllabus' },
  chapters: { label: 'Draft chapters', from: 'syllabus', title: 'Draft the chapter list from the syllabus' },
  design: { label: 'Rebuild course design from slides', from: 'decks', title: 'Rebuild the course design from the slides: chapter order and descriptions, syllabus, learning objectives, course basics' },
};

/** Chapters that have slides (the material a course rebuilt from scattered decks starts with). */
export const deckChapters = project => (project?.chapters || []).filter(ch => textOf(ch.stages?.slides?.output).trim());
/** A course that started from its slides and has no design yet: no syllabus, no objectives, or chapters without a
 *  description (what an import of decks leaves). */
export const needsDesign = project => !!deckChapters(project).length && (!textOf(project.foundation?.syllabus?.output).trim() || !textOf(project.foundation?.objectives?.output).trim() || project.chapters.every(ch => !String(ch.description || '').trim()));

/** The derive actions for a stage file (owner: the Workspace's ownerInfo). */
export function deriveActions(owner, project = null) {
  const out = [];
  if (owner?.stageId === 'slides' && owner.chapter) out.push('outline', 'script');
  if (owner?.key === 'foundation.syllabus') out.push('objectives', 'chapters');
  // the whole course from its decks: offered while there is no syllabus yet, and on the design files themselves
  const designFile = ['foundation.syllabus', 'foundation.objectives', 'chaptersStage'].includes(owner?.key);
  if (deckChapters(project).length && (designFile || needsDesign(project))) out.push('design');
  return out;
}

const PROMPTS = {
  outline: src => [{ role: 'system', content: 'You recover the slide outline a lecture deck was built from. One item per slide, in order. Answer with JSON only: [{"slide_id":1,"title":"...","description":"one or two sentences: what the slide covers and why"}]' }, { role: 'user', content: src }],
  script: src => [{ role: 'system', content: 'You write the lecture script an instructor speaks over these slides: one entry per slide, in order, 60–140 words each, conversational, building on the speaker notes when a slide has them. Do not add facts the slides do not support. Answer with JSON only: [{"slide_id":1,"title":"...","narration":"..."}]' }, { role: 'user', content: src }],
  objectives: src => [{ role: 'system', content: 'From this syllabus, write the course\'s learning objectives: 5–8 measurable objectives (Bloom verbs), as Markdown with the heading "# Learning objectives" and a numbered list. Only the document.' }, { role: 'user', content: src }],
  chapters: src => [{ role: 'system', content: 'From this syllabus, list the course\'s chapters in teaching order (one per week or topic). Answer with JSON only: [{"title":"...","description":"one or two sentences"}]' }, { role: 'user', content: src }],
};

const DESIGN_SYSTEM = `You rebuild the design of a university course from the lecture slides an instructor already has. The decks were
collected loosely: file names and order may be wrong. Work only from what the slides show; where you have to guess (level,
audience, weekly pace), say so in the syllabus with "(inferred)". Answer with JSON only:
{
 "course": { "name": "...", "subject": "...", "level": "Undergraduate|Graduate|...", "audience": "who the course is for", "description": "2-3 sentences" },
 "chapters": [ { "id": "<the id given for the deck>", "title": "a clear chapter title", "description": "1-2 sentences: what it teaches" } ],
 "gaps": [ { "title": "...", "why": "one sentence" } ],
 "objectives": [ "5-8 measurable course learning objectives (Bloom verbs), each traceable to the slides" ],
 "syllabus": "Markdown syllabus: course description, prerequisites (inferred), a weekly schedule table with one row per chapter in teaching order (week, topic, what is covered), and assessment ideas marked as suggestions"
}
Rules: "chapters" lists every given deck exactly once, by its id, in the order a student should learn them (prerequisites first,
broad context early, ethics or wrap-up topics where they fit). Keep a deck's own title when it is already clear. "gaps": at most 4
topics a course like this usually needs that none of the decks cover (empty when nothing important is missing).`;

const list = (text, kind) => { const a = extractJson(text, 'array'); if (!Array.isArray(a) || !a.length) throw new Error(`The model returned no ${kind}`); return a.filter(x => x && typeof x === 'object'); };
function scriptMarkdown(items, chapterTitle) {
  return `# ${chapterTitle} — lecture script\n\n${items.map((x, i) => `## Slide ${x.slide_id ?? i + 1}: ${x.title || ''}\n\n${String(x.narration || '').trim()}\n`).join('\n')}`;
}

/**
 * Run one derive action for the stage behind `owner`. store: the ProjectStore; llm: LLMClient.
 * Returns { overlay: Map(path → text), keys: Map(path → stage key), summary, beforeCommit(store) }.
 */
export async function runDerive(action, { owner, store, llm, model, signal, onStep = () => {}, log = () => {} }) {
  const p = store.project; const meta = layout(p).meta;
  const fileOf = key => meta.stages[key]?.$file || null;
  const course = `Course: ${p.course?.name || p.name || ''}`;
  if (action === 'design') return rebuildDesign({ store, llm, model, signal, onStep, log, fileOf });
  let src, target, path, render;
  if (DERIVE[action].from === 'slides') {
    const ch = owner.chapter; const slides = textOf(owner.stage.output);
    if (!slides.trim()) throw new Error('The slides have no text yet');
    src = `${course}\nChapter: ${ch.title}${ch.description ? ` — ${ch.description}` : ''}\n\nSlides:\n${slides.slice(0, 40000)}`;
    target = `chapters.${ch.id}.${action}`; store.chapterStage(ch.id, action);
    const dir = chapterDir(ch, p.chapters.indexOf(ch));
    path = fileOf(target) || `${dir}/${action === 'outline' ? 'outline.json' : 'script.md'}`;
    render = action === 'outline'
      ? t => JSON.stringify(list(t, 'outline').map((x, i) => ({ slide_id: i + 1, title: String(x.title || x.slide_title || `Slide ${i + 1}`), description: String(x.description || '') })), null, 2)
      : t => { const items = list(t, 'script').map((x, i) => ({ slide_id: Number(x.slide_id) || i + 1, title: String(x.title || ''), narration: String(x.narration ?? x.text ?? '') })); return /\.json$/i.test(path) ? JSON.stringify(items, null, 2) : scriptMarkdown(items, ch.title); };
  } else {
    const syl = textOf(owner.stage.output); if (!syl.trim()) throw new Error('The syllabus is empty');
    src = `${course}\n\nSyllabus:\n${syl.slice(0, 40000)}`;
    if (action === 'objectives') { target = 'foundation.objectives'; store.foundationStage('objectives'); path = fileOf(target) || 'design/learning_objectives.md'; render = t => `${t.trim().replace(/^```\w*\n?|```$/g, '').trim()}\n`; }
    else { target = 'chaptersStage'; p.chaptersStage ||= emptyStage(); path = fileOf(target) || 'design/chapters.json'; render = t => JSON.stringify(list(t, 'chapters').filter(c => c.title).map(c => ({ title: String(c.title), description: String(c.description || '') })), null, 2); }
  }
  onStep(`read ${owner.path || owner.label}`);
  onStep('ask the model');
  const json = action !== 'objectives';
  const r = await llm.chat(PROMPTS[action](src), { json, signal, model }); log(r);
  const text = render(r.text);
  onStep(`write ${path}`);
  const sourceKey = owner.key;
  return {
    overlay: new Map([[path, text]]), keys: new Map([[path, target]]),
    summary: `Drafted ${path} from ${owner.path || owner.label}. Review it, then keep or discard.`,
    /** After the kept text is in its stage: the source counts as made from this version (it is not out of date), and a
     *  kept chapter list adds the chapters it names that the course does not have yet. */
    beforeCommit(st) {
      const pr = st.project; const [a, b, c] = target.split('.');
      const t = a === 'chapters' ? pr.chapters.find(x => x.id === b)?.stages?.[c] : a === 'foundation' ? pr.foundation[b] : pr.chaptersStage;
      const s = sourceKey.split('.'); const source = s[0] === 'chapters' ? pr.chapters.find(x => x.id === s[1])?.stages?.[s[2]] : pr.foundation[s[1]];
      if (t && source && (action === 'outline' || action === 'objectives')) source.basis = { ...(source.basis || {}), [target]: t.version };
      if (action === 'chapters' && t?.output) {
        let items = []; try { items = JSON.parse(t.output); } catch { /* the reviewer kept invalid JSON: refused earlier */ }
        for (const c2 of items) if (c2?.title && !pr.chapters.some(x => x.title.trim().toLowerCase() === String(c2.title).trim().toLowerCase())) st.addChapter({ title: String(c2.title), description: String(c2.description || '') });
      }
    },
  };
}

/** The course design from its slide decks (one model call): design/chapters.json in teaching order with descriptions,
 *  the syllabus and the learning objectives, reviewed like any change. Keeping it reorders and describes the chapters
 *  and fills the course basics that are still empty. */
async function rebuildDesign({ store, llm, model, signal, onStep, log, fileOf }) {
  const p = store.project; const decks = deckChapters(p);
  if (!decks.length) throw new Error('No chapter has slides yet. Import your decks first (Open folder, or Import in the file tree).');
  const per = Math.max(1500, Math.floor(36000 / decks.length));
  const known = [p.course?.name && `Course name: ${p.course.name}`, p.course?.subject && `Subject: ${p.course.subject}`, p.course?.audience && `Audience: ${p.course.audience}`].filter(Boolean).join('\n');
  const src = `${known ? `${known}\n\n` : ''}${decks.map(ch => `=== Deck id ${ch.id} (now titled "${ch.title}"${ch.stages.slides.sourcePath ? `, file ${ch.stages.slides.sourcePath}` : ''}) ===\n${textOf(ch.stages.slides.output).slice(0, per)}`).join('\n\n')}`;
  onStep(`read ${decks.length} slide deck${decks.length > 1 ? 's' : ''}`);
  onStep('ask the model');
  const r = await llm.chat([{ role: 'system', content: DESIGN_SYSTEM }, { role: 'user', content: src }], { json: true, signal, model }); log(r);
  const d = extractJson(r.text, 'object');
  if (!d || !Array.isArray(d.chapters) || !d.chapters.length) throw new Error('The model returned no chapter list. Try again.');
  // every deck exactly once: unknown ids dropped, missing decks appended in their current order
  const byId = new Map(decks.map(ch => [ch.id, ch])); const seen = new Set(); const order = [];
  for (const c of d.chapters) { const ch = byId.get(String(c?.id || '').trim()); if (ch && !seen.has(ch.id)) { seen.add(ch.id); order.push({ id: ch.id, title: String(c.title || ch.title).trim() || ch.title, description: String(c.description || ch.description || '').trim() }); } }
  for (const ch of decks) if (!seen.has(ch.id)) order.push({ id: ch.id, title: ch.title, description: ch.description || '' });
  const others = p.chapters.filter(ch => !byId.has(ch.id)).map(ch => ({ id: ch.id, title: ch.title, description: ch.description || '' }));
  const all = [...order, ...others];
  const gaps = (Array.isArray(d.gaps) ? d.gaps : []).filter(g => g?.title).slice(0, 4).map(g => ({ title: String(g.title), why: String(g.why || '') }));
  const objectives = (Array.isArray(d.objectives) ? d.objectives : []).map(String).filter(x => x.trim());
  let syllabus = String(d.syllabus || '').trim();
  if (!syllabus) throw new Error('The model returned no syllabus. Try again.');
  if (gaps.length) syllabus += `\n\n## Possible additions (no slides yet)\n\n${gaps.map(g => `- **${g.title}**${g.why ? `: ${g.why}` : ''}`).join('\n')}\n`;
  for (const k of ['foundation.syllabus', 'foundation.objectives']) store.foundationStage(k.split('.')[1]);
  p.chaptersStage ||= emptyStage();
  const paths = { syl: fileOf('foundation.syllabus') || 'design/syllabus.md', obj: fileOf('foundation.objectives') || 'design/learning_objectives.md', chs: fileOf('chaptersStage') || 'design/chapters.json' };
  const overlay = new Map([[paths.chs, JSON.stringify(all.map(c => ({ title: c.title, description: c.description })), null, 2)], [paths.syl, `${syllabus}\n`]]);
  const keys = new Map([[paths.chs, 'chaptersStage'], [paths.syl, 'foundation.syllabus']]);
  if (objectives.length) { overlay.set(paths.obj, `# Learning objectives\n\n${objectives.map((o, i) => `${i + 1}. ${o.replace(/^\d+[.)]\s*/, '')}`).join('\n')}\n`); keys.set(paths.obj, 'foundation.objectives'); }
  onStep(`write ${[...overlay.keys()].join(', ')}`);
  const course = d.course && typeof d.course === 'object' ? d.course : {};
  const renamed = new Map(all.map(c => [c.title.trim().toLowerCase(), c.id])); // proposed title → chapter
  const moves = all.map((c, i) => [c, p.chapters.findIndex(x => x.id === c.id) !== i]).filter(([, moved]) => moved).length;
  return {
    overlay, keys,
    summary: `${course.name && course.name.trim() !== String(p.course?.name || '').trim() ? `Suggested course name: “${String(course.name).trim()}” (change it under Course basics). ` : ''}Rebuilt the course design from ${decks.length} slide deck${decks.length > 1 ? 's' : ''}: the chapter list in teaching order${moves ? ` (${moves} chapter${moves > 1 ? 's' : ''} move)` : ''}, the syllabus${objectives.length ? ' and the learning objectives' : ''}.${gaps.length ? ` Not covered by any deck: ${gaps.map(g => g.title).join('; ')} (listed at the end of the syllabus; add them as chapters in Course design → Chapters to generate them).` : ''} Review, then keep or discard. Afterwards Course design → Run all six fills in the remaining deliberations around what you kept.`,
    /** After the kept chapter list is in its stage: the chapters take its order, titles and descriptions (matched by
     *  title, or by the title proposed here), and empty course basics are filled in. */
    beforeCommit(st) {
      const pr = st.project; let items = [];
      try { items = JSON.parse(pr.chaptersStage?.output || '[]'); } catch { items = []; }
      if (Array.isArray(items) && items.length) {
        const used = new Set(); const next = [];
        for (const it of items) {
          const t = String(it?.title || '').trim(); if (!t) continue;
          const ch = pr.chapters.find(x => !used.has(x.id) && x.title.trim().toLowerCase() === t.toLowerCase()) || pr.chapters.find(x => !used.has(x.id) && x.id === renamed.get(t.toLowerCase()));
          if (!ch) continue; used.add(ch.id); ch.title = t; if (it.description) ch.description = String(it.description); next.push(ch);
        }
        for (const ch of pr.chapters) if (!used.has(ch.id)) next.push(ch);
        pr.chapters.splice(0, pr.chapters.length, ...next);
      }
      const c = pr.course || (pr.course = {});
      for (const [k, v] of [['name', course.name], ['subject', course.subject], ['audience', course.audience], ['notes', course.description]]) if (v && !String(c[k] || '').trim()) c[k] = String(v);
      if (course.level && (!c.level || c.level === 'Undergraduate')) c.level = String(course.level);
      st.log({ type: 'edit', stage: 'Course design', where: 'course', note: `rebuilt from ${decks.length} slide decks` });
    },
  };
}
