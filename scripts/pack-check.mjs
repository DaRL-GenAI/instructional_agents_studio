#!/usr/bin/env node
// pack-check.mjs — what `npm pack` would publish: the app and its server only (no tests, scripts, editor build,
// secrets or local state), under a size budget. Exits 1 with the reasons otherwise. Usage: node scripts/pack-check.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const [pack] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const files = pack.files.map(f => f.path);
const MAX_PACKED = 5 * 1024 * 1024, MAX_UNPACKED = 12 * 1024 * 1024;
const ALLOWED = /^(package\.json|README\.md|LICENSE|NOTICE|index\.html|bin\/cli\.mjs|server\/.+\.mjs|js\/.+\.js|css\/.+\.css|assets\/.+\.(svg|png|jpg|webp))$/;
const FORBIDDEN = /(^|\/)(test|scripts|\.github|node_modules|editor|sdkjs|web-apps|\.studio|\.env[^/]*|\.secrets?)(\/|$)|\.(wasm|br|zst|tar|gz|pptx|docx|pem|key)$/;
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'index.html', 'bin/cli.mjs', 'server/http.mjs', 'server/agents/jobs.mjs', 'js/app.js', 'js/vendor/codemirror.js', 'css/app.css'];

const problems = [];
for (const f of files) {
  if (FORBIDDEN.test(f)) problems.push(`must not be published: ${f}`);
  else if (!ALLOWED.test(f)) problems.push(`not on the list of published files: ${f}`);
}
for (const f of REQUIRED) if (!files.includes(f)) problems.push(`missing: ${f}`);
if (pack.size > MAX_PACKED) problems.push(`package is ${(pack.size / 1e6).toFixed(1)} MB packed (limit ${MAX_PACKED / 1e6} MB)`);
if (pack.unpackedSize > MAX_UNPACKED) problems.push(`package is ${(pack.unpackedSize / 1e6).toFixed(1)} MB unpacked (limit ${MAX_UNPACKED / 1e6} MB)`);

console.log(`${pack.name}@${pack.version}: ${pack.entryCount} files, ${(pack.size / 1e6).toFixed(2)} MB packed, ${(pack.unpackedSize / 1e6).toFixed(2)} MB unpacked`);
if (problems.length) { console.error(problems.map(p => `  ✗ ${p}`).join('\n')); process.exit(1); }
console.log('  ✓ contents and size ok (no editor build, tests or scripts)');
