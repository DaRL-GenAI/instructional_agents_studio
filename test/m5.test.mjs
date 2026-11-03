// M5: the TeX log parser and the compile endpoint (a fake engine, and tectonic when it is installed); which stages are
// out of date after an upstream change; per-file history and restore; live Word operations; drafting from slides.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir, isolateConfig, sampleProject } from './helpers.mjs';

isolateConfig();
const { startServer } = await import('../server/http.mjs');
const tex = await import('../server/tex.mjs');
const vcs = await import('../server/vcs.mjs');
const linkage = await import('../js/linkage.js');
const { parseDocOps, describeDocOps } = await import('../js/agent/live.js');
const { runDerive, deriveActions } = await import('../js/agent/derive.js');
const { emptyStage } = await import('../js/model.js');

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* raw */ } resolve({ status: res.statusCode, headers: res.headers, buf, json }); }); });
    r.on('error', reject); if (body !== undefined) r.write(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)); r.end();
  });
}

// ---------------------------------------------------------------- TeX
const LOG = `This is XeTeX, Version 3.141592653
(./main.tex
LaTeX2e <2021-11-15> (article.cls (size10.clo)) (./sections/intro.tex
! Undefined control sequence.
l.4 \\foo
        {}
)
! Missing $ inserted.
<inserted text>
                $
l.12 x^2

! Emergency stop.
No pages of output.`;

test('the TeX log parser: classic "! … l.N" errors with the file they happened in, file:line:error lines, tectonic lines', () => {
  const e = tex.parseTexLog(LOG);
  assert.deepEqual(e.map(x => [x.file, x.line, x.message]), [['sections/intro.tex', 4, 'Undefined control sequence'], ['sections/intro.tex', 12, 'Missing $ inserted']]);
  const fl = tex.parseTexLog('./main.tex:7: Undefined control sequence.\nerror: main.tex:7: Undefined control sequence\n./main.tex:9: LaTeX Error: Environment itemiz undefined.');
  assert.deepEqual(fl.map(x => [x.file, x.line, x.message]), [['main.tex', 7, 'Undefined control sequence'], ['main.tex', 9, 'LaTeX Error: Environment itemiz undefined']]);
  assert.deepEqual(tex.parseTexLog('Output written on main.pdf (1 page).'), []);
});

// a fake engine with tectonic's arguments: "\error" in the source fails with a log, "\slow" hangs, else a PDF
const fakeDir = tmpdir('ia-fake-tex-');
const FAKE = path.join(fakeDir, 'tectonic');
fs.writeFileSync(FAKE, `#!/bin/sh
out=""; while [ $# -gt 1 ]; do [ "$1" = "--outdir" ] && out="$2"; shift; done
f="$1"; n=$(basename "$f" .tex)
if grep -q 'slow' "$f"; then sleep 5; fi
if grep -q 'error' "$f"; then line=$(grep -n 'error' "$f" | head -1 | cut -d: -f1); printf '(./%s\\n! Undefined control sequence.\\nl.%s \\\\error\\n' "$f" "$line" > "$out/$n.log"; echo "error: $f:$line: Undefined control sequence" >&2; exit 1; fi
[ -f "$(dirname "$f")/fig.txt" ] || [ -f fig.txt ] || { echo "no fig" >&2; exit 1; }
pwd > "$out/$n.log"; printf '%%PDF-1.4 fake' > "$out/$n.pdf"
`, { mode: 0o755 });

const root = tmpdir();
const app = await startServer({ dir: path.join(root, 'course'), port: 0, editorDir: null, watch: false, quiet: true, texEngine: { engine: 'tectonic', bin: FAKE } });
test.after(() => app.close());
const auth = { Authorization: `Bearer ${app.token}` };
const J = { ...auth, 'Content-Type': 'application/json' };
const created = (await req(app.port, { method: 'POST', path: '/api/projects', headers: J, body: { project: sampleProject() } })).json;
const P = `/api/projects/${created.project.id}`; const dir = created.dir;
const put = (f, data) => req(app.port, { method: 'PUT', path: `${P}/files/${f}`, headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: data });
const compile = f => req(app.port, { method: 'POST', path: `${P}/tex`, headers: J, body: { path: f } });

test('compile: runs in a job copy of the file’s folder, PDF and log into build/, errors parsed, the last good PDF kept', async () => {
  await put('notes/fig.txt', 'figure'); await put('notes/lecture.tex', '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n');
  let r = await compile('notes/lecture.tex');
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.pdf, 'build/notes/lecture.pdf'); assert.deepEqual(r.json.errors, []);
  assert.equal(fs.readFileSync(path.join(dir, 'build/notes/lecture.pdf'), 'utf8'), '%PDF-1.4 fake');
  assert.match(fs.readFileSync(path.join(dir, 'build/notes/lecture.log'), 'utf8'), /\.studio\/jobs\/tex-[0-9a-f]{12}\/src/, 'cwd is the job copy');
  assert.ok(!fs.existsSync(path.join(dir, 'notes/lecture.pdf')), 'nothing is written next to the source');
  await put('notes/lecture.tex', '\\documentclass{article}\n\\begin{document}\nHi \\error\n\\end{document}\n');
  r = await compile('notes/lecture.tex');
  assert.equal(r.json.ok, false); assert.equal(r.json.pdf, 'build/notes/lecture.pdf', 'the last good PDF stays');
  assert.deepEqual(r.json.errors.map(e => [e.line, e.message, e.here]), [[3, 'Undefined control sequence', true]]);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '', 'build/ and .studio/jobs stay out of git');
  assert.equal((await compile('notes/fig.txt')).status, 400);
  assert.equal((await compile('../x.tex')).status, 400);
  assert.equal((await compile('missing.tex')).status, 404);
});

test('compile: a hung engine is stopped at the time limit; no engine → missing', async () => {
  fs.mkdirSync(path.join(dir, 'slow'), { recursive: true }); fs.writeFileSync(path.join(dir, 'slow/s.tex'), 'slow');
  const t0 = Date.now(); const r = await tex.compile(dir, 'slow/s.tex', { tex: { engine: 'tectonic', bin: FAKE }, timeout: 400 });
  assert.ok(Date.now() - t0 < 3000); assert.equal(r.ok, false); assert.match(r.errors[0].message, /Stopped after/);
  assert.equal((await tex.compile(dir, 'slow/s.tex', { tex: null })).missing, true);
  assert.equal(tex.findTex({ IA_TECTONIC: FAKE }).bin, fs.realpathSync(FAKE));
});

const real = tex.findTex();
test('compile with the installed engine (tectonic or latexmk): a PDF, then a real error with its line', { skip: !real && 'no LaTeX engine', timeout: 180000 }, async () => {
  const d = tmpdir('ia-tex-real-');
  fs.writeFileSync(path.join(d, 'a.tex'), '\\documentclass{article}\n\\begin{document}\nHello $x^2$.\n\\end{document}\n');
  let r = await tex.compile(d, 'a.tex', { tex: real, timeout: 150000 });
  assert.equal(r.ok, true, JSON.stringify(r.errors)); assert.ok(fs.readFileSync(path.join(d, 'build/a.pdf')).subarray(0, 4).toString() === '%PDF');
  fs.writeFileSync(path.join(d, 'a.tex'), '\\documentclass{article}\n\\begin{document}\nHello\n\\foo{}\n\\end{document}\n');
  r = await tex.compile(d, 'a.tex', { tex: real, timeout: 150000 });
  assert.equal(r.ok, false); assert.equal(r.errors[0].line, 4); assert.match(r.errors[0].message, /Undefined control sequence/);
});

// ---------------------------------------------------------------- history and restore
test('per-file history, a file at a commit, and restore as a new commit (plain files only)', async () => {
  await put('notes/plan.md', 'one\n'); await put('notes/plan.md', 'two\n'); await put('notes/other.md', 'x');
  const h = (await req(app.port, { path: `${P}/history/notes/plan.md`, headers: auth })).json.commits;
  assert.deepEqual(h.map(c => c.message), ['edit: notes/plan.md', 'edit: notes/plan.md']);
  const old = await req(app.port, { path: `${P}/at/${h[1].oid}/notes/plan.md`, headers: auth });
  assert.equal(old.buf.toString(), 'one\n');
  assert.equal((await req(app.port, { path: `${P}/at/${h[1].oid}/notes/other.md`, headers: auth })).status, 404);
  const r = await req(app.port, { method: 'POST', path: `${P}/restore`, headers: J, body: { path: 'notes/plan.md', oid: h[1].oid } });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(dir, 'notes/plan.md'), 'utf8'), 'one\n');
  assert.equal((await vcs.log(dir, 1))[0].message, `edit: restore notes/plan.md @${h[1].oid.slice(0, 7)}`);
  assert.equal((await vcs.fileLog(dir, 'notes/plan.md')).length, 3);
  const head = (await vcs.log(dir, 1))[0].oid;
  const m = await req(app.port, { method: 'POST', path: `${P}/restore`, headers: J, body: { path: 'design/learning_objectives.md', oid: head } });
  assert.equal(m.status, 409, 'a stage file is restored through its stage'); assert.equal(m.json.managed, true);
  assert.equal((await req(app.port, { method: 'POST', path: `${P}/restore`, headers: J, body: { path: 'notes/plan.md', oid: 'nope' } })).status, 400);
});

// ---------------------------------------------------------------- linkage
test('out of date: an upstream version newer than the one a stage was made from; provenance for generated stages', () => {
  const p = sampleProject(); const ch = p.chapters[0];
  ch.stages.outline.version = 2; ch.stages.slides.basis = { 'chapters.chaaa1111.outline': 2, 'foundation.objectives': 1 };
  ch.stages.script.basis = { 'chapters.chaaa1111.slides': 1 };
  assert.deepEqual(linkage.changedUpstream(p, 'chapters.chaaa1111.slides'), []);
  linkage.stamp(p, ch.stages.script); assert.deepEqual(ch.stages.script.basis, { 'chapters.chaaa1111.slides': 1 });
  // the instructor edits the outline: the slides are out of date, and through nothing else
  ch.stages.outline.history.push({ version: 2, output: ch.stages.outline.output, reason: 'model output' });
  ch.stages.outline.output = '{"slides":[{"title":"x"},{"title":"y"}]}'; ch.stages.outline.version = 3;
  const c = linkage.changedUpstream(p, 'chapters.chaaa1111.slides');
  assert.deepEqual(c.map(x => [x.key, x.from, x.to]), [['chapters.chaaa1111.outline', 2, 3]]);
  assert.deepEqual(linkage.outOfDate(p).map(x => x.key), ['chapters.chaaa1111.slides']);
  const diff = linkage.upstreamChanges(p, 'chapters.chaaa1111.slides')[0].text;
  assert.match(diff, /^-\{"slides":\[\{"title":"x"\}\]\}$/m); assert.match(diff, /^\+\{"slides".*"y"/m);
  // a stage generated before basis existed: its provenance versions
  delete ch.stages.script.basis; ch.stages.script.provenance = [{ label: 'Slides', hash: 'x', version: 1 }];
  assert.deepEqual(linkage.changedUpstream(p, 'chapters.chaaa1111.script'), []);
  ch.stages.slides.version = 2;
  assert.deepEqual(linkage.changedUpstream(p, 'chapters.chaaa1111.script').map(x => x.key), ['chapters.chaaa1111.slides']);
  assert.match(linkage.upstreamChanges(p, 'chapters.chaaa1111.script')[0].text, /no longer kept[\s\S]*Slide 1: x/, 'decks diff as their slide text');
  // the stale check of the pipeline (inputs hash) counts too; an upstream that only appeared later does not
  assert.ok(linkage.outOfDate(p, k => k === 'exams.midterm').some(x => x.key === 'exams.midterm'));
  assert.deepEqual(linkage.upstreamOf(p, 'chapters.chaaa1111.homework').map(u => u.key), ['foundation.assessment_plan', 'chapters.chaaa1111.slides']);
  assert.deepEqual(linkage.downstreamOf(p, 'chapters.chaaa1111.outline'), ['chapters.chaaa1111.slides']);
});

// ---------------------------------------------------------------- live Word edits, drafting upstream
test('live Word operations: only the selected paragraphs; text, insert after, heading levels', () => {
  const doc = { count: 6, paras: [{ n: 2, kind: 'paragraph', text: 'a', target: false }, { n: 3, kind: 'paragraph', text: 'b', target: true }, { n: 4, kind: 'table', text: '', target: true }] };
  const r = parseDocOps('{"summary":"s","ops":[{"op":"set_text","para":3,"text":"B\\nnew"},{"op":"insert_after","para":3,"text":"c","heading":"2"},{"op":"set_heading","para":3,"level":1}]}', doc);
  assert.equal(r.ops[0].text, 'B new'); assert.equal(r.ops[1].heading, 2);
  assert.deepEqual(describeDocOps(r.ops), ['¶3: rewrote', 'New paragraph after ¶3 (heading 2)', '¶3: heading 1']);
  assert.throws(() => parseDocOps('{"ops":[{"op":"set_text","para":2,"text":"x"}]}', doc), /not selected/);
  assert.throws(() => parseDocOps('{"ops":[{"op":"set_text","para":4,"text":"x"}]}', doc), /not selected/, 'a table is not a paragraph');
  assert.throws(() => parseDocOps('{"ops":[{"op":"delete","para":3}]}', doc), /unknown/);
  assert.throws(() => parseDocOps('{"ops":[]}', doc), /no.*operations/i);
});

test('drafting from the slides: a script for the chapter’s stage (Markdown), the source then counts as made from it', async () => {
  const p = sampleProject(); const ch = p.chapters[0];
  delete ch.stages.script;
  const store = { project: p, chapterStage(c, s) { const x = p.chapters.find(y => y.id === c); return x.stages[s] ||= emptyStage(); }, foundationStage(id) { return p.foundation[id] ||= emptyStage(); }, addChapter(c) { p.chapters.push({ id: `ch${p.chapters.length}`, title: c.title, description: c.description, stages: {} }); } };
  const owner = { key: 'chapters.chaaa1111.slides', stageId: 'slides', chapter: ch, stage: ch.stages.slides, path: 'chapters/01-what-is-an-agent/slides.pptx', label: 'slides' };
  assert.deepEqual(deriveActions(owner), ['outline', 'script']);
  assert.deepEqual(deriveActions({ key: 'foundation.syllabus' }), ['objectives', 'chapters']);
  let asked;
  const llm = { chat: async (m, o) => { asked = { m, o }; return { text: '[{"slide_id":1,"title":"x","narration":"Today we meet agents."}]', usage: {} }; } };
  const r = await runDerive('script', { owner, store, llm, model: 'm' });
  assert.equal(asked.o.json, true); assert.match(asked.m[1].content, /Slide 1: x/);
  const [[file, text]] = [...r.overlay];
  assert.equal(file, 'chapters/01-what-is-an-agent/script.md'); assert.equal(r.keys.get(file), 'chapters.chaaa1111.script');
  assert.match(text, /^# What is an agent\? — lecture script\n\n## Slide 1: x\n\nToday we meet agents\./);
  ch.stages.script.output = text; ch.stages.script.version = 1; ch.stages.script.status = 'done';
  r.beforeCommit(store);
  assert.equal(ch.stages.slides.basis, undefined, 'the script is downstream of the slides: nothing to record');
  // a drafted outline is upstream: the slides count as made from it, so they are not out of date
  const ro = await runDerive('outline', { owner, store, llm: { chat: async () => ({ text: '[{"title":"x","description":"what x is"}]' }) } });
  assert.deepEqual(JSON.parse([...ro.overlay.values()][0]), [{ slide_id: 1, title: 'x', description: 'what x is' }]);
  ch.stages.outline.version = 4; ro.beforeCommit(store);
  assert.deepEqual(ch.stages.slides.basis, { 'chapters.chaaa1111.outline': 4 });
  assert.deepEqual(linkage.changedUpstream(p, 'chapters.chaaa1111.slides'), []);
  // the chapter list from the syllabus adds the chapters the course does not have
  const syl = { key: 'foundation.syllabus', stage: p.foundation.syllabus, path: 'design/syllabus.md' };
  const r2 = await runDerive('chapters', { owner: syl, store, llm: { chat: async () => ({ text: '[{"title":"What is an agent?","description":"d"},{"title":"Planning","description":"p"}]' }) } });
  assert.equal([...r2.keys.values()][0], 'chaptersStage');
  p.chaptersStage.output = [...r2.overlay.values()][0]; r2.beforeCommit(store);
  assert.deepEqual(p.chapters.map(c => c.title), ['What is an agent?', '工具 & Tools', 'Planning']);
});
