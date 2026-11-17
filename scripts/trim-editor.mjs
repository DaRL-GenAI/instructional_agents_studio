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
// …and the regular face of these larger families (Chinese sans and serif, Korean, symbols, a full Latin serif)
const FONT_FAMILIES = new Set(['Noto Sans SC', 'Noto Serif SC', 'Noto Sans KR', 'Symbola', 'FreeSerif']);
// A font file that is left out is still named in AllFonts.js; the editor stops with "Fonts are not loaded" when one it
// needs is missing (a bold Chinese title is enough). So every file left out gets a stand-in, written to
// fonts-alias.json, which the app serves under the missing name: another face of the same family, else the kept
// regular face of the closest script.
const SERIF_CJK = /song|kai|fang|ming|宋|楷|仿|ukai|小标/i, KOREAN = /nanum|\bKR\b|gothic kr|myeongjo/i;

function fontPlan() {
  const w = {}; vm.runInNewContext(fs.readFileSync(path.join(src, 'sdkjs/common/AllFonts.js'), 'utf8').replace(/^\uFEFF/, ''), { window: w });
  const files = w.__fonts_files, infos = w.__fonts_infos, keep = new Set(), regularOf = {};
  for (const info of infos) if (FONT_FAMILIES.has(info[0]) && info[1] >= 0) { keep.add(files[info[1]]); regularOf[info[0]] = files[info[1]]; }
  const kept = name => keep.has(name) || fs.statSync(path.join(src, 'fonts', name)).size <= FONT_MAX;
  const alias = {};
  const fallback = family => regularOf[KOREAN.test(family) ? 'Noto Sans KR' : SERIF_CJK.test(family) ? 'Noto Serif SC' : 'Noto Sans SC'];
  for (const info of infos) {
    const faces = [1, 3, 5, 7].map(k => info[k]).filter(i => i >= 0).map(i => files[i]);
    const keptFace = faces.find(kept);
    for (const f of faces) if (!kept(f) && !alias[f]) alias[f] = keptFace || fallback(info[0]);
  }
  return { kept, alias };
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
const plan = fontPlan(); let dropped = 0;
for (const n of fs.readdirSync(path.join(src, 'fonts'))) if (plan.kept(n)) copy(`fonts/${n}`); else { dropped++; if (!plan.alias[n]) console.warn(`  no stand-in for fonts/${n}`); }
fs.writeFileSync(path.join(out, 'fonts-alias.json'), JSON.stringify(plan.alias, null, 1));
fs.writeFileSync(path.join(out, '.ia-editor.json'), JSON.stringify({ version: 'trim', from: src, at: new Date().toISOString() }));
const mb = n => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`trimmed editor: ${count} files, ${mb(bytes)} in ${out} (${dropped} font files left out)`);

if (pack) {
  const tgz = `${out}.tar.gz`;
  execFileSync('tar', ['-czf', path.basename(tgz), path.basename(out)], { cwd: path.dirname(out) }); // relative paths: GNU tar on Windows reads C: as a host
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  fs.writeFileSync(`${tgz}.sha256`, `${sha}  ${path.basename(tgz)}\n`);
  console.log(`package: ${tgz} (${mb(fs.statSync(tgz).size)}), sha-256 ${sha}`);
}
