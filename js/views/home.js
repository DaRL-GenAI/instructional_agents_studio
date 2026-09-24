// views/home.js — project list and creation.
import { el, button, field, input, select, textarea, empty, icon, fmtRel, toast, confirmDialog } from '../ui.js';
import { createProject, deleteProject, duplicateProject, importProject, moduleProgress, account } from '../state.js';
import { href, go } from '../router.js';
import { download, textBlob, slug } from '../export.js';

export function render(ctx) {
  const page = el('div', { class: 'page' });
  const projects = ctx.projects || [];
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', { style: 'font-size:var(--fs-7)' }, 'Projects'), el('p', {}, 'Each project is one course: its basics, ADDIE design, slides, assessments and lecture videos, with a full audit trail. Everything is stored in this browser.'))));
  if (!account.apiKey) page.append(el('div', { style: 'margin-bottom:20px' }, el('div', { class: 'notice warn' }, icon('key'), el('div', {}, 'No API key yet. Add one under ', el('a', { href: href('account', 'privacy') }, 'Account → API key & privacy'), ' before generating anything; you can still create and edit projects.'))));

  const grid = el('div', { class: 'hero-row' });
  // list
  const listPanel = el('div', { class: 'panel' });
  if (!projects.length) listPanel.append(el('div', { style: 'padding:8px' }, empty({ icon: 'folder', title: 'No projects yet', body: 'Create a course on the right, or import a project JSON exported from Studio.', actions: [importButton(ctx)] })));
  else {
    listPanel.append(el('div', { class: 'panel-head' }, el('h2', {}, `${projects.length} project${projects.length > 1 ? 's' : ''}`), importButton(ctx)));
    for (const p of projects) {
      const prog = moduleProgress(p);
      const chip = (label, pr) => el('span', { class: 'prog-chip' }, el('span', { class: 'bar' }, el('i', { style: `width:${pr.total ? Math.round(100 * pr.done / pr.total) : 0}%` })), label);
      listPanel.append(el('a', { class: 'project-card', href: href('p', p.id, 'overview') },
        el('div', {}, el('h3', {}, p.name || 'Untitled course'), el('div', { class: 'meta' }, `${p.course.subject || 'No subject'} · ${p.course.level} · ${p.chapters.length} chapters · updated ${fmtRel(p.updatedAt)}`),
          el('div', { class: 'prog-row' }, chip('Design', prog.design), chip('Slides', prog.slides), chip('Assessments', prog.assessments), chip('Videos', prog.videos))),
        el('div', { class: 'btn-row', onClick: e => { e.preventDefault(); e.stopPropagation(); } },
          button({ icon: 'copy', size: 'sm', variant: 'ghost', title: 'Duplicate', onClick: async () => { await duplicateProject(p.id); toast('Project duplicated', 'ok'); await ctx.reloadProjects(); ctx.render(); } }),
          button({ icon: 'download', size: 'sm', variant: 'ghost', title: 'Export JSON', onClick: () => download(textBlob(JSON.stringify(p, null, 2), 'application/json'), `${slug(p.name)}_project.json`) }),
          button({ icon: 'trash', size: 'sm', variant: 'ghost', title: 'Delete', onClick: async () => { if (await confirmDialog({ title: `Delete “${p.name}”?`, body: 'All generated material, media and the audit trail of this project are removed from this browser. Export it first if you want a copy.', confirmLabel: 'Delete project', danger: true })) { await deleteProject(p.id); await ctx.reloadProjects(); ctx.render(); toast('Project deleted'); } } }))));
    }
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
  const form = el('form', { class: 'panel', onSubmit: async e => {
    e.preventDefault(); if (!name.value.trim()) { name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
    const p = await createProject({ course: { name: name.value.trim(), subject: subject.value.trim(), level: level.value, weeks: Number(weeks.value) || 14, language: language.value, audience: audience.value.trim() } });
    await ctx.reloadProjects(); toast('Project created', 'ok'); go('p', p.id, 'basics');
  } });
  form.append(el('div', { class: 'panel-head' }, el('h2', {}, 'New course')), el('div', { class: 'panel-body', style: 'display:flex;flex-direction:column;gap:14px' },
    field('Course name', name), field('Subject area', subject), el('div', { class: 'form-grid' }, field('Level', level), field('Weeks', weeks)), field('Language of the materials', language), field('Learners', audience, { hint: 'Optional now; refine it under Course basics.' }),
    el('div', { class: 'btn-row' }, button({ label: 'Create project', icon: 'plus', variant: 'primary', type: 'submit' }))));
  return form;
}

export function importButton(ctx) {
  const inp = el('input', { type: 'file', accept: '.json', hidden: true });
  inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const p = await importProject(await f.text()); await ctx.reloadProjects(); toast('Project imported', 'ok'); go('p', p.id, 'overview'); } catch (e) { toast(`Import failed: ${e.message}`, 'error'); } };
  return el('span', {}, inp, button({ label: 'Import JSON', icon: 'upload', size: 'sm', onClick: () => inp.click() }));
}
