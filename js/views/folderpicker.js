// views/folderpicker.js — choose a folder on this computer (local app): the server lists directories, the browser
// never sees the file system itself. Hidden folders are not listed; typing a path (Enter) goes anywhere allowed.
import { el, button, input, icon, notice } from '../ui.js';
import { folderBackend } from '../fs/backend-folder.js';

/** Resolves to an absolute folder path, or null. `action`: the confirm label; `rowAction`: every listed folder gets
 *  that button too (Open). */
export function pickFolder({ title = 'Choose a folder', start = '', action = 'Choose', rowAction = false } = {}) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'dlg folder-dlg', 'aria-label': title });
    const path = input({ value: start, spellcheck: 'false', 'aria-label': 'Folder path', placeholder: '~/path/to/folder' });
    const list = el('ul', { class: 'folder-list', 'aria-label': 'Folders' });
    const msg = el('div', {});
    let cur = null, seq = 0;
    const ok = button({ label: action, variant: 'primary', onClick: () => finish(path.value.trim() || cur?.path) });
    const finish = v => { dlg.close(); resolve(v || null); };
    async function show(p) {
      msg.replaceChildren(); const n = ++seq; let got;
      try { got = await folderBackend.browse(p); } catch (e) { if (n === seq) msg.replaceChildren(notice('error', e.message)); return; }
      if (n !== seq) return; cur = got; // a later request (typed path) wins
      path.value = cur.path;
      const row = d => {
        const full = `${cur.path}/${d.name}`;
        return el('li', { class: 'folder-row' },
          el('button', { type: 'button', class: 'folder-item', onClick: () => show(full), onDblclick: () => (rowAction || d.isProject) && finish(full) }, icon(d.isProject ? 'presentation' : 'folder', 'sm'), d.name, d.isProject ? el('span', { class: 'meta' }, ' course') : null),
          rowAction ? button({ label: action, size: 'sm', variant: 'ghost', attrs: { 'aria-label': `${action} ${d.name}` }, onClick: () => finish(full) }) : null);
      };
      list.replaceChildren(...(cur.parent ? [el('li', {}, el('button', { type: 'button', class: 'folder-item', onClick: () => show(cur.parent) }, icon('chevron-right', 'sm up'), '..'))] : []), ...cur.dirs.map(row));
      if (!cur.dirs.length) list.append(el('li', { class: 'meta' }, 'No subfolders'));
    }
    path.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); show(path.value.trim()); } });
    dlg.append(el('div', { class: 'dlg-body' }, el('h3', {}, title), path, list, msg,
      el('div', { class: 'dlg-actions' }, button({ label: 'Cancel', onClick: () => finish(null) }), ok)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg); dlg.showModal(); show(start);
  });
}
