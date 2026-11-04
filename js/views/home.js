// views/home.js — project list and creation.
import { el, button, field, input, select, textarea, empty, icon, fmtRel, toast, confirmDialog } from '../ui.js';
import { createProject, deleteProject, duplicateProject, importProject, moduleProgress, account, exportProject } from '../state.js';
import { href, go } from '../router.js';
import { download, textBlob, slug } from '../export.js';
import { LOCAL } from '../fs/api.js';
import { dirs, plainRecent } from '../fs/backend-folder.js';
import { pickFolder } from './folderpicker.js';
import { openFolder } from './openfolder.js';
import { startFromMaterials } from '../import/dialog.js';

export function render(ctx) {
  const page = el('div', { class: 'page' });
  const projects = ctx.projects || [];
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', { style: 'font-size:var(--fs-7)' }, 'Projects'), el('p', {}, 'Each project is one course: its basics, ADDIE design, slides, assessments and lecture videos, with a full audit trail. ' + (LOCAL ? 'Each project is a folder on this computer.' : 'Everything is stored in this browser.')))));
  if (!account.apiKey) page.append(el('div', { style: 'margin-bottom:20px' }, el('div', { class: 'notice warn' }, icon('key'), el('div', {}, 'No API key yet. Add one under ', el('a', { href: href('account', 'privacy') }, 'Account → API key & privacy'), ' before generating anything; you can still create and edit projects.'))));

  const grid = el('div', { class: 'hero-row' });
  // list
  const listPanel = el('div', { class: 'panel' });
  if (!projects.length) listPanel.append(el('div', { style: 'padding:8px' }, empty({ icon: 'folder', title: 'No projects yet', body: 'Create a course on the right, or import a project JSON exported from Studio.', actions: [LOCAL ? openFolderButton(ctx) : null, importButton(ctx)].filter(Boolean) })));
  else {
    listPanel.append(el('div', { class: 'panel-head' }, el('h2', {}, `${projects.length} ${LOCAL ? 'recent ' : ''}project${projects.length > 1 ? 's' : ''}`), el('div', { class: 'btn-row' }, LOCAL ? openFolderButton(ctx) : null, importButton(ctx))));
    for (const p of projects) {
      const prog = moduleProgress(p);
      const chip = (label, pr) => el('span', { class: 'prog-chip' }, el('span', { class: 'bar' }, el('i', { style: `width:${pr.total ? Math.round(100 * pr.done / pr.total) : 0}%` })), label);
      listPanel.append(el('a', { class: 'project-card', href: href('p', p.id, 'overview') },
        el('div', {}, el('h3', {}, p.name || 'Untitled course'), el('div', { class: 'meta' }, `${p.course.subject || 'No subject'} · ${p.course.level} · ${p.chapters.length} chapters · updated ${fmtRel(p.updatedAt)}${dirs.get(p.id) ? ` · ${dirs.get(p.id)}` : ''}`),
          el('div', { class: 'prog-row' }, chip('Design', prog.design), chip('Slides', prog.slides), chip('Assessments', prog.assessments), chip('Videos', prog.videos))),
        el('div', { class: 'btn-row', onClick: e => { e.preventDefault(); e.stopPropagation(); } },
          button({ icon: 'copy', size: 'sm', variant: 'ghost', title: 'Duplicate', onClick: async () => { await duplicateProject(p.id); toast('Project duplicated', 'ok'); await ctx.reloadProjects(); ctx.render(); } }),
          button({ icon: 'download', size: 'sm', variant: 'ghost', title: 'Export JSON', onClick: async () => { await ctx.store?.flush(); download(textBlob(await exportProject(p.id), 'application/json'), `${slug(p.name)}_project.json`); } }),
          button({ icon: 'trash', size: 'sm', variant: 'ghost', title: 'Delete', onClick: async () => { if (await confirmDialog({ title: `Delete “${p.name}”?`, body: LOCAL ? 'Removes it from the recent list. The folder and its files stay on disk.' : 'All generated material, media and the audit trail of this project are removed from this browser. Export it first if you want a copy.', confirmLabel: LOCAL ? 'Remove' : 'Delete project', danger: true })) { await deleteProject(p.id); await ctx.reloadProjects(); ctx.render(); toast('Project deleted'); } } }))));
    }
  }
  if (LOCAL) for (const f of plainRecent) { // recent folders whose course files are gone
    listPanel.append(el('div', { class: 'project-card plain' },
      el('div', {}, el('h3', {}, f.name), el('div', { class: 'meta' }, f.dir)),
      el('div', { class: 'btn-row' },
        button({ label: 'Open', size: 'sm', attrs: { 'aria-label': `Open ${f.name}` }, onClick: () => openFolder(ctx, f.dir) }),
        f.id ? button({ icon: 'x', size: 'sm', variant: 'ghost', title: `Remove ${f.name} from the list`, onClick: async () => { await deleteProject(f.id); await ctx.reloadProjects(); ctx.render(); } }) : null)));
  }
  grid.append(listPanel, createPanel(ctx));
  page.append(grid);
  return page;
}

function createPanel(ctx) {
  const name = input({ placeholder: 'e.g. LLM-based Agents', required: true, autocomplete: 'off' });
  const subject = input({ placeholder: 'e.g. Computer Science' });
  const level = select(['Undergraduate', 'Graduate', 'Professional development', 'High school'], 'Undergraduate');
  const weeks = input({ type: 'number', min: 1, max: 30, value: 14 });
  const language = select(['English', '中文', 'Español', 'Français', 'Deutsch', '日本語'], 'English');
  const audience = textarea({ rows: 2, placeholder: 'Who takes it? Prior knowledge, size, motivation.' });
  // Local app: the folder the project lives in (follows the name until edited; the folder the app was started in when it is empty).
  const folder = LOCAL ? input({ value: LOCAL.pendingDir || '', placeholder: `${LOCAL.projectsRoot}/…`, spellcheck: 'false', oninput: () => { folder.dataset.touched = '1'; } }) : null;
  if (folder && LOCAL.pendingDir) folder.dataset.touched = '1';
  if (folder) name.addEventListener('input', () => { if (!folder.dataset.touched) folder.value = name.value.trim() ? `${LOCAL.projectsRoot}/${slug(name.value.trim()).replace(/_/g, '-')}` : ''; });
  const browse = folder ? button({ label: 'Browse…', size: 'sm', onClick: async () => { const d = await pickFolder({ title: 'Folder for the new course', start: folder.value }); if (d) { folder.value = d; folder.dataset.touched = '1'; } } }) : null;
  const form = el('form', { class: 'panel', onSubmit: async e => {
    e.preventDefault(); if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
    const p = await createProject({ course: { name: name.value.trim(), subject: subject.value.trim(), level: level.value, weeks: Number(weeks.value) || 14, language: language.value, audience: audience.value.trim() } }, { dir: folder?.value.trim() || undefined }).catch(err => { toast(err.message, 'error'); return null; });
    if (!p) return;
    await ctx.reloadProjects(); toast('Project created', 'ok'); go('p', p.id, 'basics');
  } });
  form.append(el('div', { class: 'panel-head' }, el('h2', {}, 'New course')), el('div', { class: 'panel-body', style: 'display:flex;flex-direction:column;gap:14px' },
    field('Course name', name), field('Subject area', subject), el('div', { class: 'form-grid' }, field('Level', level), field('Weeks', weeks)), field('Language of the materials', language), field('Learners', audience, { hint: 'Optional now; refine it under Course basics.' }),
    folder ? field('Folder', el('div', { class: 'btn-row', style: 'flex-wrap:nowrap' }, folder, browse), { hint: 'Created if missing. Files already in it are kept.' }) : null,
    el('div', { class: 'btn-row' }, button({ label: 'Create project', icon: 'plus', variant: 'primary', type: 'submit' }), button({ label: 'Start from existing materials', icon: 'upload', onClick: () => startFromMaterials(ctx, { create: fromMaterials }) }))));
  // the same course facts; the name defaults to the folder that was picked
  async function fromMaterials(folderName) {
    const n = name.value.trim() || folderName || 'Imported course';
    const dir = folder?.dataset.touched ? folder.value.trim() : (folder && !name.value.trim() && folderName ? `${LOCAL.projectsRoot}/${slug(n).replace(/_/g, '-')}` : folder?.value.trim());
    const p = await createProject({ course: { name: n, subject: subject.value.trim(), level: level.value, weeks: Number(weeks.value) || 14, language: language.value, audience: audience.value.trim() } }, { dir: dir || undefined }).catch(err => { toast(err.message, 'error'); return null; });
    if (p) await ctx.reloadProjects();
    return p;
  }
  return form;
}

export function importButton(ctx) {
  const inp = el('input', { type: 'file', accept: '.json', hidden: true });
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const p = await importProject(await f.text()); await ctx.reloadProjects(); toast('Project imported', 'ok'); go('p', p.id, 'overview'); } catch (e) { toast(`Import failed: ${e.message}`, 'error'); } };
  return el('span', {}, inp, button({ label: 'Import JSON', icon: 'upload', size: 'sm', onClick: () => inp.click() }));
}

function openFolderButton(ctx) {
  return button({ label: 'Open folder', icon: 'folder', size: 'sm', onClick: async () => {
    const d = await pickFolder({ title: 'Open a folder', action: 'Open', rowAction: true }); if (d) await openFolder(ctx, d);
  } });
}
