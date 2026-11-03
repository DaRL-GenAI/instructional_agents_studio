// The command line: doctor, and import of a browser export into a folder (an existing course is backed up first).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, sampleProject } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const env = { ...process.env, IA_CONFIG_DIR: tmpdir('ia-config-'), IA_PROJECTS_ROOT: tmpdir('ia-root-'), IA_EDITOR_DIR: '' };
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });

test('doctor lists what the app needs', () => {
  const r = run('doctor'); assert.equal(r.status, 0, r.stderr);
  for (const name of ['Node.js', 'Claude Code', 'Codex', 'LaTeX', 'Editor', 'git']) assert.match(r.stdout, new RegExp(name));
});

test('import turns an exported project into a course folder; importing again over it needs --force and backs it up', () => {
  const work = tmpdir(); const file = path.join(work, 'old_project.json');
  const p = sampleProject(); p.chapters[0].stages.slides.output = ''; // no deck inside this export
  fs.writeFileSync(file, JSON.stringify(p));
  const dir = path.join(work, 'course');
  let r = run('import', file, dir); assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(dir, '.studio/meta.json')));
  assert.equal(fs.readFileSync(path.join(dir, '.studio/backup/old_project.json'), 'utf8'), JSON.stringify(p));
  assert.equal(fs.readFileSync(path.join(dir, 'design/learning_objectives.md'), 'utf8'), p.foundation.objectives.output);
  assert.match(execFileSync('git', ['-C', dir, 'log', '--format=%s'], { encoding: 'utf8' }), /^import: old_project\.json/);

  r = run('import', file, dir); assert.equal(r.status, 1); assert.match(r.stderr, /--force/);
  r = run('import', file, dir, '--force'); assert.equal(r.status, 0, r.stderr);
  const bak = fs.readdirSync(work).find(n => n.startsWith('course.bak-')); assert.ok(bak, 'backup kept');
  assert.ok(fs.existsSync(path.join(work, bak, '.studio/meta.json')));
});
