#!/usr/bin/env node
// editor-npm.mjs — the npm package `instructional-agents-editor` from a trimmed editor build (scripts/trim-editor.mjs).
// The app lists it under optionalDependencies, so `npx instructional-agents` / `npm install -g instructional-agents`
// installs the editor on the user's computer with the app: no download at run time and no hosted editor.
// It is a separate package because the editor is AGPL-3.0 and the app is MIT.
//
//   node scripts/editor-npm.mjs <trimmed editor> --version X.Y.Z --source <git URL of the fork> --commit <sha> [out]
//   node scripts/editor-npm.mjs <trimmed editor> --local [out]       a private package for testing (cannot be published)
//
// out defaults to <trimmed editor>-npm/. Then: cd out && npm pack (or npm publish --access public).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const pos = argv.filter((a, i) => !a.startsWith('--') && !['--version', '--source', '--commit'].includes(argv[i - 1]));
const local = argv.includes('--local');
const src = path.resolve(pos[0] || '');
if (!pos[0] || !fs.existsSync(path.join(src, 'editor.html'))) { console.error('usage: node scripts/editor-npm.mjs <trimmed editor> (--version X.Y.Z --source URL --commit SHA | --local) [out]'); process.exit(2); }
const app = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const version = opt('--version') || (local ? app.optionalDependencies?.['instructional-agents-editor']?.replace(/^[\^~]/, '') || '0.0.0-local' : null);
const source = opt('--source'), commit = opt('--commit');
// AGPL: whoever gets the editor must be able to get its source, so a publishable package names the exact commit
if (!local && !(version && source && /^[0-9a-f]{7,40}$/.test(commit || ''))) { console.error('A publishable package needs --version, --source (the fork) and --commit (the commit it was built from); use --local for a test package.'); process.exit(2); }
const out = path.resolve(pos[1] || `${src}-npm`);

fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
fs.cpSync(src, path.join(out, 'dist'), { recursive: true });
for (const f of ['LICENSE', 'NOTICE']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(out, f));
const pkg = {
  name: 'instructional-agents-editor', version,
  description: 'The slides and documents editor of Instructional Agents (a trimmed ONLYOFFICE web build from ranuts/document), served by the local app at /editor/.',
  license: 'AGPL-3.0-only',
  ...(local ? { private: true } : { repository: { type: 'git', url: source }, gitHead: commit }),
  files: ['dist', 'LICENSE', 'NOTICE', 'README.md'],
};
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'README.md'), `# instructional-agents-editor

The presentation and document editors used by [Instructional Agents](https://github.com/DaRL-GenAI/instructional_agents_studio)
(\`npx instructional-agents\`): a trimmed web build of [ranuts/document](https://github.com/ranuts/document), which embeds the
ONLYOFFICE editors (sdkjs, web-apps). The app installs this package with itself and serves \`dist/\` at \`/editor/\` on
127.0.0.1; it talks to the editor only through postMessage.

License: AGPL-3.0 (see LICENSE and NOTICE).${local ? '' : ` Source: ${source} at commit ${commit}.`}
`);
const size = d => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`${pkg.name}@${version}${local ? ' (private, for testing)' : ''}: ${(size(out) / 1e6).toFixed(1)} MB in ${out}\n  next: cd ${JSON.stringify(out)} && npm pack`);
