// The pipeline's model calls: a JSON-mode request answered with nothing is asked once more (chapter extraction).
import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, emptyStage } from '../js/model.js';

const { ProjectStore } = await import('../js/state.js');
const { Pipeline } = await import('../js/pipeline.js');

function pipelineWith(replies) {
  const p = newProject({ course: { name: 'Retry' } });
  p.foundation.syllabus = { ...emptyStage(), status: 'done', output: 'Week 1: Agents\nWeek 2: Tools', version: 1 };
  const store = new ProjectStore(p); store.save = () => {}; store.flush = async () => {};
  const pipe = new Pipeline(store); const calls = [];
  Object.defineProperty(pipe, 'client', { get: () => ({ chat: async (messages, o) => { calls.push(o.json); const text = replies.shift() ?? ''; o.onToken?.(text); return { text, usage: { prompt_tokens: 10, completion_tokens: text.length, total_tokens: 10 + text.length }, durationMs: 1 }; } }) });
  return { p, pipe, calls };
}

test('chapter extraction asks again once when the model returns empty content', async () => {
  const { p, pipe, calls } = pipelineWith(['', '[{"title":"Agents","description":"a"},{"title":"Tools","description":"t"}]']);
  await pipe.runChaptersExtraction();
  assert.deepEqual(p.chapters.map(c => c.title), ['Agents', 'Tools']);
  assert.deepEqual(calls, [true, true]);
  const call = p.audit.find(e => e.type === 'llm_call');
  assert.equal(call.retried, true); assert.equal(call.status, 'ok'); assert.equal(call.promptTokens, 20, 'both calls are counted');
});

test('a second empty reply still fails clearly', async () => {
  const { p, pipe, calls } = pipelineWith(['', '  ']);
  await assert.rejects(pipe.runChaptersExtraction());
  assert.equal(calls.length, 2); assert.equal(p.chaptersStage.status, 'error');
});
