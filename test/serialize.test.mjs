import test from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize, slugify, fnv, fileOwner, binaryOf } from '../js/fs/serialize.js';
import { sampleProject } from './helpers.mjs';
import { newProject } from '../js/model.js';
import { merge3, adoptInPlace } from '../js/fs/merge.js';

const roundTrip = p => { const { files } = serialize(p); return { files, back: deserialize(f => f in files ? files[f] : null) }; };
const norm = p => JSON.parse(JSON.stringify(p));

test('project → folder → project is lossless', () => {
  const p = sampleProject(); const { files, back } = roundTrip(p);
  assert.deepEqual(back, norm(p));
  assert.equal(files['design/learning_objectives.md'], p.foundation.objectives.output);
  assert.equal(files['design/chapters.json'], p.chaptersStage.output);
  assert.equal(files['chapters/01-what-is-an-agent/outline.json'], p.chapters[0].stages.outline.output);
  assert.equal(files['chapters/01-what-is-an-agent/script.md'], 'Narration text');
  assert.equal(files['exams/midterm_exam.md'], 'Midterm questions');
  assert.ok(files['.studio/audit.jsonl'].endsWith('\n'));
  assert.ok(!('design/learner_analysis.md' in files), 'empty outputs write no file');
});

test('a fresh project and a JSON round trip of the files map stay equal', () => {
  const p = newProject({ course: { name: 'Empty' } });
  assert.deepEqual(roundTrip(p).back, norm(p));
  const once = roundTrip(sampleProject()).back;
  assert.deepEqual(roundTrip(once).back, once);
});

test('the deck is a pptx file in the chapter folder, its manifest stays in the sidecar', () => {
  const { files, decks } = serialize(sampleProject());
  assert.deepEqual(decks['chapters/01-what-is-an-agent/slides.pptx'], { chapterId: 'chaaa1111', sha: 'a'.repeat(64), format: 'pptx' });
  assert.ok(!Object.keys(files).some(f => f.startsWith('chapters/') && f.includes('slides.')));
});

test('light load leaves out prompts, transcripts and history', () => {
  const { files } = serialize(sampleProject());
  const light = deserialize(f => files[f] ?? null, { light: true });
  assert.equal(light.foundation.objectives.output, '# Objectives\n\n- one\n- two\n');
  assert.equal(light.foundation.objectives.transcript, undefined);
  assert.equal(light.foundation.objectives.status, 'done');
});

test('slugs and hashes', () => {
  assert.equal(slugify('工具 & Tools'), '工具-tools');
  assert.equal(fnv('abc'), '1a47e90b');
});

test('three-way merge keeps both sides\' units', () => {
  const base = norm(sampleProject());
  const theirs = norm(base); theirs.foundation.objectives.output = 'disk edit'; theirs.audit.push({ id: 3, type: 'edit', note: 'disk' });
  const ours = norm(base); ours.chapters[0].stages.script.output = 'browser edit'; ours.audit.push({ id: 3, type: 'edit', note: 'browser' });
  const m = merge3(base, theirs, ours);
  assert.equal(m.foundation.objectives.output, 'disk edit');
  assert.equal(m.chapters[0].stages.script.output, 'browser edit');
  assert.deepEqual(m.audit.slice(-2).map(e => [e.id, e.note]), [[3, 'browser'], [4, 'disk']]);
  const live = norm(ours); const ref = live.chapters[0].stages.script;
  adoptInPlace(live, m);
  assert.equal(live.foundation.objectives.output, 'disk edit');
  assert.equal(live.chapters[0].stages.script, ref, 'stage objects keep their identity');
});

test('a stage converted to Word is a .docx in the chapter folder; its text index stays in the sidecar', () => {
  const p = sampleProject(); const st = p.chapters[0].stages;
  st.homework = { ...st.script, output: JSON.stringify({ format: 'docx', sha: 'b'.repeat(64), name: 'homework.docx', bytes: 9, text: '# HW\n\n1. one\n' }, null, 2), history: [{ version: 0, output: '# HW md', at: null, reason: 'user edit' }] };
  const { files, decks, meta } = serialize(p);
  assert.deepEqual(decks['chapters/01-what-is-an-agent/homework.docx'], { chapterId: 'chaaa1111', sha: 'b'.repeat(64), format: 'docx' });
  assert.ok(!('chapters/01-what-is-an-agent/homework.md' in files) && !('chapters/01-what-is-an-agent/homework.json' in files));
  assert.ok(meta.files.includes('chapters/01-what-is-an-agent/homework.docx'));
  assert.deepEqual(fileOwner(meta, 'chapters/01-what-is-an-agent/homework.docx'), { key: 'chapters.chaaa1111.homework', kind: 'doc', chapterId: 'chaaa1111', stageId: 'homework' });
  assert.deepEqual(roundTrip(p).back, norm(p));
  assert.equal(deserialize(f => files[f] ?? null, { light: true }).chapters[0].stages.homework.output, '');
  // back to Markdown: the .docx leaves the layout, homework.md comes back
  st.homework.output = '# HW\n';
  const again = serialize(p);
  assert.equal(again.files['chapters/01-what-is-an-agent/homework.md'], '# HW\n');
  assert.ok(!Object.keys(again.decks).some(f => f.endsWith('.docx')));
});

test('binaryOf only accepts deck and Word manifests', () => {
  assert.deepEqual(binaryOf(JSON.stringify({ format: 'docx', sha: 'x' })), { format: 'docx', sha: 'x' });
  for (const o of ['', '# md', '{"format":"pdf","sha":"x"}', '{"format":"docx"}', '[1]', null]) assert.equal(binaryOf(o), null, String(o));
});
