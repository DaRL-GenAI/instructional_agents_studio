// Project folders: one git commit per save, conflicts, edits made on disk, import of a browser export, duplicate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir, isolateConfig, sampleProject } from './helpers.mjs';

isolateConfig();
const { Projects } = await import('../server/projects.mjs');
const vcs = await import('../server/vcs.mjs');
const media = await import('../server/media.mjs');
const norm = p => JSON.parse(JSON.stringify(p));
const waitFor = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('create, then one commit per save with a readable message', async () => {
  const projects = new Projects({ watch: false });
  const p = sampleProject(); const dir = path.join(tmpdir(), 'c1');
  const r = await projects.create(p, dir);
  assert.deepEqual(r.project, norm(p), 'what was saved loads back unchanged');
  assert.equal(fs.readFileSync(path.join(dir, 'design/learning_objectives.md'), 'utf8'), p.foundation.objectives.output);
  assert.ok(fs.existsSync(path.join(dir, '.gitignore')));
  let log = await vcs.log(dir); assert.equal(log.length, 1); assert.match(log[0].message, /^init: Intro to Agents/);

  const q = norm(r.project); q.foundation.objectives.output = '# Objectives\n\nrewritten'; q.audit.push({ id: 3, type: 'edit', stage: 'Objectives' });
  const s1 = await projects.save(q.id, q, r.head);
  log = await vcs.log(dir); assert.equal(log.length, 2); assert.equal(log[0].oid, s1.head); assert.equal(log[0].message, 'edit: design/learning_objectives.md (+2)');
  const same = await projects.save(q.id, q, s1.head); assert.equal(same.head, s1.head, 'no change, no commit');
  q.chapters[0].stages.homework = { ...q.chapters[0].stages.homework, status: 'done', output: '# Homework' }; q.audit.push({ id: 4, type: 'stage_done', stage: 'Homework' });
  const s2 = await projects.save(q.id, q, s1.head);
  assert.match((await vcs.log(dir))[0].message, /^gen: chapters\/01-what-is-an-agent\/homework\.md/);
  // renaming a chapter moves its files; the old ones go
  q.chapters[0].title = 'Agents, defined'; await projects.save(q.id, q, s2.head);
  assert.ok(fs.existsSync(path.join(dir, 'chapters/01-agents-defined/homework.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'chapters/01-what-is-an-agent')));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '', 'the work tree is clean after a save');
});

test('a save based on a stale head is refused with the current project', async () => {
  const projects = new Projects({ watch: false });
  const r = await projects.create(sampleProject(), path.join(tmpdir(), 'c2'));
  const a = norm(r.project); a.course.notes = 'first'; const s = await projects.save(a.id, a, r.head);
  const b = norm(r.project); b.course.notes = 'second';
  await assert.rejects(projects.save(b.id, b, r.head), e => e.status === 409 && e.body.head === s.head && e.body.project.course.notes === 'first');
});

test('an edit made on disk becomes a version (history + audit) and a commit, and is announced', async () => {
  const events = []; const projects = new Projects({ onChange: e => events.push(e) });
  const dir = path.join(tmpdir(), 'c3'); const r = await projects.create(sampleProject(), dir);
  const f = path.join(dir, 'chapters/01-what-is-an-agent/script.md');
  fs.writeFileSync(f, 'Narration, edited in VS Code');
  const ev = await waitFor(() => events.find(e => e.source === 'disk'));
  assert.deepEqual(ev.paths, ['chapters/01-what-is-an-agent/script.md']);
  const { project, head } = await projects.load(r.project.id);
  const st = project.chapters[0].stages.script;
  assert.equal(st.output, 'Narration, edited in VS Code'); assert.equal(st.version, 2); assert.equal(st.edited, true);
  assert.equal(st.history.at(-1).output, 'Narration text');
  assert.match(project.audit.at(-1).note, /edited on disk/);
  assert.equal((await vcs.log(dir))[0].oid, head); assert.match((await vcs.log(dir))[0].message, /^edit: chapters\/01-what-is-an-agent\/script\.md \(on disk\)/);
  // the app's own writes are not mistaken for outside edits
  const n = events.length; const q = norm(project); q.course.notes = 'from the app'; await projects.save(q.id, q, head);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(events.slice(n).filter(e => e.source === 'disk').length, 0);
  await projects.close();
});

test('decks: versions in .studio/decks, the current one as slides.pptx (committed), a replaced file is reported', async () => {
  const projects = new Projects({ watch: false });
  const p = sampleProject(); const dir = path.join(tmpdir(), 'c4');
  const deck = Buffer.from('PK fake pptx bytes'); const sha = crypto.createHash('sha256').update(deck).digest('hex');
  const m = JSON.parse(p.chapters[0].stages.slides.output); m.sha = sha; p.chapters[0].stages.slides.output = JSON.stringify(m);
  fs.mkdirSync(dir); media.storeDeckFile(dir, 'chaaa1111', deck);
  const r = await projects.create(p, dir);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'chapters/01-what-is-an-agent/slides.pptx')), deck);
  assert.ok(execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).includes('chapters/01-what-is-an-agent/slides.pptx'));
  assert.ok(!execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).includes('.studio/decks'));
  assert.deepEqual(r.external, []);
  fs.writeFileSync(path.join(dir, 'chapters/01-what-is-an-agent/slides.pptx'), 'PK edited in PowerPoint');
  const again = await projects.load(r.project.id);
  assert.equal(again.external.length, 1); assert.equal(again.external[0].chapterId, 'chaaa1111');
  assert.ok(media.deckFile(dir, 'chaaa1111', again.external[0].sha), 'the new file is available as a deck version');
  // a save that still names the old deck does not overwrite the user's file
  await projects.save(r.project.id, norm(again.project), again.head);
  assert.equal(fs.readFileSync(path.join(dir, 'chapters/01-what-is-an-agent/slides.pptx'), 'utf8'), 'PK edited in PowerPoint');
});

test('media bundles round trip; chapter media lands in build/ (not committed)', async () => {
  const dir = tmpdir(); const parts = [Buffer.from('abc'), Buffer.from([1, 2, 3, 4])];
  const header = { v: 1, skel: { video: { $bin: 0 }, audios: [{ slide_id: 1, buffer: { $bin: 1 }, seconds: 2 }] }, parts: [{ as: 'blob', type: 'video/webm', len: 3 }, { as: 'ab', len: 4 }] };
  const body = Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), ...parts]);
  media.put(dir, 'ch1:anim_video', body);
  assert.ok(fs.existsSync(path.join(dir, 'build/media/ch1/anim_video.0.webm')));
  assert.deepEqual(media.get(dir, 'ch1:anim_video'), body);
  assert.deepEqual(media.keys(dir), ['ch1:anim_video']);
  media.del(dir, 'ch1:anim_video'); assert.equal(media.get(dir, 'ch1:anim_video'), null);
  assert.throws(() => media.put(dir, `ch1:deck:${'0'.repeat(64)}`, body));
});

test('import a project exported from the browser edition (decks inside), keeping the original', async () => {
  const projects = new Projects({ watch: false });
  const p = sampleProject(); const deck = Buffer.from('PK deck'); const sha = crypto.createHash('sha256').update(deck).digest('hex');
  const m = JSON.parse(p.chapters[0].stages.slides.output); m.sha = sha; p.chapters[0].stages.slides.output = JSON.stringify(m);
  delete p.exams.final; p.schema = 1; // an older save: migrate() fills it in
  const json = JSON.stringify({ ...p, decks: { chaaa1111: { sha, data: deck.toString('base64') } } });
  const dir = path.join(tmpdir(), 'imported');
  const r = await projects.importJson(json, dir, { source: 'intro_project.json' });
  assert.notEqual(r.project.id, p.id); assert.ok(r.project.exams.final, 'migrated');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'chapters/01-what-is-an-agent/slides.pptx')), deck);
  assert.equal(fs.readFileSync(path.join(dir, '.studio/backup/intro_project.json'), 'utf8'), json);
  assert.match((await vcs.log(dir))[0].message, /^import: intro_project\.json/);
  await assert.rejects(projects.importJson(json, dir), e => e.status === 409, 'never over an existing course');
  await assert.rejects(projects.importJson('{"nope":1}', path.join(tmpdir(), 'x')), e => e.status === 400);
});

test('duplicate copies the folder under a new id and a fresh history', async () => {
  const projects = new Projects({ watch: false });
  const r = await projects.create(sampleProject(), path.join(tmpdir(), 'orig'));
  const d = await projects.duplicate(r.project.id);
  assert.equal(d.dir, `${r.dir}-copy`); assert.notEqual(d.project.id, r.project.id); assert.equal(d.project.name, 'Intro to Agents (copy)');
  assert.equal(d.project.foundation.objectives.output, r.project.foundation.objectives.output);
  assert.equal((await vcs.log(d.dir)).length, 1);
});
