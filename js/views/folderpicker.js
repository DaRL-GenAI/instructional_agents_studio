// views/folderpicker.js — choose a folder on this computer (local app): the server lists directories, the browser
// never sees the file system itself.
import { el, button, input, icon, notice } from '../ui.js';
import { folderBackend } from '../fs/backend-folder.js';

/** Resolves to an absolute folder path, or null. `projectsOnly`: confirm only on a course folder. */
export function pickFolder({ title = 'Choose a folder', start = '', projectsOnly = false } = {}) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'dlg folder-dlg' });
    const path = input({ value: start, spellcheck: 'false', 'aria-label': 'Folder path' });
    const list = el('ul', { class: 'folder-list', role: 'listbox', 'aria-label': 'Folders' });
    const msg = el('div', {});
    let cur = null;
    const ok = button({ label: projectsOnly ? 'Open' : 'Choose', variant: 'primary', onClick: () => finish(path.value.trim() || cur?.path) });
    const finish = v => { dlg.close(); resolve(v || null); };
    async function show(p) {
      msg.replaceChildren();
      try { cur = await folderBackend.browse(p); } catch (e) { msg.replaceChildren(notice('error', e.message)); return; }
      path.value = cur.path; ok.disabled = projectsOnly && !cur.isProject;
      list.replaceChildren(...(cur.parent ? [el('li', {}, el('button', { type: 'button', class: 'folder-item', onClick: () => show(cur.parent) }, icon('chevron-right', 'sm up'), '..'))] : []),
        ...cur.dirs.map(d => el('li', {}, el('button', { type: 'button', class: 'folder-item', onClick: () => show(`${cur.path}/${d.name}`), onDblclick: () => d.isProject && finish(`${cur.path}/${d.name}`) }, icon(d.isProject ? 'presentation' : 'folder', 'sm'), d.name, d.isProject ? el('span', { class: 'meta' }, ' course') : null))));
      if (!cur.dirs.length) list.append(el('li', { class: 'meta' }, 'No subfolders'));
    }
    path.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); show(path.value.trim()); } });
    dlg.append(el('div', { class: 'dlg-body' }, el('h3', {}, title), path, list, msg,
      el('div', { class: 'dlg-actions' }, button({ label: 'Cancel', onClick: () => finish(null) }), ok)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg); dlg.showModal(); show(start);
  });
}
