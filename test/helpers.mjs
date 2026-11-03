// helpers.mjs — fixtures shared by the tests: a project with every kind of stage, temp folders, a config dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newProject, emptyStage } from '../js/model.js';

export function tmpdir(prefix = 'ia-test-') { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
export function isolateConfig() { process.env.IA_CONFIG_DIR = tmpdir('ia-config-'); process.env.IA_PROJECTS_ROOT = tmpdir('ia-root-'); }

const done = (output, extra = {}) => ({ ...emptyStage(), status: 'done', output, version: 1, ranAt: '2026-11-01T10:00:00.000Z', outputHash: 'abcd1234', transcript: [{ agent: 'A', role: 'assistant', content: 'hi', usage: { total_tokens: 3 } }], prompt: { user: 'u', agents: [{ name: 'A', system: 's' }] }, history: [{ version: 0, output: 'old', at: null, reason: 'model output' }], ...extra });

export function sampleProject() {
  const p = newProject({ course: { name: 'Intro to Agents', subject: 'CS', audience: 'juniors' } });
  p.foundation.objectives = done('# Objectives\n\n- one\n- two\n');
  p.foundation.syllabus = done('Week 1: agents\nWeek 2: tools', { edited: true });
  p.foundation.learners = { ...emptyStage() };
  p.chaptersStage = done(JSON.stringify([{ title: 'What is an agent?', description: 'd1' }, { title: '工具 & Tools', description: 'd2' }], null, 2));
  p.chapters = [
    { id: 'chaaa1111', title: 'What is an agent?', description: 'd1', stages: { outline: done('{"slides":[{"title":"x"}]}'), slides: done(JSON.stringify({ format: 'pptx', sha: 'a'.repeat(64), name: 'slides.pptx', bytes: 10, slides: [{ slide_id: 1, title: 'x', bullets: [], notes: '' }] }, null, 2)), script: done('Narration text'), quiz: done('[{"q":1}]'), homework: { ...emptyStage(), status: 'error', error: 'boom' } } },
    { id: 'chbbb2222', title: '工具 & Tools', description: 'd2', stages: {} },
  ];
  p.exams.midterm = done('Midterm questions');
  p.textbook = { name: 'book.pdf', chars: 12, chunks: [{ id: 0, text: 'chunk' }] };
  p.overrides = { model: 'glm-5-3' };
  p.deck = { template: 'builtin:ocean', palette: { primary: '#123456' } };
  p.audit = [{ id: 1, ts: '2026-11-01T10:00:00.000Z', type: 'project', note: 'created' }, { id: 2, ts: '2026-11-01T10:01:00.000Z', type: 'stage_done', stage: 'Objectives', where: 'course' }];
  p.extraField = { kept: true };
  return p;
}
