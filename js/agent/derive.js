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
};

/** The derive actions for a stage file (owner: the Workspace's ownerInfo). */
export function deriveActions(owner) {
  if (!owner) return [];
  if (owner.stageId === 'slides' && owner.chapter) return ['outline', 'script'];
  if (owner.key === 'foundation.syllabus') return ['objectives', 'chapters'];
  return [];
}

const PROMPTS = {
  outline: src => [{ role: 'system', content: 'You recover the slide outline a lecture deck was built from. One item per slide, in order. Answer with JSON only: [{"slide_id":1,"title":"...","description":"one or two sentences: what the slide covers and why"}]' }, { role: 'user', content: src }],
  script: src => [{ role: 'system', content: 'You write the lecture script an instructor speaks over these slides: one entry per slide, in order, 60–140 words each, conversational, building on the speaker notes when a slide has them. Do not add facts the slides do not support. Answer with JSON only: [{"slide_id":1,"title":"...","narration":"..."}]' }, { role: 'user', content: src }],
  objectives: src => [{ role: 'system', content: 'From this syllabus, write the course\'s learning objectives: 5–8 measurable objectives (Bloom verbs), as Markdown with the heading "# Learning objectives" and a numbered list. Only the document.' }, { role: 'user', content: src }],
  chapters: src => [{ role: 'system', content: 'From this syllabus, list the course\'s chapters in teaching order (one per week or topic). Answer with JSON only: [{"title":"...","description":"one or two sentences"}]' }, { role: 'user', content: src }],
};

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
