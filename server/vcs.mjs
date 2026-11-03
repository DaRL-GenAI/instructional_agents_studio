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

/** Folders that never belong in a course's history (dependencies, caches); written to .git/info/exclude of a
 *  repository the app created, so a folder opened in place does not commit them. */
export const EXCLUDE = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.ipynb_checkpoints/', '.tox/', '.mypy_cache/', '.pytest_cache/', '.cache/', '.DS_Store', 'Thumbs.db'];
/** The app's scratch space as a .gitignore inside .studio/: works in any repository without touching the user's
 *  own .gitignore. */
export const STUDIO_IGNORE = '# Instructional Agents: scratch space\ndecks/\njobs/\ntrash/\nbackup/\nsessions/\n';

/** A folder opened in place: a new repository when it has none (with EXCLUDE), an existing one is used as it is.
 *  Returns 'new' | 'existing'. */
export async function initInPlace(dir) {
  const existing = fs.existsSync(path.join(dir, '.git'));
  if (!existing) {
    await git.init({ fs, dir, defaultBranch: 'main' });
    fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
    if (!fs.existsSync(path.join(dir, '.gitignore'))) fs.writeFileSync(path.join(dir, '.gitignore'), GITIGNORE);
  }
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio', '.gitignore'), STUDIO_IGNORE);
  return existing ? 'existing' : 'new';
}

/** Older project folders: add ignore lines added since (only to a .gitignore the app wrote). */
export function ensureIgnores(dir) {
  const f = path.join(dir, '.gitignore'); let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return; }
  if (!t.startsWith('# Instructional Agents')) return;
  const missing = GITIGNORE.split('\n').filter(l => l && !l.startsWith('#') && !t.split('\n').includes(l));
  if (missing.length) fs.writeFileSync(f, t.replace(/\n?$/, '\n') + missing.join('\n') + '\n');
}

export async function head(dir) { try { return await git.resolveRef({ fs, dir, ref: 'HEAD' }); } catch { return null; } }

/** Commit the given paths (added, changed or deleted) and nothing else: the new tree is HEAD's tree with these
 *  paths replaced by what is on disk, so whatever else sits in the index (changes the user staged in a repository of
 *  their own) is neither committed nor touched. The index is updated for these paths. Returns the new head, or the old
 *  one when nothing changed. Ignored paths are skipped. */
export async function commit(dir, paths, message) {
  const prev = await head(dir);
  const changes = new Map();
  for (const p of new Set(paths)) {
    if (!p || await git.isIgnored({ fs, dir, filepath: p })) continue;
    const abs = path.join(dir, p); let st = null; try { st = fs.lstatSync(abs); } catch { /* deleted */ }
    if (st && st.isFile()) changes.set(p, { oid: await git.writeBlob({ fs, dir, blob: fs.readFileSync(abs) }), mode: st.mode & 0o111 ? '100755' : '100644' });
    else if (!st) changes.set(p, null);
  }
  if (!changes.size && prev) return prev;
  const base = prev ? (await git.readCommit({ fs, dir, oid: prev })).commit.tree : null;
  const tree = (await treeWith(dir, base, changes)) || await git.writeTree({ fs, dir, tree: [] });
  if (prev && tree === base) { await syncIndex(dir, changes); return prev; }
  const oid = await git.commit({ fs, dir, message, author: author(), tree, parent: prev ? [prev] : [] });
  await syncIndex(dir, changes);
  return oid;
}

/** A tree: `base` (oid or null) with `changes` (relative path → { oid, mode } | null) applied. null when empty. */
async function treeWith(dir, base, changes) {
  const entries = new Map(base ? (await git.readTree({ fs, dir, oid: base })).tree.map(e => [e.path, e]) : []);
  const sub = new Map();
  for (const [p, v] of changes) {
    const i = p.indexOf('/');
    if (i < 0) { if (v) entries.set(p, { mode: v.mode, path: p, oid: v.oid, type: 'blob' }); else entries.delete(p); continue; }
    const name = p.slice(0, i); if (!sub.has(name)) sub.set(name, new Map()); sub.get(name).set(p.slice(i + 1), v);
  }
  for (const [name, ch] of sub) {
    const cur = entries.get(name);
    const oid = await treeWith(dir, cur?.type === 'tree' ? cur.oid : null, ch);
    if (oid) entries.set(name, { mode: '040000', path: name, oid, type: 'tree' }); else if (cur?.type === 'tree') entries.delete(name);
  }
  if (!entries.size) return null;
  return git.writeTree({ fs, dir, tree: [...entries.values()] });
}
async function syncIndex(dir, changes) {
  for (const [p, v] of changes) {
    try { if (v) await git.add({ fs, dir, filepath: p }); else await git.remove({ fs, dir, filepath: p }); } catch { /* the index follows on the next commit */ }
  }
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

/** The commits that changed one file, newest first: [{ oid, message, at }] (the file may be gone by now). */
export async function fileLog(dir, filepath, depth = 100) {
  let l; try { l = await git.log({ fs, dir, filepath, depth, force: true }); } catch { return []; }
  return l.map(c => ({ oid: c.oid, message: c.commit.message.trim(), at: new Date(c.commit.author.timestamp * 1000).toISOString() }));
}
