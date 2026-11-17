// Courses in a synced folder (Google Drive & co.): the course files stay in the folder, the git repository, agent job
// copies and chats live on this computer (localstate.mjs). IA_CLOUD_DIRS marks a temp folder as synced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir, isolateConfig } from './helpers.mjs';
import { newProject } from '../js/model.js';

isolateConfig();
const cloud = tmpdir('ia-drive-');
process.env.IA_CLOUD_DIRS = cloud;
process.env.IA_DATA_DIR = tmpdir('ia-data-');
const { Projects } = await import('../server/projects.mjs');
const folders = await import('../server/folders.mjs');
const vcs = await import('../server/vcs.mjs');
const jobs = await import('../server/agents/jobs.mjs');
const sessions = await import('../server/agents/sessions.mjs');
const localstate = await import('../server/localstate.mjs');

const put = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const inside = (p, root) => p.startsWith(root + path.sep);

test('which folders are synced', () => {
  const home = os.homedir(), cs = path.join(home, 'Library', 'CloudStorage');
  assert.equal(localstate.cloudOf(path.join(cs, 'GoogleDrive-a@b.edu', 'My Drive', 'CS101')), 'Google Drive');
  assert.equal(localstate.cloudOf(path.join(cs, 'Dropbox', 'x')), 'Dropbox');
  assert.equal(localstate.cloudOf(path.join(cs, 'OneDrive-ASU', 'x')), 'OneDrive');
  assert.equal(localstate.cloudOf(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x')), 'iCloud Drive');
  assert.equal(localstate.cloudOf(path.join(home, 'My Drive', 'x')), 'Google Drive');
  if (process.platform !== 'win32') assert.equal(localstate.cloudOf('/Volumes/GoogleDrive/My Drive/x'), 'Google Drive');
  assert.equal(localstate.cloudOf(path.join(home, 'iCloudDrive', 'x')), 'iCloud Drive'); // iCloud for Windows
  assert.equal(localstate.cloudOf(path.join(cloud, 'x')), 'a synced folder');
  assert.equal(localstate.cloudOf(path.join(home, 'Documents', 'CS101')), null);
  assert.equal(localstate.cloudOf(path.join(home, 'Library', 'CloudStorage')), null);
  const od = process.env.OneDriveCommercial; process.env.OneDriveCommercial = path.join(home, 'OneDrive - Arizona State University');
  try { assert.equal(localstate.cloudOf(path.join(process.env.OneDriveCommercial, 'CS101')), 'OneDrive'); } finally { if (od === undefined) delete process.env.OneDriveCommercial; else process.env.OneDriveCommercial = od; }
});

test('a course in a synced folder keeps its history and chats on this computer', async () => {
  const dir = path.join(cloud, 'CS 101'); put(dir, 'notes.md', '# Week 1\n');
  const info = folders.inspect(dir);
  assert.equal(info.cloud, 'a synced folder'); assert.equal(info.git, false);
  const projects = new Projects({ watch: false });
  const r = await projects.adopt(newProject({ course: { name: 'CS 101' } }), dir);
  assert.equal(r.repo, 'new');
  assert.ok(!fs.existsSync(path.join(dir, '.git')), 'no .git in the synced folder');
  assert.ok(fs.existsSync(path.join(dir, '.studio/meta.json')), 'the course files are in the folder');
  const local = localstate.localDir(dir); assert.ok(inside(local, process.env.IA_DATA_DIR));
  assert.ok(fs.existsSync(path.join(local, 'git', 'HEAD')));
  assert.ok(fs.readFileSync(path.join(local, 'git', 'info', 'exclude'), 'utf8').includes('node_modules/'));
  const log = await vcs.log(dir); assert.equal(log.length, 1);
  // a later change commits into the same repository; the git CLI reads it with --git-dir
  put(dir, 'notes.md', '# Week 1\n\nAgents.\n');
  const head = await vcs.commit(dir, ['notes.md'], 'edit: notes');
  assert.equal((await vcs.log(dir)).length, 2); assert.equal(await vcs.head(dir), head);
  assert.equal(execFileSync('git', ['--git-dir', path.join(local, 'git'), 'log', '--format=%s', '-1'], { encoding: 'utf8' }).trim(), 'edit: notes');
  assert.equal((await vcs.readAt(dir, head, 'notes.md')).toString(), '# Week 1\n\nAgents.\n');
  // agent jobs and chats
  assert.ok(inside(jobs.jobDir(dir, 'abc123'), local));
  const chat = sessions.create(dir, { agent: 'claude' });
  assert.ok(fs.existsSync(path.join(local, 'sessions', `${chat.id}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, '.studio', 'sessions')));
  assert.deepEqual(sessions.list(dir).map(s => s.id), [chat.id]);
  const base = jobs.copyProject(dir, jobs.jobDir(dir, chat.id));
  assert.ok(base && fs.existsSync(path.join(jobs.jobDir(dir, chat.id), 'notes.md')));
  assert.ok(!fs.existsSync(path.join(dir, '.studio', 'jobs')));
});

test('a moved synced course finds its history again; another computer starts its own', async () => {
  const dir = path.join(cloud, 'Moving'); fs.mkdirSync(dir);
  const projects = new Projects({ watch: false });
  await projects.adopt(newProject({ course: { name: 'Moving' } }), dir);
  const local = localstate.localDir(dir);
  const config = await import('../server/config.mjs');
  assert.ok(config.localStates().find(e => e.dir === dir).id, 'the course id is recorded');
  const moved = path.join(cloud, 'Moved'); fs.renameSync(dir, moved);
  assert.equal(localstate.localDir(moved), local);
  assert.equal((await vcs.log(moved)).length, 1);

  // another computer: its own config and data folders, the same synced files
  const saved = [process.env.IA_CONFIG_DIR, process.env.IA_DATA_DIR];
  process.env.IA_CONFIG_DIR = tmpdir('ia-config2-'); process.env.IA_DATA_DIR = tmpdir('ia-data2-');
  const other = path.join(cloud, 'Other'); fs.cpSync(moved, other, { recursive: true });
  assert.equal(vcs.hasRepo(other), false);
  put(other, 'week2.md', 'two');
  const head = await vcs.commit(other, ['week2.md'], 'edit: week 2'); // the first commit here takes the folder as it is
  assert.deepEqual((await vcs.log(other)).map(c => c.message), ['init: history on this computer']);
  assert.equal((await vcs.readAt(other, head, 'week2.md')).toString(), 'two');
  assert.ok(await vcs.readAt(other, head, '.studio/meta.json'));
  put(other, 'week2.md', 'two!'); await vcs.commit(other, ['week2.md'], 'edit: week 2');
  assert.equal((await vcs.log(other)).length, 2);
  assert.ok(inside(localstate.localDir(other), process.env.IA_DATA_DIR));
  assert.ok(!fs.existsSync(path.join(other, '.git')));
  [process.env.IA_CONFIG_DIR, process.env.IA_DATA_DIR] = saved;
});

test('a synced folder with a repository of its own keeps using it; other folders are unchanged', async () => {
  const own = path.join(cloud, 'Repo'); put(own, 'a.md', 'a');
  execFileSync('git', ['init', '-q', '-b', 'main', own]);
  assert.equal(folders.inspect(own).git, true);
  const projects = new Projects({ watch: false });
  const r = await projects.adopt(newProject({ course: { name: 'Repo' } }), own);
  assert.equal(r.repo, 'existing');
  assert.equal(localstate.gitdirOf(own), path.join(own, '.git'));
  assert.ok(inside(sessions.create(own, {}) && localstate.scratchDir(own, 'sessions'), process.env.IA_DATA_DIR), 'chats still stay on this computer');

  const plain = path.join(tmpdir(), 'Plain'); fs.mkdirSync(plain);
  await projects.adopt(newProject({ course: { name: 'Plain' } }), plain);
  assert.ok(fs.existsSync(path.join(plain, '.git', 'HEAD')));
  assert.equal(localstate.localDir(plain), null);
  assert.equal(jobs.jobDir(plain, 'abc123'), path.join(plain, '.studio', 'jobs', 's-abc123'));
});
