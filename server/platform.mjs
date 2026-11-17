// platform.mjs — what differs between Linux, macOS and Windows when the app starts other programs: finding a command
// on PATH (Windows adds PATHEXT: claude.cmd, codex.cmd, tectonic.exe), starting it without a shell (npm's .cmd shims
// cannot be spawned directly on Windows, so the shim's own Node script runs instead), and stopping it with everything
// it started (a process group on Linux/macOS, taskkill /T on Windows).
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';

/** The executable for `bin` in the directories of `searchPath` (a PATH string), or null. */
export function findOnPath(bin, searchPath = process.env.PATH || '', { win = isWin, pathext = process.env.PATHEXT } = {}) {
  const exts = win ? ['', ...String(pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())] : [''];
  for (const d of searchPath.split(win ? ';' : path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const f = path.join(d, bin + ext);
      try {
        const st = fs.statSync(f); if (!st.isFile()) continue;
        if (win) { if (!ext && !/\.(exe|cmd|bat|com)$/i.test(bin)) continue; } // an extension-less file is a sh script for Git Bash
        else fs.accessSync(f, fs.constants.X_OK);
        return win ? f : fs.realpathSync.native(f);
      } catch { /* next */ }
    }
  }
  return null;
}

/** The Node script an npm .cmd shim runs ("%dp0%\node_modules\…\cli.js" %*), or null. */
export function shimTarget(cmdFile) {
  let text; try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return null; }
  const m = text.match(/"%~?dp0%?\\?([^"]+?\.(?:c|m)?js)"\s+%\*/i); if (!m) return null;
  const f = path.join(path.dirname(cmdFile), m[1].replace(/\\/g, path.sep));
  return fs.existsSync(f) ? f : null;
}

// cmd.exe quoting (as cross-spawn does): for a .cmd/.bat file the arguments pass cmd's parser twice
const META = /([()\][%!^"`<>&|;, *?])/g;
export function cmdQuote(arg, doubleEscape = true) {
  let a = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  a = a.replace(META, '^$1'); if (doubleEscape) a = a.replace(META, '^$1');
  return a;
}

/** [file, args, extraOptions] to start `bin args` without a shell on this platform. */
export function command(bin, args, { win = isWin } = {}) {
  if (!win || !/\.(cmd|bat)$/i.test(bin)) return [bin, args, {}];
  const js = shimTarget(bin);
  if (js) return [process.execPath, [js, ...args], {}];
  if (args.some(a => /[\r\n]/.test(a))) throw new Error(`${path.basename(bin)} cannot be given a multi-line argument through cmd.exe`);
  const line = [bin.replace(META, '^$1'), ...args.map(a => cmdQuote(a))].join(' ');
  return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true }];
}

/** spawn() of a program that may be a Windows shim. `group`: its own process group (so stop() reaches its children). */
export function spawn(bin, args, { group = true, spawnFn = nodeSpawn, ...opts } = {}) {
  const [file, argv, extra] = command(bin, args);
  return spawnFn(file, argv, { ...opts, ...extra, detached: group && !isWin, windowsHide: true });
}
/** spawnSync() of the same. */
export function run(bin, args, opts = {}) {
  let c; try { c = command(bin, args); } catch (e) { return { status: null, error: e, stdout: '', stderr: '' }; }
  return spawnSync(c[0], c[1], { ...opts, ...c[2], windowsHide: true });
}

/** Stop a child started by spawn() and everything it started. */
export function stop(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (isWin) {
    try { nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => { try { child.kill(); } catch { /* gone */ } }); } catch { try { child.kill(); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/** Case-insensitive file systems (Windows, macOS by default) compare paths without case. */
const foldCase = process.platform === 'win32' || process.platform === 'darwin';
const norm = p => (foldCase ? p.toLowerCase() : p);
/** Whether `p` is `root` or inside it (both absolute, resolved). */
export function isInside(p, root, { orEqual = true } = {}) {
  const a = norm(p), r = norm(root).replace(/[\\/]+$/, '');
  if (a === r) return orEqual;
  return a.startsWith(r + path.sep);
}
