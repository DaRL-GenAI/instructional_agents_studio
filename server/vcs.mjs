// vcs.mjs — the project folder is a git repository (isomorphic-git: no git binary needed). One commit per save.
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';

const author = () => ({ name: process.env.IA_GIT_NAME || 'Instructional Agents', email: process.env.IA_GIT_EMAIL || 'studio@localhost' });
export const GITIGNORE = `# Instructional Agents: generated media and scratch space stay out of git
build/
.studio/decks/
.studio/jobs/
.studio/trash/
.studio/backup/
.studio/sessions/
.DS_Store
`;

export async function init(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) await git.init({ fs, dir, defaultBranch: 'main' });
  if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
}

/** Older project folders: add ignore lines added since (only to a .gitignore the app wrote). */
export function ensureIgnores(dir) {
  const f = path.join(dir, '.gitignore'); let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return; }
  if (!t.startsWith('# Instructional Agents')) return;
  const missing = GITIGNORE.split('\n').filter(l => l && !l.startsWith('#') && !t.split('\n').includes(l));
  if (missing.length) fs.writeFileSync(f, t.replace(/\n?$/, '\n') + missing.join('\n') + '\n');
}

export async function head(dir) { try { return await git.resolveRef({ fs, dir, ref: 'HEAD' }); } catch { return null; } }

/** Stage the given paths (added, changed or deleted) and commit them. Returns the new head, or the old one when
 *  nothing changed. Ignored paths are skipped. */
export async function commit(dir, paths, message) {
  let staged = 0;
  for (const p of new Set(paths)) {
    if (await git.isIgnored({ fs, dir, filepath: p })) continue;
    if (fs.existsSync(path.join(dir, p))) await git.add({ fs, dir, filepath: p });
    else { try { await git.remove({ fs, dir, filepath: p }); } catch { continue; } }
    staged++;
  }
  const prev = await head(dir);
  if (!staged && prev) return prev;
  if (prev) { // skip empty commits: compare the index with HEAD for the staged paths
    const m = await git.statusMatrix({ fs, dir, filepaths: [...new Set(paths)] });
    if (!m.some(([, h, , s]) => (h === 0 && s !== 0) || (h === 1 && s !== 1))) return prev;
  }
  return git.commit({ fs, dir, message, author: author() });
}

/** Stage everything git does not ignore (first commit, import, duplicate). */
export async function commitAll(dir, message) {
  const m = await git.statusMatrix({ fs, dir });
  const changed = m.filter(([, h, w, s]) => !(h === 1 && w === 1 && s === 1)).map(([f]) => f);
  return commit(dir, changed, message);
}

export const log = (dir, depth = 50) => git.log({ fs, dir, depth }).then(l => l.map(c => ({ oid: c.oid, message: c.commit.message.trim(), at: new Date(c.commit.author.timestamp * 1000).toISOString() })));

/** A file's content at a commit (null when absent). */
export async function readAt(dir, oid, filepath) {
  try { const { blob } = await git.readBlob({ fs, dir, oid, filepath }); return Buffer.from(blob); } catch { return null; }
}

/** Branch, head and the last commit (the Workspace status bar). */
export async function summary(dir) {
  const branch = await git.currentBranch({ fs, dir, fullname: false }).catch(() => null);
  const last = (await log(dir, 1).catch(() => []))[0] || null;
  return { branch, head: last?.oid || null, last };
}

/** The files a commit changed (against its first parent): [paths]. */
export async function changedPaths(dir, oid) {
  const { commit } = await git.readCommit({ fs, dir, oid });
  const parent = commit.parent[0];
  const trees = parent ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })] : [git.TREE({ ref: oid })];
  const out = await git.walk({ fs, dir, trees, map: async (filepath, [a, b]) => {
    if (filepath === '.') return undefined;
    const [ta, tb] = [await a?.type(), parent ? await b?.type() : 'blob'];
    if (ta === 'tree' || tb === 'tree') return undefined;
    const [oa, ob] = parent ? [await a?.oid(), await b?.oid()] : [null, await a?.oid()];
    return oa !== ob ? filepath : undefined;
  } });
  return { parent: parent || null, message: commit.message.trim(), paths: out.filter(Boolean) };
}
