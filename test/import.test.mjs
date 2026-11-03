// Import of existing materials: the rules classifier, text digests of every supported format (fixtures built here),
// similarity and new-version detection, merging the model's answer, and the folder layout an import produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

// the browser globals the readers use: DOMParser (xmldom, a dependency of mammoth) and JSZip
const require = createRequire(import.meta.url);
globalThis.window ??= globalThis;
globalThis.DOMParser ??= require('@xmldom/xmldom').DOMParser;
{ // xmldom's node lists are array-like but not iterable
  const doc = new DOMParser().parseFromString('<a><b/></a>', 'application/xml');
  for (const list of [doc.getElementsByTagName('b'), doc.documentElement.childNodes, doc.documentElement.attributes]) { const proto = Object.getPrototypeOf(list); proto[Symbol.iterator] ??= Array.prototype[Symbol.iterator]; }
}
globalThis.JSZip ??= require('jszip');
const JSZip = globalThis.JSZip;

const { extractText, digest, texText, notebookText, simplePdfText, deckText } = await import('../js/import/extract.js');
const { ruleClassify, chapterNumber, classifyMessages, decide, kindsFor, shingles, jaccard, versionOf, chapterRef } = await import('../js/import/classify.js');
const { applyImport, importedStages, importMessage, targetKey } = await import('../js/import/apply.js');
const { ProjectStore, newProject } = await import('../js/state.js');
const { serialize } = await import('../js/fs/serialize.js');
const { mdToDocx } = await import('../js/docconv.js');

// ---------------------------------------------------------------- fixtures
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const sp = (type, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${type ? `<p:ph type="${type}"/>` : '<p:ph idx="1"/>'}</p:nvPr></p:nvSpPr><p:txBody>${paras.map(t => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
/** A minimal .pptx: slides [{ title, bullets, notes }]. */
export async function makePptx(slides) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file('ppt/presentation.xml', `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  z.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`);
  slides.forEach((s, i) => {
    z.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${sp('title', [s.title])}${sp(null, s.bullets || [])}</p:spTree></p:cSld></p:sld>`);
    if (s.notes) {
      z.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`);
      z.file(`ppt/notesSlides/notesSlide${i + 1}.xml`, `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree>${sp('body', [s.notes]).replace('type="body"', 'type="body" idx="1"')}</p:spTree></p:cSld></p:notes>`);
    }
  });
  return new Blob([await z.generateAsync({ type: 'uint8array' })], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
}
/** A minimal PDF with one page of text (Helvetica); deflate: compress the content stream. */
export function makePdf(lines, { deflate = false } = {}) {
  const content = `BT /F1 14 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -20 Td ' : ''}(${l.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET`;
  const data = deflate ? zlib.deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const parts = [Buffer.from('%PDF-1.4\n')]; const offs = []; let len = parts[0].length;
  objs.forEach((o, i) => {
    const body = o ?? null; let chunk;
    if (body) chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    else chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${data.length}${deflate ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    offs.push(len); parts.push(chunk); len += chunk.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
const docx = async md => new Blob([await mdToDocx(md)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

// ---------------------------------------------------------------- rules
test('rules: file names, folders, extensions and content', () => {
  const k = (p, t) => ruleClassify(p, t).kind;
  assert.equal(k('course/syllabus.pdf'), 'syllabus');
  assert.equal(k('course/week1_intro.pptx'), 'slides');
  assert.equal(k('course/Lecture03-Trees.pptx'), 'slides');
  assert.equal(k('course/hw1.docx'), 'homework');
  assert.equal(k('course/HW2.md'), 'homework');
  assert.equal(k('course/Problem Set 4.pdf'), 'homework');
  assert.equal(k('course/lab1.md'), 'lab');
  assert.equal(k('course/quiz1.md'), 'quiz');
  assert.equal(k('course/midterm_2025.pdf'), 'exam_midterm');
  assert.equal(k('course/Final Exam.docx'), 'exam_final');
  assert.notEqual(k('course/final project.docx'), 'exam_final', 'a final project is not the final exam');
  assert.equal(k('course/notes_week1.md'), 'script', 'notes win over week');
  assert.equal(k('course/learning_objectives.md'), 'objectives');
  assert.equal(k('course/photo.jpg'), 'ignore');
  assert.equal(k('course/.DS_Store'), 'ignore');
  assert.equal(k('course/misc.md'), null, 'nothing to go on');
  assert.equal(k('course/data.csv'), 'reference');
  assert.equal(k('course/hw/solutions.md'), 'homework', 'folder name');
  assert.equal(k('course/readme.md', '# Homework 3\nDue Friday'), 'homework', 'content near the top');
  assert.equal(k('course/lecture2.pdf'), 'reference', 'a lecture PDF is not a deck');
  assert.equal(k('course/quiz-review.pptx'), 'slides', 'decks import as slides');
  assert.equal(k('course/helper.py'), 'reference');
  const hw = ruleClassify('course/hw1.docx'); assert.ok(hw.confidence >= 0.8); assert.match(hw.reason, /hw/);
  assert.ok(ruleClassify('course/readme.md', '# Homework 3').confidence < 0.8, 'content rules alone stay undecided');
});

test('rules: chapter numbers from names and folders', () => {
  assert.equal(chapterNumber('week1_intro.pptx'), 1);
  assert.equal(chapterNumber('c/Week 02 - Data.pptx'), 2);
  assert.equal(chapterNumber('hw3.docx'), 3);
  assert.equal(chapterNumber('ch05.md'), 5);
  assert.equal(chapterNumber('03-trees/slides.pptx'), 3);
  assert.equal(chapterNumber('lecture-notes/lec12.pdf'), 12);
  assert.equal(chapterNumber('syllabus.pdf'), null);
  assert.deepEqual(kindsFor('a.pptx'), ['slides', 'reference', 'ignore']);
  assert.ok(!kindsFor('a.pdf').includes('slides'));
  assert.deepEqual(kindsFor('a.png'), ['reference', 'ignore']);
});

// ---------------------------------------------------------------- text and digests
test('digests: pptx, docx, pdf (plain and deflated), md, ipynb, tex', async () => {
  const deck = await makePptx([{ title: 'Introduction to Data Mining', bullets: ['What is data mining?', 'KDD process'], notes: 'Welcome everyone.' }, { title: 'Data types', bullets: ['Nominal', 'Ordinal'] }]);
  const p = await extractText('w1.pptx', deck);
  assert.equal(p.title, 'Introduction to Data Mining'); assert.equal(p.slides.length, 2);
  assert.match(p.text, /# Introduction to Data Mining\n- What is data mining\?\n- KDD process\nNotes: Welcome everyone\./);
  assert.equal(p.text, deckText(p.slides));

  const d = await extractText('hw1.docx', await docx('# Homework 1\n\n1. Define support.\n2. Compute confidence.\n'));
  assert.equal(d.title, 'Homework 1'); assert.match(d.text, /Define support/);

  for (const deflate of [false, true]) {
    const bytes = makePdf(['Course Syllabus: Data Mining (CSE 572)', 'Week 1: Introduction', 'Grading: homework 40%'], { deflate });
    const t = await simplePdfText(bytes);
    assert.match(t, /Course Syllabus: Data Mining \(CSE 572\)\nWeek 1: Introduction\nGrading: homework 40%/, `deflate=${deflate}`);
    const x = await extractText('syllabus.pdf', new Blob([bytes]));
    assert.equal(x.title, 'Course Syllabus: Data Mining (CSE 572)');
  }

  const m = await extractText('notes.md', new Blob(['# Week 1 notes\n\nToday we cover the KDD process.\n']));
  assert.equal(m.title, 'Week 1 notes');

  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Lab 2: Clustering\n', 'Run k-means.'] }, { cell_type: 'code', source: ['import numpy'] }, { cell_type: 'markdown', source: 'Questions: why k?' }] });
  assert.equal(notebookText(nb), '# Lab 2: Clustering\nRun k-means.\n\nQuestions: why k?');
  assert.equal((await extractText('lab2.ipynb', new Blob([nb]))).title, 'Lab 2: Clustering');

  const tex = '\\documentclass{article}\n\\title{Homework 4}\n\\begin{document}\n% a comment\n\\section{Trees}\nProve that \\textbf{every} tree with $n$ nodes has $n-1$ edges.\n\\begin{enumerate}\\item First\\item Second\\end{enumerate}\n\\end{document}';
  const tt = texText(tex);
  assert.match(tt, /^# Trees$/m); assert.match(tt, /every tree/); assert.match(tt, /^- First$/m); assert.doesNotMatch(tt, /comment|\\textbf|documentclass/);
  assert.equal((await extractText('hw4.tex', new Blob([tex]))).title, 'Homework 4');

  const dg = digest('# Title\nline one\n\n## Part A\n' + 'word '.repeat(500));
  assert.ok(dg.length <= 600); assert.match(dg, /^# Title \| # Part A \|\| line one/);
  assert.equal((await extractText('photo.png', new Blob([new Uint8Array([137, 80, 78, 71])]))).text, '');
  assert.equal((await extractText('broken.docx', new Blob(['not a zip']))).text, '', 'unreadable files give no text, not an error');
});

// ---------------------------------------------------------------- the model's part
test('model prompt is capped and carries digests, not files; decisions merge rules and the answer', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ path: `c/file${i}.md`, size: 4000, digest: 'x'.repeat(600), rule: { kind: null, confidence: 0, chapterNo: null } }));
  const [sys, user] = classifyMessages(items, { chapters: [{ id: 'chA', title: 'Intro' }], course: 'Data Mining' });
  assert.match(sys.content, /JSON only/); assert.ok(user.content.length <= 14000); assert.match(user.content, /chA: 1\. Intro/); assert.match(user.content, /\[59\] c\/file59\.md/);

  const files = [
    { path: 'c/syllabus.pdf', title: 'Syllabus', rule: ruleClassify('c/syllabus.pdf') },
    { path: 'c/week1_intro.pptx', title: 'Introduction to Data Mining', rule: ruleClassify('c/week1_intro.pptx') },
    { path: 'c/hw1.docx', title: 'Homework 1', rule: ruleClassify('c/hw1.docx') },
    { path: 'c/readme.md', title: 'Readme', rule: ruleClassify('c/readme.md') },
    { path: 'c/old.pptx', title: 'Old', rule: ruleClassify('c/old.pptx') },
  ];
  const answer = { chapters: ['Introduction to Data Mining'], files: [
    { i: 0, kind: 'syllabus', chapter: null, confidence: 0.9, reason: 'syllabus' },
    { i: 1, kind: 'slides', chapter: 'Introduction to Data Mining', confidence: 0.9 },
    { i: 2, kind: 'homework', chapter: 'introduction to data mining', confidence: 0.9 },
    { i: 3, kind: 'lab', chapter: 'chA', confidence: 0.55, reason: 'lab instructions' },
    { i: 4, kind: 'quiz', chapter: 'chA' }, // not possible for a .pptx: falls back to the rules
  ] };
  const { decisions, newChapters } = decide(files, answer, { chapters: [{ id: 'chA', title: 'Basics' }] });
  assert.deepEqual(decisions.map(d => d.kind), ['syllabus', 'slides', 'homework', 'lab', 'slides']);
  assert.equal(decisions[0].chapter, '');
  assert.equal(decisions[1].chapter, 'new:Introduction to Data Mining');
  assert.equal(decisions[2].chapter, 'new:introduction to data mining', 'kept as written; the table groups by title');
  assert.equal(decisions[3].chapter, 'chA'); assert.equal(decisions[3].by, 'model'); assert.equal(decisions[3].confidence, 0.55);
  assert.equal(decisions[1].by, 'both');
  assert.deepEqual(newChapters.slice(0, 1), ['new:Introduction to Data Mining']);
  assert.equal(chapterRef('2', [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }]), 'b');
  assert.equal(chapterRef(null, []), '');

  // no model: chapters by number, titled after that number's deck
  const offline = decide([
    { path: 'c/week2_data.pptx', title: 'Getting to Know Your Data', rule: ruleClassify('c/week2_data.pptx') },
    { path: 'c/hw2.md', title: 'HW2', rule: ruleClassify('c/hw2.md') },
    { path: 'c/week1_intro.pptx', title: 'Intro', rule: ruleClassify('c/week1_intro.pptx') },
    { path: 'c/quiz1.md', title: 'Quiz 1', rule: ruleClassify('c/quiz1.md') },
  ], null);
  assert.deepEqual(offline.decisions.map(d => d.chapter), ['new:Getting to Know Your Data', 'new:Getting to Know Your Data', 'new:Intro', 'new:Intro']);
  assert.deepEqual(offline.newChapters, ['new:Intro', 'new:Getting to Know Your Data'], 'number order');
});

// ---------------------------------------------------------------- similarity
test('similarity: shingled Jaccard and new-version detection', () => {
  const a = 'Homework 1. Answer all questions. 1. Define support and confidence for an association rule. 2. Compute the support of {milk, bread} in the table below. 3. Explain the Apriori property in your own words.';
  const b = a.replace('3. Explain the Apriori property in your own words.', '3. Explain the Apriori property in your own words and give an example.');
  const c = 'Lab 1. Install Python and run the k-means notebook on the iris data. Report the clusters you find.';
  assert.ok(jaccard(shingles(a), shingles(b)) >= 0.6);
  assert.ok(jaccard(shingles(a), shingles(c)) < 0.1);
  assert.equal(jaccard(shingles(a), shingles(a)), 1);
  const cands = [{ key: 'chapters.ch1.homework', label: 'Week 1 / Homework', sourcePath: 'sources/c/hw1.docx', text: a }, { key: 'chapters.ch1.lab', label: 'Week 1 / Lab', sourcePath: 'sources/c/lab1.md', text: c }];
  assert.deepEqual(versionOf({ sourcePath: 'sources/c/hw1.docx', text: 'anything' }, cands), { key: 'chapters.ch1.homework', label: 'Week 1 / Homework', why: 'path', score: 1 });
  const sim = versionOf({ sourcePath: 'sources/other/homework-1-v2.docx', text: b }, cands);
  assert.equal(sim.key, 'chapters.ch1.homework'); assert.equal(sim.why, 'similar'); assert.ok(sim.score >= 0.6);
  assert.equal(versionOf({ sourcePath: 'sources/x.md', text: 'Something else entirely about graphs and trees and paths.' }, cands), null);
});

// ---------------------------------------------------------------- applying an import
async function importedProject() {
  const p = newProject({ course: { name: 'Data Mining' } });
  const store = new ProjectStore(p); store.held = true; // no writes: the test reads the layout
  const deck1 = await makePptx([{ title: 'Introduction to Data Mining', bullets: ['KDD'], notes: 'Hello' }]);
  const deck2 = await makePptx([{ title: 'Getting to Know Your Data', bullets: ['Attribute types'] }]);
  const hw1 = await docx('# Homework 1\n\n1. Define support and confidence for an association rule.\n2. Compute the support of {milk, bread} in the table of transactions below.\n3. Explain why the Apriori property lets an algorithm prune candidate itemsets.\n4. List the frequent itemsets for a minimum support of 40 percent.\n');
  const row = (path, kind, chapter, extra = {}) => ({ path: `sources/course-src/${path}`, name: path, ext: path.split('.').pop(), kind, chapter, action: 'new', text: extra.text ?? '', blob: extra.blob ?? new Blob([extra.text ?? '']) });
  const rows = [
    row('syllabus.md', 'syllabus', '', { text: '# Syllabus\n\nWeek 1: Intro\nWeek 2: Data\n' }),
    row('week1_intro.pptx', 'slides', 'new:Introduction to Data Mining', { blob: deck1 }),
    row('week2_data.pptx', 'slides', 'new:Getting to Know Your Data', { blob: deck2 }),
    row('hw1.docx', 'homework', 'new:Introduction to Data Mining', { blob: hw1, text: '# Homework 1' }),
    row('hw2.md', 'homework', 'new:Getting to Know Your Data', { text: '# Homework 2\n\n1. Name four attribute types.\n' }),
    row('lab1.md', 'lab', 'new:Introduction to Data Mining', { text: '# Lab 1\n\nInstall Python.\n' }),
    row('quiz1.md', 'quiz', 'new:Introduction to Data Mining', { text: '# Quiz 1\n\n1. What is KDD?\n' }),
    row('notes_week1.md', 'script', 'new:Introduction to Data Mining', { text: 'Welcome to data mining.\n' }),
    row('readings.pdf', 'reference', 'new:Introduction to Data Mining'),
  ];
  const out = await applyImport(store, rows, { newChapters: ['new:Introduction to Data Mining', 'new:Getting to Know Your Data'] });
  return { p, store, out, hw1, rows };
}

test('apply: chapters, stages and the folder layout of an import', async () => {
  const { p, out } = await importedProject();
  assert.deepEqual(p.chapters.map(c => c.title), ['Introduction to Data Mining', 'Getting to Know Your Data']);
  assert.equal(out.chapters.length, 2); assert.deepEqual(out.skipped, []);
  assert.deepEqual(JSON.parse(p.chaptersStage.output).map(c => c.title), ['Introduction to Data Mining', 'Getting to Know Your Data']);
  const { files, decks, meta } = serialize(p);
  const [c1, c2] = p.chapters;
  const d1 = meta.chapters[0].$dir, d2 = meta.chapters[1].$dir;
  assert.equal(d1, 'chapters/01-introduction-to-data-mining'); assert.equal(d2, 'chapters/02-getting-to-know-your-data');
  assert.ok(decks[`${d1}/slides.pptx`] && decks[`${d2}/slides.pptx`], 'decks');
  assert.equal(decks[`${d1}/homework.docx`]?.format, 'docx', 'a Word homework stays Word');
  assert.match(files[`${d2}/homework.md`], /Homework 2/);
  assert.match(files[`${d1}/lab.md`], /Lab 1/);
  assert.match(files[`${d1}/quiz.md`], /Quiz 1/, 'a Markdown quiz is kept as text');
  assert.match(files[`${d1}/script.md`], /Welcome/);
  assert.match(files['design/syllabus.md'], /Week 2: Data/);
  assert.ok(files['design/chapters.json']);
  for (const key of ['foundation.syllabus', `chapters.${c1.id}.slides`, `chapters.${c1.id}.homework`, `chapters.${c2.id}.homework`, `chapters.${c1.id}.quiz`]) {
    assert.equal(meta.stages[key].origin, 'import', key); assert.match(meta.stages[key].sourcePath, /^sources\/course-src\//, key); assert.equal(meta.stages[key].status, 'done', key);
  }
  assert.equal(meta.stages[`chapters.${c1.id}.slides`].sourcePath, 'sources/course-src/week1_intro.pptx');
  assert.equal(JSON.parse(c1.stages.slides.output).slides[0].title, 'Introduction to Data Mining');
  assert.equal(c1.stages.reference, undefined, 'references stay in sources/');
  assert.ok(p.audit.filter(e => e.type === 'import').length >= 8);
  assert.equal(importMessage(p, out.stages, 9), 'import: 9 files → syllabus, 01 slides+homework+lab+quiz+script, 02 slides+homework');
});

test('apply: a new version of an imported file replaces the stage and keeps history', async () => {
  const { p, store } = await importedProject();
  const c1 = p.chapters[0]; const st = c1.stages.homework; const v0 = st.version;
  const cands = importedStages(p);
  const hw = cands.find(c => c.key === `chapters.${c1.id}.homework`);
  assert.match(hw.text, /Define support and confidence/);
  const hw1b = await docx('# Homework 1\n\n1. Define support and confidence for an association rule.\n2. Compute the support of {milk, bread} in the table of transactions below.\n3. Explain why the Apriori property lets an algorithm prune candidate itemsets.\n4. List the frequent itemsets for a minimum support of 40 percent.\n' + '5. Give one rule with confidence above 80 percent.\n');
  const newText = (await extractText('hw1.docx', hw1b)).text;
  const v = versionOf({ sourcePath: 'sources/course-src/hw1.docx', text: newText }, cands);
  assert.equal(v.key, hw.key); assert.equal(v.why, 'path');
  const sim = versionOf({ sourcePath: 'sources/elsewhere/homework_one.docx', text: newText }, cands);
  assert.equal(sim?.key, hw.key, 'found by text too');
  const row = { path: 'sources/course-src/hw1.docx', name: 'hw1.docx', ext: 'docx', kind: 'version', chapter: '', action: 'version', version: v, text: newText, blob: hw1b };
  assert.equal(targetKey(row), hw.key);
  const out = await applyImport(store, [row]);
  assert.deepEqual(out.stages.map(s => s.key), [hw.key]);
  assert.equal(st.version, v0 + 1); assert.equal(st.history.length, 1); assert.equal(st.origin, 'import');
  assert.match(JSON.parse(st.output).text, /above 80 percent/);
  assert.equal(p.chapters.length, 2, 'no new chapter');
});
