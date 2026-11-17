// What a new user runs into: commits under their own git name, a LaTeX file or loose notes in an opened folder,
// font stand-ins of the trimmed editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import { gitUser } from '../server/vcs.mjs';
import { ruleClassify } from '../js/import/classify.js';

test('git identity from a config file: [user] name / email, comments and quotes', () => {
  const f = path.join(tmpdir(), 'gitconfig');
  fs.writeFileSync(f, '[core]\n\tname = not-me\n[user]\n\tname = "Ada Lovelace" ; comment\n\temail = ada@example.edu\n[alias]\n\tst = status\n');
  assert.deepEqual(gitUser(f), { name: 'Ada Lovelace', email: 'ada@example.edu' });
  assert.deepEqual(gitUser(path.join(tmpdir(), 'missing')), {});
});

test('opening a folder: LaTeX stays LaTeX, loose notes are not a chapter, numbered notes are a script', () => {
  assert.equal(ruleClassify('hw/hw2.tex', '\\section{Homework 2}').kind, 'reference');
  assert.equal(ruleClassify('notes.md', '# Notes').kind, 'reference');
  const s = ruleClassify('week3_notes.md', '# Week 3'); assert.equal(s.kind, 'script'); assert.equal(s.chapterNo, 3);
  assert.equal(ruleClassify('lecture01_transcript.md', '').kind, 'script');
});

// ---------------------------------------------------------------- a course rebuilt from scattered slides
import { newProject, emptyStage } from '../js/model.js';
import { runDerive, deriveActions } from '../js/agent/derive.js';

const deck = (title, bullets) => ({ ...emptyStage(), status: 'done', output: JSON.stringify({ format: 'pptx', sha: 'a'.repeat(64), name: 'slides.pptx', slides: [{ slide_id: 1, title, bullets, notes: '' }] }), sourcePath: `${title}.pptx` });
function slidesCourse() {
  const p = newProject({ course: { name: 'Old slides' } });
  p.chapters = [
    { id: 'chA', title: 'Classification', description: '', stages: { slides: deck('Classification', ['Logistic regression']) } },
    { id: 'chB', title: 'Why data science', description: '', stages: { slides: deck('Why data science', ['Lifecycle']) } },
    { id: 'chC', title: 'Empty', description: '', stages: {} },
  ];
  const store = { project: p, foundationStage: id => p.foundation[id] || (p.foundation[id] = emptyStage()), log: () => {} };
  return { p, store };
}

test('rebuild the course design from slides: every deck once, in teaching order; keeping it reorders and fills basics', async () => {
  const { p, store } = slidesCourse();
  assert.deepEqual(deriveActions(null, p), ['design'], 'offered while there is no syllabus');
  let asked = '';
  const llm = { chat: async msgs => { asked = msgs[1].content; return { text: JSON.stringify({
    course: { name: 'Intro to Data Science', subject: 'Data science', level: 'Undergraduate', audience: 'sophomores', description: 'A first course.' },
    chapters: [{ id: 'chB', title: 'Introduction to Data Science', description: 'Motivation' }, { id: 'bogus', title: 'x' }, { id: 'chA', title: 'Classification', description: 'Classifiers' }, { id: 'chB', title: 'dup' }],
    gaps: [{ title: 'Clustering', why: 'No unsupervised learning' }], objectives: ['1. Describe the lifecycle', 'Train a classifier'], syllabus: '# Syllabus\n\n| Week | Topic |' }) }; } };
  const r = await runDerive('design', { owner: null, store, llm, model: 'm' });
  assert.match(asked, /Deck id chA[\s\S]*Logistic regression/); assert.doesNotMatch(asked, /Deck id chC/);
  const chs = JSON.parse(r.overlay.get('design/chapters.json'));
  assert.deepEqual(chs.map(c => c.title), ['Introduction to Data Science', 'Classification', 'Empty'], 'unknown and repeated ids dropped, chapters without slides kept at the end');
  assert.match(r.overlay.get('design/syllabus.md'), /## Possible additions[\s\S]*\*\*Clustering\*\*/);
  assert.match(r.overlay.get('design/learning_objectives.md'), /^# Learning objectives\n\n1\. Describe the lifecycle\n2\. Train a classifier/m);
  assert.match(r.summary, /Suggested course name: “Intro to Data Science”/);
  // what keeping does: the kept list gives order, titles and descriptions
  p.chaptersStage = { ...emptyStage(), output: r.overlay.get('design/chapters.json') };
  r.beforeCommit(store);
  assert.deepEqual(p.chapters.map(c => c.id), ['chB', 'chA', 'chC']);
  assert.equal(p.chapters[0].title, 'Introduction to Data Science'); assert.equal(p.chapters[1].description, 'Classifiers');
  assert.equal(p.course.name, 'Old slides', 'a name the user gave is not replaced'); assert.equal(p.course.audience, 'sophomores');
});

