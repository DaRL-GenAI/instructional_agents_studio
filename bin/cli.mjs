#!/usr/bin/env node
// instructional-agents — Instructional Agents Studio as a local app.
//
//   instructional-agents [dir] [--port N] [--no-open] [--allow-host H]   start (dir: a course folder, or where a new one goes;
//                                                     --allow-host: also accept https://H, e.g. a private tunnel)
//   instructional-agents doctor                           check Node, the agent CLIs, LaTeX and the editor
//   instructional-agents import <project.json> [dir]      turn a project exported from the browser edition into a folder
//   instructional-agents editor install --url U --sha256 H [--version V]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--port', '--url', '--sha256', '--version', '--allow-host'].includes(argv[i - 1]));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19)) { console.error(`instructional-agents needs Node.js 20.19 or newer (this is ${process.version}).`); process.exit(1); }

const cmd = positional[0];
if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
if (cmd === 'doctor') await doctor();
else if (cmd === 'import') await importCmd(positional[1], positional[2]);
else if (cmd === 'editor' && positional[1] === 'install') await editorInstall();
else await start(positional[0]);

async function start(dir) {
  const { startServer } = await import('../server/http.mjs');
  const app = await startServer({ dir: dir ? path.resolve(dir) : null, port: Number(opt('--port', process.env.IA_PORT || 8790)), allowHosts: [opt('--allow-host', ''), ...String(process.env.IA_ALLOW_HOSTS || '').split(',')].filter(Boolean) });
  console.log(`\n  Open ${app.url}\n`);
  if (!flag('--no-open')) openBrowser(app.url);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

function openBrowser(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(bin, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print only */ }
}

async function doctor() {
  const { which, version } = await import('../server/agents/cli.mjs');
  const { findEditor, EDITOR } = await import('../server/editor-pkg.mjs');
  const { configDir, projectsRoot } = await import('../server/config.mjs');
  const rows = [];
  const row = (name, ok, detail, need) => rows.push([ok ? 'ok ' : need ? 'MISSING' : '-- ', name, detail]);
  row('Node.js', true, process.version, true);
  for (const [name, bin, use] of [['Claude Code', 'claude', 'revise slides with Claude Code'], ['Codex', 'codex', 'revise slides with Codex']]) { const b = which(bin); row(name, !!b, b ? `${version(b) || 'installed'} (${b})` : `not found: needed to ${use}`); }
  const tex = ['tectonic', 'latexmk'].map(b => [b, which(b)]).filter(([, p]) => p);
  row('LaTeX', tex.length > 0, tex.length ? tex.map(([b, p]) => `${b} (${p})`).join(', ') : 'tectonic or latexmk not found: needed to compile .tex files');
  const ed = findEditor();
  row('Editor', !!ed, ed ? `${ed.version} (${ed.dir})` : `not installed: slides open in https://edit.chaxus.com${EDITOR.url ? '' : ' (set IA_EDITOR_DIR to a local build)'}`);
  row('git', true, 'built in (isomorphic-git)');
  console.log(rows.map(r => `  ${r[0].padEnd(7)} ${r[1].padEnd(12)} ${r[2]}`).join('\n'));
  console.log(`\n  config: ${configDir()}\n  new projects: ${projectsRoot()}`);
}

async function importCmd(file, dir) {
  if (!file) { console.error('usage: instructional-agents import <project.json> [dir]'); process.exit(2); }
  const { Projects, checkDir, isProjectDir } = await import('../server/projects.mjs');
  const json = fs.readFileSync(file, 'utf8');
  if (dir) {
    const abs = checkDir(path.resolve(dir));
    if (isProjectDir(abs)) {
      if (!flag('--force')) { console.error(`${abs} already holds a course. Pass --force to move it aside (it is kept as ${path.basename(abs)}.bak-<time>).`); process.exit(1); }
      const bak = `${abs}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`; fs.renameSync(abs, bak); console.log(`  backed up ${abs} → ${bak}`);
    }
  }
  const projects = new Projects({ watch: false });
  const r = await projects.importJson(json, dir ? path.resolve(dir) : null, { source: path.basename(file) });
  console.log(`  imported “${r.project.name}” into ${r.dir} (${r.project.chapters.length} chapters; original kept in .studio/backup/)`);
  console.log(`  open it: instructional-agents ${JSON.stringify(r.dir)}`);
}

async function editorInstall() {
  const { installEditor } = await import('../server/editor-pkg.mjs');
  const ed = await installEditor({ url: opt('--url'), sha256: opt('--sha256'), version: opt('--version', 'dev'), log: m => console.log(`  ${m}`) });
  console.log(ed ? `  ready: ${ed.dir}` : '  installed, but not found afterwards');
}
