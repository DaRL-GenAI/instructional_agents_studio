// tex.mjs — compile a project's .tex file to PDF. The engine is tectonic (IA_TECTONIC, PATH, the conda env "tex",
// ~/.local/bin) or latexmk as a fallback. A compile copies the file's folder into .studio/jobs/tex-<id>/ and runs
// there (cwd = that copy, no shell escape, 60 s limit), so a broken run never touches the project; the PDF and the
// log land in build/ (git-ignored). Errors come from the log (file:line: message).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { which } from './agents/cli.mjs';
import { resolveInside } from './workspace.mjs';

const exe = f => { try { fs.accessSync(f, fs.constants.X_OK); return fs.realpathSync(f); } catch { return null; } };

/** The LaTeX engine on this computer: { engine: 'tectonic' | 'latexmk', bin } or null. */
export function findTex(env = process.env) {
  if (env.IA_TECTONIC) { const b = exe(env.IA_TECTONIC); if (b) return { engine: 'tectonic', bin: b }; }
  const t = which('tectonic') || exe(path.join(os.homedir(), 'miniconda3/envs/tex/bin/tectonic')) || exe(path.join(os.homedir(), '.local/bin/tectonic'));
  if (t) return { engine: 'tectonic', bin: t };
  const l = which('latexmk'); if (l) return { engine: 'latexmk', bin: l };
  return null;
}

/** Errors in a TeX log (and tectonic's own "error: file:line: message" lines): [{ file, line, message }]. */
export function parseTexLog(text) {
  const out = []; const seen = new Set();
  const add = (file, line, message) => {
    message = String(message || '').trim().replace(/\.$/, ''); if (!message) return;
    const k = `${file}|${line}|${message}`; if (seen.has(k)) return; seen.add(k);
    out.push({ file: file ? file.replace(/^\.\//, '') : null, line: line ? Number(line) : null, message });
  };
  const lines = String(text || '').split(/\r?\n/);
  let file = null; // the .tex file opened last: classic "! message … l.N" errors belong to it
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const m of l.matchAll(/\((\.?\/?[^\s()]+\.tex)\b/g)) file = m[1];
    let m;
    if ((m = l.match(/^(?:error: )?((?:\.\/)?[^\s:]+\.(?:tex|sty|cls|bib|bbl)):(\d+): (.+)$/))) { add(m[1], m[2], m[3]); continue; }
    if ((m = l.match(/^! (.+)$/))) {
      let msg = m[1], line = null;
      for (let k = i + 1; k < Math.min(lines.length, i + 12); k++) { const n = lines[k].match(/^l\.(\d+)/); if (n) { line = n[1]; break; } if (/^! /.test(lines[k])) break; }
      if (/^(Emergency stop|==> Fatal error occurred)/.test(msg) && out.length) continue;
      add(file, line, msg);
    }
  }
  // tectonic and the engine report the same error twice (with and without the "./"): keep one per file and line
  const byLine = new Map(); for (const e of out) { const k = `${e.file}|${e.line}`; if (!byLine.has(k)) byLine.set(k, e); }
  return [...byLine.values()];
}

const SKIP = /^(\.git|\.studio|build|node_modules)$/;
function copyDir(from, to, budget = { bytes: 200 * 1024 * 1024 }) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.test(e.name) || e.isSymbolicLink()) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, budget);
    else if (e.isFile()) { const n = fs.statSync(a).size; if (n > 50 * 1024 * 1024 || (budget.bytes -= n) < 0) continue; fs.copyFileSync(a, b); }
  }
}

function run(bin, args, { cwd, timeout }) {
  return new Promise(resolve => {
    const p = spawn(bin, args, { cwd, env: { ...process.env, TEXMFOUTPUT: cwd, openout_any: 'p', shell_escape: 'f' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let out = ''; const take = d => { out += d; if (out.length > 400000) out = out.slice(-300000); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    const kill = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
    const t = setTimeout(() => { kill(); resolve({ code: null, out, timedOut: true }); }, timeout);
    p.on('error', e => { clearTimeout(t); resolve({ code: null, out: `${out}\n${e.message}`, error: e.message }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

const running = new Map(); // project dir + file → the compile in flight (a second request waits for it, then runs again)

/**
 * Compile `rel` (a .tex file of the project at `root`). → { ok, engine, errors, log, pdf: 'build/….pdf' | null, ms }.
 * tex: the engine (findTex() by default; tests pass a fake one).
 */
export async function compile(root, rel, { tex = findTex(), timeout = 60000 } = {}) {
  if (!/\.tex$/i.test(rel)) throw Object.assign(new Error('Not a .tex file'), { status: 400 });
  const abs = resolveInside(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw Object.assign(new Error('No such file'), { status: 404 });
  if (!tex) return { ok: false, engine: null, errors: [], log: '', pdf: null, missing: true, ms: 0 };
  const key = `${root}\0${rel}`;
  while (running.has(key)) await running.get(key).catch(() => {});
  const job = (async () => {
    const t0 = Date.now();
    const id = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);
    const jobDir = path.join(root, '.studio', 'jobs', `tex-${id}`); const src = path.join(jobDir, 'src');
    fs.rmSync(jobDir, { recursive: true, force: true });
    copyDir(path.dirname(abs), src);
    const name = path.basename(rel, path.extname(rel)); const outDir = path.join(jobDir, 'out'); fs.mkdirSync(outDir, { recursive: true });
    const args = tex.engine === 'tectonic'
      ? ['--keep-logs', '--untrusted', '--chatter', 'minimal', '--outdir', outDir, path.basename(abs)]
      : ['-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape', `-outdir=${outDir}`, path.basename(abs)];
    const r = await run(tex.bin, args, { cwd: src, timeout });
    let log = ''; try { log = fs.readFileSync(path.join(outDir, `${name}.log`), 'utf8'); } catch { /* no log: the engine output says why */ }
    const errors = parseTexLog(`${log}\n${r.out}`);
    if (r.timedOut) errors.unshift({ file: null, line: null, message: `Stopped after ${Math.round(timeout / 1000)} s` });
    else if (r.error) errors.unshift({ file: null, line: null, message: r.error });
    else if (r.code !== 0 && !errors.length) errors.push({ file: null, line: null, message: (r.out.trim().split('\n').filter(Boolean).pop() || `${tex.engine} failed`).slice(0, 300) });
    const pdfTmp = path.join(outDir, `${name}.pdf`);
    const base = path.posix.join('build', rel.replace(/\.tex$/i, ''));
    fs.mkdirSync(path.dirname(path.join(root, base)), { recursive: true });
    fs.writeFileSync(path.join(root, `${base}.log`), `${log}\n---- ${tex.engine}\n${r.out}`);
    const ok = r.code === 0 && !r.timedOut && fs.existsSync(pdfTmp);
    let pdf = null;
    if (ok) { fs.copyFileSync(pdfTmp, path.join(root, `${base}.pdf`)); pdf = `${base}.pdf`; }
    else if (fs.existsSync(path.join(root, `${base}.pdf`))) pdf = `${base}.pdf`; // the last good PDF stays
    // errors in this file only carry a line the editor can jump to
    const own = path.basename(rel);
    for (const e of errors) { e.here = !e.file || path.basename(e.file) === own; }
    return { ok, engine: tex.engine, errors, log: (log || r.out).slice(-20000), pdf, ms: Date.now() - t0, fresh: ok };
  })();
  running.set(key, job);
  try { return await job; } finally { if (running.get(key) === job) running.delete(key); }
}
