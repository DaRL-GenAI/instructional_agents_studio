#!/usr/bin/env node
// ci-smoke.mjs — the installed app end to end, headless: start the server, open the printed address in the machine's
// Chrome (playwright-core, channel "chrome"), create a course from the launcher, check the folder (meta, AGENTS.md,
// git), open the Workspace and the agent panel, stop. Usage: node scripts/ci-smoke.mjs [--chrome /path/to/chrome]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ia-smoke-')));
const env = { ...process.env, IA_CONFIG_DIR: path.join(tmp, 'config'), IA_PROJECTS_ROOT: path.join(tmp, 'courses'), IA_EDITOR_DIR: '' };
const chromeArg = process.argv.indexOf('--chrome');
const step = m => console.log(`• ${m}`);
const fail = m => { throw new Error(m); };

const server = spawn(process.execPath, [path.join(root, 'bin/cli.mjs'), '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; server.stdout.on('data', d => { out += d; }); server.stderr.on('data', d => { out += d; });
let browser;
try {
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`the server printed no address:\n${out}`)), 20000);
    const check = () => { const m = out.match(/Open (http\S+)/); if (m) { clearTimeout(t); res(m[1]); } };
    server.stdout.on('data', check); server.on('exit', c => rej(new Error(`the server exited (${c}):\n${out}`)));
  });
  step(`server: ${new URL(url).origin}`);
  browser = await chromium.launch(chromeArg > 0 ? { executablePath: process.argv[chromeArg + 1], headless: true } : { channel: 'chrome', headless: true });
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url); await page.waitForSelector('input[placeholder="e.g. LLM-based Agents"]', { timeout: 30000 });
  step('launcher open');
  await page.fill('input[placeholder="e.g. LLM-based Agents"]', 'CI Smoke Course');
  await page.click('button:has-text("Create project")');
  await page.waitForURL(/#\/p\/prj_\w+\/basics/, { timeout: 30000 });
  const id = page.url().match(/p\/(prj_\w+)/)[1];
  const dir = path.join(env.IA_PROJECTS_ROOT, 'ci-smoke-course');
  for (const f of ['.studio/meta.json', 'course.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore']) if (!fs.existsSync(path.join(dir, f))) fail(`${f} is missing in ${dir}`);
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  if (!log.some(l => l.startsWith('init: CI Smoke Course'))) fail(`no init commit: ${log.join(' | ')}`);
  step(`course created: ${id} in ${dir} (${log.length} commit${log.length > 1 ? 's' : ''})`);
  await page.goto(`${new URL(url).origin}/#/p/${id}/workspace`);
  await page.waitForSelector('.ws-tree .ws-row[data-path="AGENTS.md"]', { timeout: 30000 });
  if (!(await page.$('.ws-agent:not([hidden])'))) await page.click('.ws-activity [aria-label="Agent panel"]');
  await page.waitForSelector('.ag-head select option[value="builtin"]', { state: 'attached', timeout: 15000 });
  step(`workspace + agent panel: ${(await page.$$eval('.ag-head select:first-child option', o => o.map(x => x.textContent + (x.disabled ? ' (off)' : '')))).join(', ')}`);
  if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
  console.log('smoke test passed');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(r => { if (server.exitCode !== null) r(); else { server.on('exit', r); setTimeout(r, 5000); } });
  fs.rmSync(tmp, { recursive: true, force: true });
}
