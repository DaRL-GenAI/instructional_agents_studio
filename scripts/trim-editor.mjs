#!/usr/bin/env node
// trim-editor.mjs — a trimmed copy of the ONLYOFFICE web build (the studio-embed dist) for the local app: only the
// presentation and document editors, the sdkjs parts they load, and a font subset (Latin families plus Chinese
// regular faces; the large Japanese / Korean / Tibetan / extra CJK files are left out, the editor substitutes).
//
//   node scripts/trim-editor.mjs <dist> [out] [--pack]
//
// out defaults to ~/.cache/instructional-agents/editor-trim/. --pack also writes <out>.tar.gz and its sha-256
// (the asset editor-pkg.mjs downloads); nothing is uploaded anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const pack = process.argv.includes('--pack');
const src = path.resolve(args[0] || '');
if (!args[0] || !fs.existsSync(path.join(src, 'editor.html'))) { console.error('usage: node scripts/trim-editor.mjs <editor dist> [out] [--pack]'); process.exit(2); }
const out = path.resolve(args[1] || path.join(process.env.IA_CACHE_DIR || path.join(os.homedir(), '.cache', 'instructional-agents'), 'editor-trim'));

// what the editor page needs (paths relative to the dist root)
const KEEP_DIRS = ['assets', 'icons', 'libs', 'licenses', 'ran-fonts', 'ranui-iife', 'sdkjs/common', 'sdkjs/slide', 'sdkjs/word',
  'web-apps/apps/api', 'web-apps/apps/common', 'web-apps/apps/presentationeditor', 'web-apps/apps/documenteditor', 'web-apps/vendor'];
const KEEP_FILES = /^(editor\.html|LICENSE|NOTICE|manifest\.json|themes\.json|plugins\.json|build-identity\.json|theme-presentation\.js|app-tokens\.css|ran-tokens\.[\w]+\.css|document_editor_service_worker\.js|sw\.js|sw-register\.js)$/;
// left out: the in-editor local LLM (loaded on demand only), the Monaco macro editor, the Internet Explorer builds
const DROP = /(^|\/)(assets\/(wllama-[\w-]+\.wasm|webllm\.worker-[\w-]+\.js)|web-apps\/vendor\/monaco|web-apps\/apps\/\w+\/main\/ie)$/;
const FONT_MAX = 2 * 1024 * 1024; // keep every font file up to this size…
const FONT_FAMILIES = new Set(['Noto Sans SC', 'Noto Serif SC']); // …and the regular face of these larger families

function fontKeep() {
  const w = {}; vm.runInNewContext(fs.readFileSync(path.join(src, 'sdkjs/common/AllFonts.js'), 'utf8').replace(/^\uFEFF/, ''), { window: w });
  const files = w.__fonts_files, keep = new Set();
  for (const info of w.__fonts_infos) if (FONT_FAMILIES.has(info[0]) && info[1] >= 0) keep.add(files[info[1]]);
  return name => keep.has(name) || fs.statSync(path.join(src, 'fonts', name)).size <= FONT_MAX;
}

let bytes = 0, count = 0;
function copy(rel) {
  if (DROP.test(rel)) return;
  const a = path.join(src, rel), b = path.join(out, rel), st = fs.statSync(a);
  if (st.isDirectory()) { for (const n of fs.readdirSync(a)) copy(path.posix.join(rel, n)); return; }
  fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); bytes += st.size; count++;
}

fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
for (const n of fs.readdirSync(src)) if (KEEP_FILES.test(n)) copy(n);
for (const d of KEEP_DIRS) if (fs.existsSync(path.join(src, d))) copy(d);
const keepFont = fontKeep(); let dropped = 0;
for (const n of fs.readdirSync(path.join(src, 'fonts'))) if (keepFont(n)) copy(`fonts/${n}`); else dropped++;
fs.writeFileSync(path.join(out, '.ia-editor.json'), JSON.stringify({ version: 'trim', from: src, at: new Date().toISOString() }));
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`trimmed editor: ${count} files, ${mb(bytes)} in ${out} (${dropped} font files left out)`);

if (pack) {
  const tgz = `${out}.tar.gz`;
  execFileSync('tar', ['-czf', tgz, '-C', path.dirname(out), path.basename(out)]);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  fs.writeFileSync(`${tgz}.sha256`, `${sha}  ${path.basename(tgz)}\n`);
  console.log(`package: ${tgz} (${mb(fs.statSync(tgz).size)}), sha-256 ${sha}`);
}
