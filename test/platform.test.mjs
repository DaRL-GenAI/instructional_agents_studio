// Starting other programs on Linux, macOS and Windows: PATH lookup with PATHEXT, npm .cmd shims run through Node,
// cmd.exe quoting, a real agent stand-in installed the way npm installs one on this platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from './helpers.mjs';
import * as platform from '../server/platform.mjs';

// what `npm install -g` writes for a package bin on Windows (cmd-shim)
const SHIM = rel => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

test('Windows lookup: PATHEXT finds claude.cmd / tectonic.exe; an extension-less sh script is not a program', () => {
  const a = tmpdir('ia-bin-a-'), b = tmpdir('ia-bin-b-');
  fs.writeFileSync(path.join(a, 'claude'), '#!/bin/sh\n'); fs.writeFileSync(path.join(b, 'claude.cmd'), SHIM('x.js'));
  fs.writeFileSync(path.join(b, 'tectonic.exe'), 'MZ');
  const opts = { win: true, pathext: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(platform.findOnPath('claude', `${a};${b}`, opts), path.join(b, 'claude.cmd'));
  assert.equal(platform.findOnPath('tectonic', `${a};${b}`, opts), path.join(b, 'tectonic.exe'));
  assert.equal(platform.findOnPath('codex', `${a};${b}`, opts), null);
});

test('an npm .cmd shim runs its Node script directly (no cmd.exe, any argument)', () => {
  const d = tmpdir('ia-shim-'); const js = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(js), { recursive: true }); fs.writeFileSync(js, '');
  fs.writeFileSync(path.join(d, 'claude.cmd'), SHIM('node_modules\\@anthropic-ai\\claude-code\\cli.js'));
  assert.equal(platform.shimTarget(path.join(d, 'claude.cmd')), js);
  const [file, args, extra] = platform.command(path.join(d, 'claude.cmd'), ['-p', 'a "b" & c'], { win: true });
  assert.equal(file, process.execPath); assert.deepEqual(args, [js, '-p', 'a "b" & c']); assert.deepEqual(extra, {});
  // not a Node shim: through cmd.exe with every metacharacter escaped, line breaks refused
  fs.writeFileSync(path.join(d, 'other.cmd'), '@echo %*\r\n');
  const [f2, a2, x2] = platform.command(path.join(d, 'other.cmd'), ['a&b', 'c d'], { win: true });
  assert.match(f2, /cmd(\.exe)?$/i); assert.deepEqual(a2.slice(0, 3), ['/d', '/s', '/c']); assert.equal(x2.windowsVerbatimArguments, true);
  assert.match(a2[3], /\^\^\^&/); assert.doesNotMatch(a2[3], /[^^]&/);
  assert.throws(() => platform.command(path.join(d, 'other.cmd'), ['two\nlines'], { win: true }), /multi-line/);
  // elsewhere: unchanged
  assert.deepEqual(platform.command('/usr/bin/claude', ['-p'], { win: false }), ['/usr/bin/claude', ['-p'], {}]);
});

test('isInside: a folder and what is below it, not a sibling with the same prefix', () => {
  const r = path.resolve('/x/course');
  assert.ok(platform.isInside(r, r)); assert.ok(platform.isInside(path.join(r, 'a', 'b'), r));
  assert.ok(!platform.isInside(path.resolve('/x/course2'), r)); assert.ok(!platform.isInside(r, r, { orEqual: false }));
  if (process.platform === 'win32' || process.platform === 'darwin') assert.ok(platform.isInside(path.join(r.toUpperCase(), 'A'), r), 'case-insensitive file systems');
});

test('an agent installed the npm way on this platform starts, reads its prompt on stdin, and is stopped with its children', async () => {
  const d = tmpdir('ia-agent-'); const js = path.join(d, 'node_modules', 'fake-agent', 'cli.js');
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, `const p = require('fs').readFileSync(0, 'utf8'); console.log(JSON.stringify({ argv: process.argv.slice(2), prompt: p }));
if (p.includes('wait')) { require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); setTimeout(() => {}, 60000); }`);
  let bin;
  if (process.platform === 'win32') { bin = path.join(d, 'fake-agent.cmd'); fs.writeFileSync(bin, SHIM('node_modules\\fake-agent\\cli.js')); }
  else { bin = path.join(d, 'fake-agent'); fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 }); }
  assert.equal(platform.findOnPath('fake-agent', d), bin);
  const runOnce = prompt => new Promise((resolve, reject) => {
    const c = platform.spawn(bin, ['-p', '--flag', 'with space'], { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '';
    c.stdout.on('data', x => { out += x; if (prompt.includes('wait') && out.includes('\n')) platform.stop(c); });
    c.on('error', reject); c.on('close', code => resolve({ code, out })); c.stdin.end(prompt);
  });
  const long = `line one\nline "two" & <three> %PATH% ^\n${'x'.repeat(200000)}`; // longer than any command line
  const r = await runOnce(long);
  assert.equal(r.code, 0); const j = JSON.parse(r.out);
  assert.deepEqual(j.argv, ['-p', '--flag', 'with space']); assert.equal(j.prompt, long);
  const t0 = Date.now(); const w = await runOnce('wait'); assert.ok(Date.now() - t0 < 20000, 'stopped'); assert.notEqual(w.code, 0);
});
