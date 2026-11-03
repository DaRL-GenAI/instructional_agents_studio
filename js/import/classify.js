// import/classify.js — what each imported file is and which chapter it belongs to. Rules first (file name, folder,
// extension, a few words of content), then one batched model call for the files the rules could not settle and for
// chapter assignment. The model only sees a short digest of each file, never the whole file. No browser APIs.
import { extOf, baseName } from './extract.js';

export const KINDS = ['slides', 'script', 'homework', 'lab', 'quiz', 'syllabus', 'objectives', 'exam_midterm', 'exam_final', 'reference', 'ignore'];
export const KIND_LABEL = { slides: 'Slides', script: 'Lecture script', homework: 'Homework', lab: 'Lab', quiz: 'Quiz', syllabus: 'Syllabus', objectives: 'Learning objectives', exam_midterm: 'Midterm exam', exam_final: 'Final exam', reference: 'Reference', ignore: 'Skip' };
export const CHAPTER_KINDS = new Set(['slides', 'script', 'homework', 'lab', 'quiz']);
export const DECIDED = 0.8; // rule confidence at or above which the model is not asked about the kind

const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'tif', 'tiff', 'mp4', 'mov', 'webm', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'ogg', 'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'exe', 'dmg', 'iso', 'bin', 'dat', 'pyc', 'class', 'o', 'so', 'dll', 'woff', 'woff2', 'ttf', 'otf', 'db', 'sqlite', 'pkl', 'npy', 'pt', 'ckpt']);
const STAGE_EXT = new Set(['pptx', 'docx', 'pdf', 'md', 'markdown', 'txt', 'text', 'rst', 'tex', 'ipynb', 'json']);

/** Words of a path: "Week02_DataPrep-v2.pptx" → "week 02 data prep v 2". */
export function words(s) {
  return String(s).replace(/\.[^./]+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').replace(/(\d)([A-Za-z])/g, '$1 $2')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const NAME_RULES = [
  ['syllabus', /\b(syllabus|syllabi|course (outline|info|information|overview|schedule))\b/, 0.95],
  ['objectives', /\b(learning (objectives|outcomes|goals)|objectives|outcomes)\b/, 0.9],
  ['exam_midterm', /\b(mid ?term|midterm exam)\b/, 0.95],
  ['exam_final', /\b(final exam|final examination|finals?)\b(?! project)/, 0.85],
  ['quiz', /\b(quiz|quizzes|quizz)\b/, 0.92],
  ['lab', /\b(lab|labs|laboratory|practicum|workshop)\b/, 0.9],
  ['homework', /\b(hw|homework|homeworks|assignment|assignments|problem set|pset|ps|exercise|exercises|worksheet)\b/, 0.9],
  ['script', /\b(script|transcript|narration|notes|speaker notes|lecture notes)\b/, 0.85],
  ['slides', /\b(lecture|lectures|lec|slides|slide|deck|week|wk|chapter|ch|module|unit|session|topic)\b/, 0.85],
];
const CONTENT_RULES = [
  ['syllabus', /\bsyllabus\b|\bcourse (schedule|policies|description)\b|\bgrading (policy|breakdown)\b/i, 0.7],
  ['exam_midterm', /\bmid-?term (exam|examination)\b/i, 0.7],
  ['exam_final', /\bfinal (exam|examination)\b/i, 0.7],
  ['quiz', /\bquiz\b/i, 0.65],
  ['homework', /\b(homework|assignment|problem set)\b/i, 0.65],
  ['lab', /\blab(oratory)? (exercise|session|assignment|\d)/i, 0.6],
  ['objectives', /\blearning (objectives|outcomes)\b/i, 0.6],
];

/** The chapter number a path hints at: "week2_x", "hw3", "lab 1", "ch05", "02-intro/…" → 2, 3, 1, 5, 2. */
export function chapterNumber(path) {
  const parts = String(path).split('/'); const tries = [parts.at(-1), ...parts.slice(0, -1).reverse()];
  for (const p of tries) {
    const w = words(p);
    const m = w.match(/\b(?:week|wk|ch|chapter|lec|lecture|module|unit|hw|homework|lab|quiz|assignment|session|topic|part|ps|pset|day|class)\s*0*(\d{1,2})\b/) || w.match(/^0*(\d{1,2})\b(?!\s*(?:pm|am|min))/);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  return null;
}

/** Rules for one file: { kind, confidence, reason, chapterNo } (kind null when nothing matched). */
export function ruleClassify(path, text = '') {
  const ext = extOf(path); const name = words(baseName(path)); const dirs = words(path.split('/').slice(0, -1).join(' '));
  const chapterNo = chapterNumber(path);
  const base = { chapterNo };
  if (baseName(path).startsWith('.') || MEDIA_EXT.has(ext)) return { ...base, kind: 'ignore', confidence: 0.95, reason: `.${ext || baseName(path)} files are not course material the app edits` };
  if (!STAGE_EXT.has(ext)) return { ...base, kind: 'reference', confidence: 0.85, reason: `.${ext} is kept in sources/ as reference` };
  for (const [kind, re, conf] of NAME_RULES) {
    if (!re.test(name)) continue;
    if (kind === 'slides' && ext !== 'pptx') {
      // a lecture PDF or Markdown file: chapter material, but not a deck the app can open as slides
      if (/\b(lecture|lectures|lec|slides|slide|deck)\b/.test(name)) return { ...base, kind: 'reference', confidence: 0.6, reason: `Named like lecture material, but slides must be .pptx` };
      continue;
    }
    if (ext === 'pptx' && kind !== 'slides') return { ...base, kind: 'slides', confidence: 0.6, reason: `A .pptx named like ${KIND_LABEL[kind].toLowerCase()}; decks import as slides` };
    return { ...base, kind, confidence: conf, reason: `File name: “${name.match(re)[0]}”` };
  }
  if (ext === 'pptx') return { ...base, kind: 'slides', confidence: 0.8, reason: 'A PowerPoint deck' };
  for (const [kind, re] of NAME_RULES) if (re.test(dirs) && kind !== 'slides') return { ...base, kind, confidence: 0.7, reason: `Folder name: “${dirs.match(re)[0]}”` };
  const head = String(text).slice(0, 800);
  for (const [kind, re, conf] of CONTENT_RULES) { const m = head.match(re); if (m) return { ...base, kind, confidence: conf, reason: `Mentions “${m[0]}” near the top` }; }
  return { ...base, kind: null, confidence: 0, reason: 'No rule matched' };
}

/** Which kinds a file can become (the slides stage holds a .pptx; media and unknown formats stay references). */
export function kindsFor(path) {
  const ext = extOf(path);
  if (ext === 'pptx') return ['slides', 'reference', 'ignore'];
  if (!STAGE_EXT.has(ext)) return ['reference', 'ignore'];
  return KINDS.filter(k => k !== 'slides');
}

// ---------------------------------------------------------------- the model call
const MAX_PROMPT = 14000, LONG = 500, SHORT = 160;

/** messages for one batched classification call. items: [{ path, size, digest, rule }], chapters: [{ id, title }]. */
export function classifyMessages(items, { chapters = [], course = '' } = {}) {
  const system = `You sort an instructor's existing course files into a course project.
Kinds: slides (a .pptx lecture deck), script (lecture notes or narration for a chapter), homework, lab, quiz, syllabus, objectives (learning objectives), exam_midterm, exam_final, reference (useful but not one of these), ignore (not course material).
Chapters are the course's teaching units (usually one per week or lecture topic). slides, script, homework, lab and quiz belong to exactly one chapter; the other kinds have chapter null.
Use an existing chapter's id when a file belongs to it. Otherwise name a new chapter by its topic (e.g. "Introduction to Data Mining", from the lecture's title), and use exactly the same title for every file of that chapter. Files with the same week or number usually share a chapter.
Answer with JSON only: {"chapters": ["<new chapter titles in teaching order>"], "files": [{"i": <file number>, "kind": "<kind>", "chapter": "<existing id | new chapter title | null>", "confidence": <0..1>, "reason": "<at most 12 words>"}]} with one entry per file.`;
  let budget = MAX_PROMPT - system.length - 600;
  const lines = items.map((it, i) => {
    const decided = it.rule?.kind && it.rule.confidence >= DECIDED;
    const hint = [it.rule?.kind ? `rules say ${it.rule.kind}${decided ? '' : '?'}` : null, it.rule?.chapterNo ? `number ${it.rule.chapterNo}` : null].filter(Boolean).join(', ');
    return { i, head: `[${i}] ${it.path} (${Math.max(1, Math.round((it.size || 0) / 1024))} KB${hint ? `; ${hint}` : ''})`, digest: String(it.digest || '').slice(0, decided ? SHORT : LONG) };
  });
  for (const l of lines) budget -= l.head.length + 1;
  const per = Math.max(60, Math.floor(budget / Math.max(1, lines.length)));
  const user = [`Course: ${course || '(unnamed)'}`, `Existing chapters: ${chapters.length ? chapters.map((c, i) => `\n- ${c.id}: ${i + 1}. ${c.title}`).join('') : 'none'}`, '', 'Files:',
    ...lines.map(l => `${l.head}${l.digest ? `\n    ${l.digest.slice(0, per).replace(/\s+/g, ' ')}` : ''}`)].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user.slice(0, MAX_PROMPT) }];
}

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A chapter answer → an existing chapter id, `new:<title>`, or ''. */
export function chapterRef(answer, chapters) {
  if (answer === null || answer === undefined || answer === '' || /^null$/i.test(String(answer))) return '';
  const a = String(answer).trim();
  const byId = chapters.find(c => c.id === a); if (byId) return byId.id;
  const byTitle = chapters.find(c => norm(c.title) === norm(a)); if (byTitle) return byTitle.id;
  const num = a.match(/^(?:chapter|ch|week)?\s*(\d{1,2})$/i); if (num && chapters[Number(num[1]) - 1]) return chapters[Number(num[1]) - 1].id;
  return `new:${a.replace(/\s+/g, ' ').slice(0, 120)}`;
}

/**
 * Rules + the model's answer (parsed JSON or null) → one decision per item:
 * { kind, chapter ('' | chapter id | 'new:<title>'), confidence, reason, by: 'rules'|'model'|'both' }, and the new
 * chapters in order.
 */
export function decide(items, answer, { chapters = [] } = {}) {
  const got = new Map(); for (const f of Array.isArray(answer?.files) ? answer.files : []) if (f && Number.isInteger(Number(f.i))) got.set(Number(f.i), f);
  const order = (Array.isArray(answer?.chapters) ? answer.chapters : []).map(t => chapterRef(typeof t === 'string' ? t : t?.title, chapters)).filter(r => r.startsWith('new:'));
  const out = items.map((it, i) => {
    const r = it.rule || { kind: null, confidence: 0 }; const m = got.get(i); const allowed = kindsFor(it.path);
    const mk = m && KINDS.includes(m.kind) && allowed.includes(m.kind) ? m.kind : null;
    const mc = Math.max(0, Math.min(1, Number(m?.confidence) || 0.6));
    let kind, confidence, reason, by;
    if (r.kind && r.confidence >= DECIDED) { kind = r.kind; confidence = mk && mk !== r.kind ? Math.min(r.confidence, 0.7) : r.confidence; reason = r.reason + (mk && mk !== r.kind ? `; the model suggested ${KIND_LABEL[mk].toLowerCase()}` : ''); by = mk === r.kind ? 'both' : 'rules'; }
    else if (mk) { kind = mk; confidence = r.kind === mk ? Math.max(mc, r.confidence) : mc; reason = String(m.reason || 'Model').slice(0, 160); by = r.kind === mk ? 'both' : 'model'; }
    else { kind = r.kind && allowed.includes(r.kind) ? r.kind : (allowed.includes('reference') ? 'reference' : allowed[0]); confidence = r.kind ? r.confidence : 0.3; reason = r.reason || 'No rule matched'; by = 'rules'; }
    let chapter = '';
    if (CHAPTER_KINDS.has(kind) || kind === 'reference') {
      chapter = m ? chapterRef(m.chapter, chapters) : '';
      if (!chapter && r.chapterNo) chapter = chapters[r.chapterNo - 1]?.id || `new:#${r.chapterNo}`;
      if (!chapter && CHAPTER_KINDS.has(kind)) chapter = `new:${it.title || baseName(it.path).replace(/\.[^.]+$/, '')}`;
    }
    return { kind, chapter, confidence: Math.round(confidence * 100) / 100, reason, by };
  });
  // number-only chapters (no model): one per number, titled after that number's deck when there is one
  const named = new Map();
  out.forEach((d, i) => { const n = d.chapter.match(/^new:#(\d+)$/)?.[1]; if (n && d.kind === 'slides' && items[i].title && !named.has(n)) named.set(n, items[i].title); });
  for (const d of out) { const n = d.chapter.match(/^new:#(\d+)$/)?.[1]; if (n) d.chapter = `new:${named.get(n) || `Week ${n}`}`; }
  // new chapters: the model's order, then by first appearance (number order when the rules found numbers)
  const seen = new Set(order); const rest = [];
  out.forEach((d, i) => { if (d.chapter.startsWith('new:') && !seen.has(d.chapter)) { seen.add(d.chapter); rest.push({ ref: d.chapter, n: items[i].rule?.chapterNo ?? 99, i }); } });
  rest.sort((a, b) => a.n - b.n || a.i - b.i);
  const used = new Set(out.map(d => d.chapter));
  return { decisions: out, newChapters: [...order.filter(r => used.has(r)), ...rest.map(r => r.ref)] };
}

// ---------------------------------------------------------------- similarity (new versions)
/** Word shingles (k words) of a text, as a Set of strings. */
export function shingles(text, k = 4) {
  const w = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set(); if (w.length < k) { if (w.length) out.add(w.join(' ')); return out; }
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(' '));
  return out;
}
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0; let inter = 0; const [s, l] = a.size < b.size ? [a, b] : [b, a];
  for (const x of s) if (l.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
export const SIMILAR = 0.6;

/**
 * Is a new file a new version of something already imported? candidates: [{ key, label, sourcePath, text }].
 * Same relative path wins; otherwise the most similar text at or above SIMILAR. → { key, label, why, score } | null.
 */
export function versionOf({ sourcePath, text }, candidates) {
  const same = candidates.find(c => c.sourcePath && c.sourcePath === sourcePath); if (same) return { key: same.key, label: same.label, why: 'path', score: 1 };
  const sh = shingles(text); if (sh.size < 3) return null;
  let best = null;
  for (const c of candidates) { const s = jaccard(sh, c.shingles || (c.shingles = shingles(c.text))); if (s >= SIMILAR && (!best || s > best.score)) best = { key: c.key, label: c.label, why: 'similar', score: Math.round(s * 100) / 100 }; }
  return best;
}
