// views/openfolder.js — open any folder (local app): a course folder opens; an empty folder becomes a course after a
// name; a folder with files is offered as a course with its files kept where they are, then sorted by the import
// (they become the course's sources in place). Cancel leaves the folder as it was.
import { el, button, input, field, icon, toast, fmtBytes } from '../ui.js';
import { go } from '../router.js';
import { newProject } from '../model.js';
import { folderBackend } from '../fs/backend-folder.js';
import { openImport } from '../import/dialog.js';

const tipBtn = tip => el('button', { type: 'button', class: 'info-tip', 'aria-label': tip, 'data-tip': tip }, icon('info', 'sm'));

/** Open `dir`. Resolves to the project id, or null (cancelled or refused). */
export async function openFolder(ctx, dir) {
  let r; try { r = await folderBackend.open(dir); } catch (e) { toast(e.message, 'error'); return null; }
  if (!r.folder) { await ctx.reloadProjects(); go('p', r.id, 'overview'); return r.id; }
  const f = r.folder;
  const name = await askAdopt(f); if (name == null) return null;
  let a; try { a = await folderBackend.adopt(f.dir, newProject({ course: { name } })); } catch (e) { toast(e.message, 'error'); return null; }
  await ctx.reloadProjects();
  const id = a.project.id;
  if (!a.files.length) { toast('Course created', 'ok'); go('p', id, 'basics'); return id; }
  go('p', id, 'overview');
  for (let i = 0; i < 100 && ctx.store?.id !== id; i++) await new Promise(res => setTimeout(res, 100));
  if (ctx.store?.id !== id) { toast('The course did not open', 'error'); return id; }
  await openImport(ctx, a.files.map(x => ({ path: x.path, size: x.size, inPlace: true })), { inPlace: true });
  return id;
}

/** "Open <name> as a course?" (files) or "New course in <name>" (empty). Resolves to the course name, or null. */
export function askAdopt(f) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'dlg adopt-dlg', 'aria-labelledby': 'adopt-title' });
    const name = input({ value: f.name, required: true, autocomplete: 'off', spellcheck: 'false' });
    const finish = v => { if (dlg.open) dlg.close(); resolve(v); };
    const ok = button({ label: f.empty ? 'Create course' : 'Open as course', variant: 'primary', type: 'submit' });
    const tip = f.empty ? 'The course files are created in this folder.' : `Your files stay where they are and are not changed. Next you choose which ones the course uses.${f.git ? ' This folder is a git repository: only the app’s own files are committed, on the current branch.' : ' The folder becomes a git repository holding them as they are.'}`;
    const summary = f.empty ? null : el('div', { class: 'adopt-summary' },
      el('p', {}, el('b', {}, `${f.count} file${f.count === 1 ? '' : 's'}`), el('span', { class: 'meta' }, ` · ${fmtBytes(f.bytes)}`), tipBtn(tip)),
      el('ul', { class: 'adopt-kinds', 'aria-label': 'Kinds of files' }, ...f.kinds.map(([k, n]) => el('li', {}, `${k} `, el('span', { class: 'meta' }, String(n))))),
      el('ul', { class: 'adopt-top', 'aria-label': 'Top-level items' }, ...f.top.map(t => el('li', {}, t)), f.more ? el('li', { class: 'meta' }, `+${f.more} more`) : null));
    const form = el('form', { class: 'dlg-body', method: 'dialog', onSubmit: e => { e.preventDefault(); const v = name.value.trim(); if (!v) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; } finish(v); } },
      el('h3', { id: 'adopt-title' }, f.empty ? `New course in ${f.name}` : `Open ${f.name} as a course?`),
      el('p', { class: 'meta adopt-path' }, f.dir, f.empty ? tipBtn(tip) : null),
      summary, field('Course name', name),
      el('div', { class: 'dlg-actions' }, button({ label: 'Cancel', variant: 'ghost', onClick: () => finish(null) }), ok));
    dlg.append(form);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg); dlg.showModal(); name.focus(); name.select();
  });
}
