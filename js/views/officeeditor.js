// views/officeeditor.js — one ONLYOFFICE editor (the document-editor build at settings.editorUrl, or the local
// app's own /editor) in an iframe, driven over its postMessage API: open-buffer in, save → File out, run-macro.
// Used by the full-screen "Edit slides" layer (pptxeditor.js) and by Workspace tabs (.pptx and .docx).
import { el } from '../ui.js';
import { account, DEFAULT_SETTINGS } from '../state.js';
import { LOCAL } from '../fs/api.js';

/** The local app serves its own editor build at /editor unless the address was changed under Account. */
export function editorBase() {
  const set = String(account.settings.editorUrl || DEFAULT_SETTINGS.editorUrl).replace(/\/+$/, '');
  return LOCAL?.editor && set === DEFAULT_SETTINGS.editorUrl ? `${location.origin}/editor` : set;
}

// A read that succeeds only once the document model is usable (document:opened fires before that).
const PROBE = {
  pptx: 'return Api.GetPresentation().GetSlidesCount();',
  docx: 'return Api.GetDocument().GetElementsCount();',
};
export const officeFormat = name => (/\.docx$/i.test(name) ? 'docx' : /\.pptx$/i.test(name) ? 'pptx' : null);

/**
 * new OfficeFrame({ fileName, title, onDirty(dirty), onStatus(state, text), onExported(file, { regularSave, dirty }) })
 *   .el                  the iframe (mount it once; moving it in the DOM reloads the editor)
 *   .load(blob)          open a file once the editor is ready; resolves when a read macro succeeds
 *   .save(targetExt?)    → { file, dirty }   (targetExt: 'PPTX' | 'DOCX' | 'PDF'; default: the file's own format)
 *   .macro(code, args, readonly) → result
 *   .openBuffer(blob)    replace the open document (agent previews, reload from disk)
 *   .destroy()
 */
export class OfficeFrame {
  constructor({ fileName, title, onDirty = () => {}, onStatus = () => {}, onExported = () => {} }) {
    this.fileName = fileName; this.format = officeFormat(fileName) || 'pptx';
    this.base = editorBase(); this.origin = new URL(this.base).origin;
    this.onDirty = onDirty; this.onStatus = onStatus; this.onExported = onExported;
    this.state = { ready: false, opened: false, dirty: false };
    this.pending = new Map(); this.saving = null;
    this.el = el('iframe', { class: 'office-frame', title: title || `Editor · ${fileName}`, allow: 'clipboard-read; clipboard-write; fullscreen', src: `${this.base}/editor?embed=1&locale=${encodeURIComponent(account.settings.language || 'en')}&embedOrigin=${encodeURIComponent(location.origin)}` });
    this.readyP = new Promise((res, rej) => { this._ready = res; this._fail = rej; });
    this.loadTimer = setTimeout(() => { if (!this.state.ready) { const m = `The editor at ${this.origin} did not respond`; this.onStatus('error', m); this._fail(new Error(m)); } }, 45000);
    this._onMessage = e => this.onMessage(e);
    addEventListener('message', this._onMessage);
  }

  send(type, payload = {}, id = `${Date.now()}-${Math.random().toString(16).slice(2)}`) { this.el.contentWindow?.postMessage({ id, type, payload }, this.origin); return id; }
  /** Request/reply by message id. An editor without the call never answers, hence the timeout. */
  request(type, payload, ms = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.send(type, payload);
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('The editor did not answer. This needs the self-hosted editor (Account → Slides editor).')); }, ms);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    });
  }
  async macro(code, args = null, readonly = false) { return (await this.request('document:run-macro', { code, args, readonly })).result; }

  onMessage(e) {
    if (e.origin !== this.origin || e.source !== this.el.contentWindow) return;
    const { type, payload = {} } = e.data || {};
    if (!type?.startsWith('document:')) return;
    const waiter = e.data.id && this.pending.get(e.data.id);
    if (waiter) { this.pending.delete(e.data.id); return type === 'document:error' ? waiter.reject(new Error(payload.message || 'Editor error')) : waiter.resolve(payload); }
    if (type === 'document:ready' && !this.state.ready) { this.state.ready = true; clearTimeout(this.loadTimer); this._ready(); }
    if (type === 'document:dirty-changed') { this.state.dirty = !!payload.dirty; this.onDirty(this.state.dirty); }
    if (type === 'document:saved') this.saving?.resolve(payload);
    // Ctrl+S / the editor's own download (self-hosted editor): the host decides (commit, or download other formats).
    if (type === 'document:exported' && payload.file) this.onExported(payload.file, { regularSave: !!payload.regularSave, dirty: !!payload.dirty });
    if (type === 'document:error') { if (this.saving) this.saving.reject(new Error(payload.message || 'Save failed')); else this.onStatus('error', payload.message || 'Editor error'); }
  }

  /** Open the file; resolves once the document answers a read macro (the editor is really usable then). */
  async load(blob) {
    await this.readyP;
    this.onStatus('', 'Opening…');
    await this.openBuffer(blob);
    return this;
  }
  async openBuffer(blob) {
    this.state.opened = false;
    await this.request('document:open-buffer', { fileName: this.fileName, buffer: await blob.arrayBuffer(), readonly: false }, 120000);
    await this.waitUsable();
    this.state.opened = true; this.state.dirty = false; this.onDirty(false);
  }
  async waitUsable(ms = 60000) {
    const t0 = Date.now(); let last;
    for (;;) {
      try { return (await this.request('document:run-macro', { code: PROBE[this.format], args: null, readonly: true }, 5000)).result; }
      catch (e) { last = e; }
      if (Date.now() - t0 > ms) throw last || new Error('The document did not finish opening');
      await new Promise(r => setTimeout(r, 400));
    }
  }

  /** Export the open document: { file, dirty }. */
  save(targetExt) {
    if (!this.state.opened) return Promise.reject(new Error('The document is still opening'));
    if (this.saving) return Promise.reject(new Error('Already saving'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The editor did not return the file in time')), 60000);
      this.saving = { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
      this.send('document:save', { targetExt: targetExt || this.format.toUpperCase() });
    }).then(p => { this.saving = null; if (!targetExt || targetExt.toLowerCase() === this.format) { this.state.dirty = !!p.dirty; this.onDirty(this.state.dirty); } return { file: p.file, dirty: !!p.dirty }; },
      e => { this.saving = null; throw e; });
  }

  destroy() {
    clearTimeout(this.loadTimer); removeEventListener('message', this._onMessage);
    for (const w of this.pending.values()) w.reject(new Error('Editor closed'));
    this.pending.clear(); this.el.remove();
  }
}

export function downloadFile(file, name) {
  const a = el('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
