// ui.js — DOM helpers and the component vocabulary (buttons, fields, badges, tabs, empty states, dialogs, toasts).
export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in n && typeof v !== 'string' && k !== 'value') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  append(n, ...children);
  return n;
}
export function append(parent, ...kids) { for (const k of kids.flat(Infinity)) { if (k === null || k === undefined || k === false) continue; parent.append(k.nodeType ? k : document.createTextNode(String(k))); } return parent; }
export const frag = (...kids) => append(document.createDocumentFragment(), ...kids);
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', `icon ${cls}`.trim()); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', `#i-${name}`); s.append(u);
  return s;
}

export function button({ label, icon: ic, variant = '', size = '', onClick, disabled = false, title, type = 'button', loading = false, attrs = {} }) {
  const b = el('button', { type, class: `btn ${variant} ${size} ${!label ? 'icon-only' : ''} ${loading ? 'loading' : ''}`.replace(/\s+/g, ' ').trim(), disabled: disabled || loading, title: title || (!label ? undefined : undefined), 'aria-label': !label ? title : undefined, onClick, ...attrs }, ic ? icon(ic, size === 'sm' ? 'sm' : '') : null, label);
  return b;
}
export const link = (label, hrefStr, cls = '') => el('a', { href: hrefStr, class: cls }, label);

export function field(label, control, { hint, inline = false, id } = {}) {
  if (id) control.id = id;
  const lab = el('label', { class: `field ${inline ? 'inline' : ''}`, for: control.id || undefined }, el('span', { class: 'label' }, label), control, hint ? el('span', { class: 'hint' }, hint) : null);
  return lab;
}
export const input = (attrs = {}) => el('input', { class: 'input', type: 'text', ...attrs });
export const textarea = (attrs = {}, value = '') => { const t = el('textarea', { class: 'textarea', rows: 4, ...attrs }); t.value = value; return t; };
export const select = (options, value, attrs = {}) => el('select', { class: 'select', ...attrs }, ...options.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return el('option', { value: v, selected: v === value }, l); }));
export function toggle(checked, onChange, label) {
  const sw = el('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label });
  sw.onclick = () => { const v = sw.getAttribute('aria-checked') !== 'true'; sw.setAttribute('aria-checked', String(v)); onChange(v); };
  return sw;
}

export const STATUS_LABEL = { idle: 'Not started', running: 'Running', done: 'Generated', edited: 'Edited', stale: 'Inputs changed', error: 'Failed', partial: 'In progress' };
export const badge = (status, label) => el('span', { class: `badge ${status}` }, label || STATUS_LABEL[status] || status);
export const dot = status => el('i', { class: `dot ${status || ''}` });

export function tabs(items, active, onSelect, { label = 'Sections' } = {}) {
  return el('div', { class: 'tabs', role: 'tablist', 'aria-label': label }, ...items.map(([key, text, count]) => el('button', { class: 'tab', role: 'tab', 'aria-selected': String(key === active), onClick: () => onSelect(key) }, text, count ? el('span', { class: 'count' }, count) : null)));
}
export function segmented(items, value, onChange) {
  return el('div', { class: 'seg', role: 'group' }, ...items.map(([v, l]) => el('button', { type: 'button', 'aria-pressed': String(v === value), onClick: () => onChange(v) }, l)));
}

export function notice(kind, text, ...extra) { return el('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'alert' : kind === 'warn' ? 'alert' : kind === 'ok' ? 'check' : 'info'), el('div', {}, text, ...extra)); }

export function empty({ icon: ic = 'file', title, body, actions = [] }) {
  return el('div', { class: 'empty' }, icon(ic), el('h3', {}, title), body ? el('p', {}, body) : null, actions.length ? el('div', { class: 'btn-row' }, ...actions) : null);
}
export const skeleton = (n = 4) => el('div', { class: 'skeleton', 'aria-busy': 'true' }, ...Array.from({ length: n }, (_, i) => el('i', { style: `width:${90 - (i * 13) % 40}%` })));

let toastTimer;
export function toast(msg, kind = '') {
  let t = $('#toast'); if (!t) { t = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), kind === 'error' ? 7000 : 3200);
}

export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, input: askInput = null }) {
  return new Promise(resolve => {
    const dlg = el('dialog', { class: 'dlg' });
    const inp = askInput ? input({ placeholder: askInput.placeholder || '', value: askInput.value || '' }) : null;
    const ok = button({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => { dlg.close(); resolve(inp ? inp.value : true); } });
    const cancel = button({ label: 'Cancel', onClick: () => { dlg.close(); resolve(null); } });
    dlg.append(el('form', { class: 'dlg-body', method: 'dialog', onSubmit: e => { e.preventDefault(); ok.click(); } }, el('h3', {}, title), body ? el('p', {}, body) : null, inp ? field(askInput.label, inp) : null, el('div', { class: 'dlg-actions' }, cancel, ok)));
    dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
    document.body.append(dlg); dlg.showModal(); (inp || ok).focus();
  });
}

export const fmtMs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
export const fmtDate = ts => ts ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts)) : '—';
export const fmtRel = ts => { if (!ts) return '—'; const d = (Date.now() - new Date(ts)) / 1000; if (d < 60) return 'just now'; if (d < 3600) return `${Math.round(d / 60)} min ago`; if (d < 86400) return `${Math.round(d / 3600)} h ago`; return `${Math.round(d / 86400)} d ago`; };
export const fmtBytes = b => b < 1e6 ? `${(b / 1e3).toFixed(0)} KB` : b < 1e9 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e9).toFixed(2)} GB`;
export const fmtInt = n => new Intl.NumberFormat().format(n || 0);

let markedReady;
export async function renderMarkdown(md) {
  if (!window.marked) {
    markedReady ||= new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); });
    await markedReady;
  }
  if (!window.marked) return `<pre>${esc(md)}</pre>`;
  return window.marked.parse(md, { gfm: true, breaks: false });
}
export function loadScript(src, test) {
  if (test()) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error(`Could not load ${src}`)); document.head.appendChild(s); });
}
