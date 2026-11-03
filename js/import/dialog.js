// import/dialog.js — bring an instructor's existing materials into a project: pick or drop a folder (or files) →
// read each file's text → sort them (rules, then one model call) → a table to confirm or correct → copy them into
// sources/ (one commit) and place them into stages (one commit). Re-uploading a file that is already a stage
// (same path, or very similar text) is offered as a new version of that stage, with a text diff.
import { el, button, icon, toast, notice, confirmDialog, fmtBytes } from '../ui.js';
import { go } from '../router.js';
import { makeSource } from '../ws/source.js';
import { extractJson } from '../llm.js';
import { diffLines } from '../diff.js';
import { extractText, digest, extOf, baseName, READABLE } from './extract.js';
import { ruleClassify, classifyMessages, decide, kindsFor, versionOf, KIND_LABEL, CHAPTER_KINDS } from './classify.js';
import { applyImport, importedStages, importMessage, targetKey } from './apply.js';

const MAX_FILES = 300, MAX_BYTES = 200 * 1024 * 1024;
const SKIP = /(^|\/)(\.[^/]*|__MACOSX|node_modules|Thumbs\.db|desktop\.ini)(\/|$)/i;

// ---------------------------------------------------------------- collecting files
/** A drop → [{ file, path }] with folders walked (path relative to what was dropped, the folder name included). */
export async function filesFromDrop(dt) {
  const entries = [...(dt?.items || [])].filter(i => i.kind === 'file').map(i => i.webkitGetAsEntry?.()).filter(Boolean); // synchronously, before any await
  if (!entries.length) return [...(dt?.files || [])].map(f => ({ file: f, path: f.name }));
  const out = [];
  const walk = async (entry, prefix) => {
    if (out.length > MAX_FILES * 2) return;
    if (entry.isFile) { const f = await new Promise((res, rej) => entry.file(res, rej)); out.push({ file: f, path: prefix + f.name }); return; }
    if (!entry.isDirectory || SKIP.test(entry.name)) return;
    const reader = entry.createReader();
    for (;;) { const batch = await new Promise((res, rej) => reader.readEntries(res, rej)); if (!batch.length) break; for (const e of batch) await walk(e, `${prefix}${entry.name}/`); }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
const fromInput = inp => [...inp.files].map(f => ({ file: f, path: f.webkitRelativePath || f.name }));
export const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');

/** The pick step: a drop zone with "Choose folder" / "Choose files". Resolves to [{ file, path }] or null. */
export function pickMaterials({ title = 'Import materials' } = {}) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'dlg imp-dlg', 'aria-label': title });
    const finish = v => { if (dlg.open) dlg.close(); resolve(v && v.length ? v : null); };
    const folder = el('input', { type: 'file', webkitdirectory: '', multiple: true, hidden: true, 'aria-label': 'Choose a folder', class: 'imp-folder' });
    const files = el('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose files', class: 'imp-files' });
    folder.onchange = () => finish(fromInput(folder)); files.onchange = () => finish(fromInput(files));
    const zone = el('div', { class: 'imp-drop', tabindex: '0', role: 'button', 'aria-label': 'Drop a folder or files here, or press Enter to choose a folder', onClick: () => folder.click(), onKeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); folder.click(); } } },
      icon('upload'), el('b', {}, 'Drop a folder or files'), el('span', { class: 'meta' }, 'Slides, Word, PDF, Markdown, notebooks, LaTeX'));
    zone.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); zone.classList.add('over'); } });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', async e => { e.preventDefault(); zone.classList.remove('over'); finish(await filesFromDrop(e.dataTransfer)); });
    dlg.append(el('div', { class: 'dlg-body' }, el('h3', {}, title), zone, folder, files,
      el('div', { class: 'dlg-actions' }, button({ label: 'Cancel', variant: 'ghost', onClick: () => finish(null) }), button({ label: 'Choose files…', onClick: () => files.click() }), button({ label: 'Choose folder…', variant: 'primary', onClick: () => folder.click() }))));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg); dlg.showModal(); zone.focus();
  });
}

// ---------------------------------------------------------------- the import
/** Import materials into the open project. `picked`: [{ file, path }] (from a drop); asks for them otherwise. */
export async function openImport(ctx, picked = null) {
  picked ||= await pickMaterials(); if (!picked) return false;
  const store = ctx.store; const src = makeSource(store);
  const list = picked.filter(x => x.file && !SKIP.test(x.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })).slice(0, MAX_FILES);
  if (!list.length) { toast('No files to import', 'error'); return false; }
  const dlg = el('dialog', { class: 'dlg imp-dlg wide', 'aria-label': 'Import materials' });
  const body = el('div', { class: 'dlg-body' });
  dlg.addEventListener('cancel', e => e.preventDefault()); // Escape: only the table's own Cancel ends an import
  dlg.append(body); document.body.append(dlg); dlg.showModal();
  const progress = (title, text) => body.replaceChildren(el('h3', {}, title), el('p', { class: 'imp-progress', role: 'status', 'aria-live': 'polite' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), text));
  let result = false;
  try {
    // 1. read
    const tree = await src.list().catch(() => ({ entries: [] }));
    const existing = new Set(tree.entries.filter(e => !e.dir).map(e => e.path));
    const candidates = importedStages(store.project);
    const rows = [];
    for (const [i, x] of list.entries()) {
      progress('Reading files', `${i + 1} / ${list.length} · ${x.path}`);
      const ext = extOf(x.path); const big = x.file.size > MAX_BYTES;
      const ex = !big && READABLE.has(ext) ? await extractText(x.path, x.file) : { text: '', title: '' };
      const sourcePath = `sources/${x.path}`;
      rows.push({ i, file: x.file, path: x.path, name: baseName(x.path), ext, size: x.file.size, sourcePath, text: ex.text, title: ex.title, error: ex.error, digest: digest(ex.text), big,
        version: big ? null : versionOf({ sourcePath, text: ex.text }, candidates), exists: existing.has(sourcePath) });
    }
    for (const r of rows) { r.rule = r.big ? { kind: 'ignore', confidence: 0.9, reason: `Larger than ${fmtBytes(MAX_BYTES)}` } : ruleClassify(r.path, r.text); if (r.version) r.oldText = candidates.find(c => c.key === r.version.key)?.text || ''; }
    // 2. sort: one model call for everything that is not a new version
    const fresh = rows.filter(r => !r.version);
    const chapters = store.project.chapters.map(c => ({ id: c.id, title: c.title }));
    let answer = null, modelNote = null;
    const needModel = fresh.some(r => !r.big && (r.rule.confidence < 0.8 || CHAPTER_KINDS.has(r.rule.kind) || r.rule.kind === 'reference'));
    if (fresh.length && needModel) {
      if (!store.apiKey) modelNote = 'No API key: sorted by file names and content rules only.';
      else {
        progress('Sorting files', `Asking ${store.settings.model} about ${fresh.length} file${fresh.length > 1 ? 's' : ''}…`);
        try {
          const res = await ctx.pipe.call({ where: 'course', stage: 'Import materials', agent: 'File sorter', json: true, messages: classifyMessages(fresh.map(r => ({ path: r.path, size: r.size, digest: r.digest, rule: r.rule })), { chapters, course: store.project.course?.name }) });
          answer = extractJson(res.text, 'object');
        } catch (e) { modelNote = `The model call failed (${e.message}); sorted by rules only.`; }
      }
    }
    const { decisions, newChapters } = decide(fresh.map(r => ({ path: r.path, size: r.size, title: r.title, rule: r.rule })), answer, { chapters });
    fresh.forEach((r, k) => Object.assign(r, decisions[k], { action: 'new', selected: decisions[k].kind !== 'ignore' }));
    for (const r of rows.filter(x => x.version)) Object.assign(r, { kind: 'version', chapter: '', confidence: r.version.score, reason: r.version.why === 'path' ? `Same file as ${r.version.label}` : `${Math.round(r.version.score * 100)}% similar to ${r.version.label}`, action: 'version', selected: true, by: 'match' });
    // 3. confirm
    const plan = await confirmTable(dlg, body, { rows, chapters, newChapters, modelNote, existing });
    if (!plan) return false;
    // 4. apply
    progress('Importing', 'Copying files into sources/…');
    result = await applyPlan(ctx, src, plan, existing);
  } catch (e) { console.error(e); toast(`Import failed: ${e.message}`, 'error'); }
  finally { if (dlg.open) dlg.close(); dlg.remove(); }
  return result;
}

async function applyPlan(ctx, src, { rows, newChapters }, existing) {
  const store = ctx.store;
  const chosen = rows.filter(r => r.selected && r.kind !== 'ignore');
  if (!chosen.length) return false;
  // a file that replaces nothing keeps its own name: "hw1.docx" next to an existing one becomes "hw1-2.docx"
  const taken = new Set(existing);
  for (const r of chosen) {
    if (r.action === 'version' || !taken.has(r.sourcePath) || !r.versionDeclined) { taken.add(r.sourcePath); continue; }
    const m = r.sourcePath.match(/^(.*?)(\.[^./]+)?$/); let n = 2; while (taken.has(`${m[1]}-${n}${m[2] || ''}`)) n++;
    r.sourcePath = `${m[1]}-${n}${m[2] || ''}`; taken.add(r.sourcePath);
  }
  await store.flush();
  await src.importSources(chosen.map(r => ({ path: r.sourcePath.slice('sources/'.length), blob: r.file })));
  let out;
  store.held = true;
  try {
    out = await applyImport(store, chosen.map(r => ({ path: r.sourcePath, name: r.name, ext: r.ext, kind: r.kind, chapter: r.chapter, action: r.action, version: r.version, text: r.text, blob: r.file })), { newChapters });
  } finally { store.held = false; }
  store.dirty = true;
  await store.flush({ message: importMessage(store.project, out.stages, chosen.length) });
  ctx.render();
  const n = out.stages.length;
  toast(`${chosen.length} file${chosen.length > 1 ? 's' : ''} imported${n ? ` · ${n} stage${n > 1 ? 's' : ''}` : ''}${out.skipped.length ? ` · ${out.skipped.length} not placed: ${out.skipped.map(s => `${baseName(s.path)} (${s.why})`).join(', ')}` : ''}`, out.skipped.length ? 'error' : 'ok');
  go('p', store.id, 'workspace');
  return out;
}

// ---------------------------------------------------------------- the confirmation table
const size = b => b < 1024 ? `${b} B` : fmtBytes(b);
const level = c => c >= 0.8 ? ['high', 'High'] : c >= 0.5 ? ['med', 'Medium'] : ['low', 'Low'];
const COURSE_KINDS = new Set(['syllabus', 'objectives', 'exam_midterm', 'exam_final']);

function confirmTable(dlg, body, { rows, chapters, newChapters, modelNote }) {
  return new Promise(resolve => {
    const proposed = [...newChapters];
    const chapterOptions = r => [['', '—'], ...chapters.map((c, i) => [c.id, `${i + 1}. ${c.title}`]), ...proposed.map(ref => [ref, `New: ${ref.slice(4)}`]), ['__add', 'New chapter…']].map(([v, l]) => el('option', { value: v, selected: v === r.chapter }, l));
    const tbody = el('tbody', {});
    const count = el('span', { class: 'meta' });
    const apply = button({ label: 'Apply', variant: 'primary', onClick: () => submit() });
    const all = el('input', { type: 'checkbox', 'aria-label': 'Select all files', checked: rows.every(r => r.selected) });
    all.onchange = () => { for (const r of rows) r.selected = all.checked; draw(); };

    const sameTarget = () => { const seen = new Map(), dup = new Set(); for (const r of rows) { if (!r.selected) continue; const k = targetKey(r); if (!k) continue; if (seen.has(k)) { dup.add(r); dup.add(seen.get(k)); } else seen.set(k, r); } return dup; };
    function draw() {
      const dup = sameTarget();
      tbody.replaceChildren(...rows.flatMap(r => {
        const [lv, lvText] = level(r.confidence || 0);
        const kinds = kindsFor(r.path);
        const kindSel = el('select', { class: 'select sm', 'aria-label': `Kind of ${r.path}`, disabled: !r.selected },
          r.version ? el('option', { value: 'version', selected: r.action === 'version' }, 'New version') : null,
          ...kinds.map(k => el('option', { value: k, selected: r.action !== 'version' && k === r.kind }, KIND_LABEL[k])));
        kindSel.onchange = () => {
          if (kindSel.value === 'version') { r.action = 'version'; r.kind = 'version'; r.versionDeclined = false; }
          else { r.action = 'new'; if (r.version) r.versionDeclined = true; r.kind = kindSel.value; if ((CHAPTER_KINDS.has(r.kind) || r.kind === 'reference') && !r.chapter && chapters[0]) r.chapter = chapters[0].id; if (COURSE_KINDS.has(r.kind) || r.kind === 'ignore') r.chapter = ''; }
          draw();
        };
        const needsChapter = r.action !== 'version' && (CHAPTER_KINDS.has(r.kind) || r.kind === 'reference');
        const chSel = el('select', { class: 'select sm', 'aria-label': `Chapter of ${r.path}`, disabled: !r.selected || !needsChapter, 'aria-invalid': String(r.selected && CHAPTER_KINDS.has(r.kind) && r.action !== 'version' && !r.chapter) }, ...(needsChapter ? chapterOptions(r) : [el('option', { value: '' }, '—')]));
        chSel.onchange = async () => {
          if (chSel.value !== '__add') { r.chapter = chSel.value; draw(); return; }
          const t = await confirmDialog({ title: 'New chapter', confirmLabel: 'Add', input: { label: 'Title', value: r.title || '' } });
          if (typeof t === 'string' && t.trim()) { const ref = `new:${t.trim()}`; if (!proposed.includes(ref)) proposed.push(ref); r.chapter = ref; }
          draw();
        };
        const check = el('input', { type: 'checkbox', checked: r.selected, 'aria-label': `Import ${r.path}` }); check.onchange = () => { r.selected = check.checked; draw(); };
        const tip = `${r.reason || ''}${r.by && r.by !== 'match' ? ` (${r.by === 'both' ? 'rules and model agree' : r.by === 'model' ? 'model' : 'rules'})` : ''}${r.error ? ` · could not read: ${r.error}` : ''}`;
        const diffBtn = r.version ? button({ label: r.open ? 'Hide diff' : 'Diff', size: 'sm', variant: 'ghost', onClick: () => { r.open = !r.open; draw(); } }) : null;
        const tr = el('tr', { class: `${r.selected ? '' : 'off'}${dup.has(r) ? ' dup' : ''}`, dataset: { path: r.path } },
          el('td', {}, check),
          el('td', { class: 'imp-file' }, el('span', { class: 'imp-name', title: r.path }, r.path), el('span', { class: 'meta' }, ` ${size(r.size)}`), r.version && r.action === 'version' ? el('div', { class: 'meta imp-of' }, `→ ${r.version.label}`) : null, dup.has(r) ? el('span', { class: 'imp-warn', title: 'Another file goes to the same stage: the later one becomes its newer version', 'aria-label': 'Same stage as another file' }, icon('alert', 'sm')) : null),
          el('td', {}, kindSel), el('td', {}, chSel),
          el('td', { class: 'imp-conf' }, el('span', { class: `imp-badge ${lv}`, title: `Confidence ${Math.round((r.confidence || 0) * 100)}%` }, lvText), el('button', { type: 'button', class: 'info-tip', 'aria-label': tip, 'data-tip': tip }, icon('info', 'sm')), diffBtn));
        if (!(r.version && r.open)) return [tr];
        return [tr, el('tr', { class: 'imp-diff-row' }, el('td', { colspan: '5' }, diffView(r.oldText, r.text)))];
      }));
      const sel = rows.filter(r => r.selected && r.kind !== 'ignore');
      const newCh = new Set(sel.filter(r => r.action !== 'version' && CHAPTER_KINDS.has(r.kind) && r.chapter.startsWith('new:')).map(r => r.chapter));
      count.textContent = `${sel.length} of ${rows.length} files${newCh.size ? ` · ${newCh.size} new chapter${newCh.size > 1 ? 's' : ''}` : ''}${rows.some(r => r.version) ? ` · ${rows.filter(r => r.version && r.action === 'version' && r.selected).length} new version${rows.filter(r => r.version).length > 1 ? 's' : ''}` : ''}`;
      apply.disabled = !sel.length; all.checked = rows.every(r => r.selected);
    }
    function submit() {
      const missing = rows.find(r => r.selected && r.action !== 'version' && CHAPTER_KINDS.has(r.kind) && !r.chapter);
      if (missing) { toast(`Choose a chapter for ${missing.name}`, 'error'); tbody.querySelector(`tr[data-path="${CSS.escape(missing.path)}"] select[aria-label^="Chapter"]`)?.focus(); return; }
      done({ rows, newChapters: proposed });
    }
    const done = v => { dlg.removeEventListener('cancel', onCancel); resolve(v); };
    const onCancel = e => { e.preventDefault(); done(null); };
    dlg.addEventListener('cancel', onCancel);
    body.replaceChildren(...[
      el('div', { class: 'imp-head' }, el('h3', {}, 'Import materials'), count),
      modelNote ? notice('warn', modelNote) : null,
      el('div', { class: 'imp-table-wrap' }, el('table', { class: 'table imp-table' },
        el('thead', {}, el('tr', {}, el('th', {}, all), el('th', {}, 'File'), el('th', {}, 'Kind'), el('th', {}, 'Chapter'), el('th', {}, 'Confidence'))), tbody)),
      el('div', { class: 'dlg-actions' }, button({ label: 'Cancel', variant: 'ghost', onClick: () => done(null) }), apply)].filter(Boolean));
    draw();
    apply.focus();
  });
}

/** The current stage text against the new file's text: changed lines with two lines of context, gaps marked. */
function diffView(oldText, newText) {
  const hunks = diffLines(oldText || '', newText || '');
  if (!hunks.length) return el('p', { class: 'meta' }, 'Same text as the current version.');
  const add = hunks.reduce((a, h) => a + h.add.length, 0), del = hunks.reduce((a, h) => a + h.del.length, 0);
  const A = String(oldText || '').split('\n'); const CTX = 2; const rows = []; let at = 0; // next old line not shown yet
  const line = (kind, text) => rows.push(el('div', { class: `ag-line ${kind === '+' ? 'add' : kind === '-' ? 'del' : ''}` }, el('span', { class: 'sign', 'aria-hidden': 'true' }, kind), text || ' '));
  for (const h of hunks) {
    const from = Math.max(at, h.a - CTX);
    if (from > at && rows.length) line('…', '');
    for (let i = from; i < h.a; i++) line(' ', A[i]);
    for (const t of h.del) line('-', t); for (const t of h.add) line('+', t);
    at = h.a + h.del.length;
    const next = hunks[hunks.indexOf(h) + 1]; const to = Math.min(A.length, at + CTX, next ? next.a : Infinity);
    for (let i = at; i < to; i++) line(' ', A[i]); at = Math.max(at, to);
  }
  return el('div', { class: 'imp-diff', 'aria-label': `Changes: ${add} lines added, ${del} removed` }, el('div', { class: 'meta' }, `+${add} −${del}`), el('pre', { class: 'ag-diff' }, ...rows));
}

/** "Start from existing materials": pick files, create the project (named after the folder), then import. */
export async function startFromMaterials(ctx, { create }) {
  const picked = await pickMaterials({ title: 'Start from existing materials' }); if (!picked) return;
  const top = picked[0].path.includes('/') ? picked[0].path.split('/')[0] : '';
  const p = await create(top); if (!p) return;
  go('p', p.id, 'overview');
  for (let i = 0; i < 100 && ctx.store?.id !== p.id; i++) await new Promise(r => setTimeout(r, 100));
  if (ctx.store?.id !== p.id) return toast('The new project did not open', 'error');
  await openImport(ctx, picked);
}
