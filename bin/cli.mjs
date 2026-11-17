#!/usr/bin/env node
// instructional-agents — Instructional Agents Studio as a local app.
//
//   instructional-agents [dir] [--port N] [--no-open] [--allow-host H]   start (dir: a course folder, or any folder to open as one;
//                                                     --allow-host: also accept https://H, e.g. a private tunnel)
//   instructional-agents doctor                           check Node, the agent CLIs, LaTeX and the editor
//   instructional-agents import <project.json> [dir]      turn a project exported from the browser edition into a folder
//   instructional-agents editor install [--url U --sha256 H --version V]   download the editor again (done on first start)
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
if (flag('--help') || flag('-h')) { { const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1); console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); }; process.exit(0); }
if (cmd === 'doctor') await doctor();
else if (cmd === 'import') await importCmd(positional[1], positional[2]);
else if (cmd === 'editor' && positional[1] === 'install') await editorInstall();
else await start(positional[0]);

async function start(dir) {
  const config = await import('../server/config.mjs');
  // one app per computer: started again (another terminal, a double click), it opens the running one instead of a
  // second server watching and committing to the same courses
  if (!opt('--port') && !process.env.IA_PORT) {
    const prev = config.instance();
    if (prev && await alive(prev)) {
      let hash = '#/projects';
      try {
        const r = await fetch(`http://127.0.0.1:${prev.port}/api/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${prev.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: dir ? path.resolve(dir) : null }) });
        const j = await r.json(); if (!r.ok) { console.error(`  ${j.error || r.status}`); process.exit(1); } hash = j.hash || hash;
      } catch { /* open the list */ }
      const url = `http://127.0.0.1:${prev.port}/?token=${prev.token}${hash}`;
      console.log(`\n  Instructional Agents is already running (process ${prev.pid}). Open ${url}\n`);
      if (!flag('--no-open')) openBrowser(url);
      return;
    }
  }
  await ensureEditor();
  const { startServer } = await import('../server/http.mjs');
  const app = await startServer({ dir: dir ? path.resolve(dir) : null, port: Number(opt('--port', process.env.IA_PORT || 8790)), allowHosts: [opt('--allow-host', ''), ...String(process.env.IA_ALLOW_HOSTS || '').split(',')].filter(Boolean) });
  console.log(`\n  Open ${app.url}\n  (keep this window open while you use the app; Ctrl+C stops it)\n`);
  config.saveInstance({ pid: process.pid, port: app.port, token: app.token });
  if (!flag('--no-open')) openBrowser(app.url);
  const stop = async () => { config.clearInstance(process.pid); await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

async function alive(prev) {
  try { process.kill(prev.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { const r = await fetch(`http://127.0.0.1:${prev.port}/api/health`, { signal: AbortSignal.timeout(1500) }); return r.ok && (await r.json()).app === 'instructional-agents'; } catch { return false; }
}

function openBrowser(url) {
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(bin, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* print only */ }
}

async function doctor() {
  const { which, version } = await import('../server/agents/cli.mjs');
  const { findEditor } = await import('../server/editor-pkg.mjs');
  const { configDir, projectsRoot } = await import('../server/config.mjs');
  const rows = [];
  const row = (name, ok, detail, need) => rows.push([ok ? 'ok ' : need ? 'MISSING' : '-- ', name, detail]);
  row('Node.js', true, process.version, true);
  for (const [name, bin, use] of [['Claude Code', 'claude', 'revise slides with Claude Code'], ['Codex', 'codex', 'revise slides with Codex']]) { const b = which(bin); row(name, !!b, b ? `${version(b) || 'installed'} (${b})` : `not found: needed to ${use}`); }
  const { findTex } = await import('../server/tex.mjs'); const tex = findTex();
  row('LaTeX', !!tex, tex ? `${tex.engine} (${tex.bin})` : 'tectonic or latexmk not found: needed to compile .tex files (or set IA_TECTONIC)');
  const ed = findEditor();
  row('Editor', !!ed, ed ? `${ed.version}, ${ed.source} (${ed.dir})` : 'not installed (it is downloaded on the first start; or run: instructional-agents editor install); slides open in the hosted editor https://edit.chaxus.com meanwhile (agent edits in place need the local one)', true);
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

// The slides and Word editor (about 90 MB) is not in the npm package: downloaded once, on the first start, into the
// cache. Without a network the app still starts; slides then open in the hosted editor until the next start.
async function ensureEditor() {
  if ('IA_EDITOR_DIR' in process.env) return; // a chosen build, or none (tests)
  const { findEditor, installEditor, EDITOR } = await import('../server/editor-pkg.mjs');
  const ed = findEditor();
  if (!EDITOR.url || (ed && !(ed.source === 'cache' && ed.version !== EDITOR.version))) return;
  console.log(`\n  ${ed ? 'Updating' : 'First start: downloading'} the slides and Word editor (about 90 MB, only once). Please wait…`);
  try { await installEditor({ log: m => console.log(`    ${m}`) }); console.log('  Editor ready.'); }
  catch (e) { console.log(`  Could not download the editor (${e.message}).\n  Slides and Word files open in the online editor for now; it is downloaded again on the next start.`); }
}

async function editorInstall() {
  const { installEditor, EDITOR } = await import('../server/editor-pkg.mjs');
  const ed = await installEditor({ url: opt('--url', EDITOR.url), sha256: opt('--sha256', EDITOR.sha256), version: opt('--version', EDITOR.version), log: m => console.log(`  ${m}`) });
  console.log(ed ? `  ready: ${ed.dir}` : '  installed, but not found afterwards');
}
