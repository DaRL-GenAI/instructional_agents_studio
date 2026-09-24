// views/audit.js — every model call, TTS call, edit, approval and export of this project.
import { el, button, select, fmtMs, fmtInt } from '../ui.js';
import { projectTotals } from '../state.js';
import { download, textBlob, slug, auditMarkdown } from '../export.js';

export function render(ctx) {
  const p = ctx.store.project; const totals = projectTotals(p); const ui = ctx.ui.audit ||= { filter: '' };
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Audit trail'), el('p', {}, 'Every model call, TTS call, edit, prompt change, approval and export, in order, with hashes of prompts and outputs.')),
    el('div', { class: 'btn-row' }, button({ label: 'Audit JSON', icon: 'download', size: 'sm', onClick: () => download(textBlob(JSON.stringify(p.audit, null, 2), 'application/json'), `${slug(p.name)}_audit_log.json`) }), button({ label: 'Audit Markdown', icon: 'download', size: 'sm', onClick: () => download(textBlob(auditMarkdown(p), 'text/markdown'), `${slug(p.name)}_audit_log.md`) }))));
  page.append(el('div', { class: 'summary-line', style: 'margin-bottom:16px' }, el('span', {}, el('b', {}, fmtInt(totals.calls)), ' model calls'), el('span', {}, el('b', {}, fmtInt(totals.tokens)), ' tokens'), el('span', {}, el('b', {}, fmtInt(totals.ttsChars)), ' TTS characters'), el('span', {}, el('b', {}, fmtInt(totals.edits)), ' user edits'), el('span', {}, el('b', {}, fmtInt(p.audit.length)), ' events')));
  const filter = select([['', 'All events'], ...['llm_call', 'tts_call', 'stage_done', 'edit', 'prompt_edit', 'approve', 'export', 'settings', 'textbook', 'video'].map(t => [t, t])], ui.filter, { style: 'width:220px' });
  filter.onchange = () => { ui.filter = filter.value; ctx.render(); };
  const rows = [...p.audit].reverse().filter(a => !ui.filter || a.type === ui.filter);
  const tb = el('tbody', {}, ...rows.map(a => el('tr', { class: a.status === 'error' ? 'changed' : '', title: a.error || '' },
    el('td', { class: 'num' }, a.id), el('td', {}, new Date(a.ts).toLocaleTimeString()), el('td', { class: 'mono' }, a.type), el('td', {}, a.where || ''), el('td', {}, a.stage || a.note || a.file || ''), el('td', {}, a.agent || a.model || ''), el('td', {}, a.status || ''), el('td', { class: 'num' }, a.tokens != null ? `${fmtInt(a.tokens)}${a.estimated ? '*' : ''}` : a.chars != null ? `${fmtInt(a.chars)} ch` : ''), el('td', { class: 'num' }, a.ms != null ? fmtMs(a.ms) : ''), el('td', { class: 'mono' }, a.hash || a.responseHash || a.promptHash || ''))));
  page.append(el('div', { style: 'margin-bottom:12px' }, filter), el('div', { class: 'panel', style: 'overflow:auto;max-height:70vh' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ...['#', 'Time', 'Type', 'Where', 'Stage', 'Agent / model', 'Status', 'Tokens / chars', 'Latency', 'Hash'].map((h, i) => el('th', { class: [0, 7, 8].includes(i) ? 'num' : '' }, h)))), tb)));
  return page;
}
