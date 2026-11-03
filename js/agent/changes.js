// agent/changes.js — an agent turn's changes under review, and applying the accepted ones. A change set comes from a
// CLI agent's job copy (local server) or the built-in agent's overlay; either way every file reads "after" from it and
// "before" from the project as it is now. Keep writes stage files through the store (userEdit / commitDeck /
// commitDoc: versions, history and the audit trail stay right) and plain files as they are, all as one commit.
import { api, LOCAL } from '../fs/api.js';
import { backend } from '../fs/backend.js';
import { diffLines, applyHunks } from '../diff.js';
import { stageInfo } from '../ws/stages.js';
import { typeOf } from '../ws/source.js';
import { commitDeck, compareDecks, compareDocs, deckManifest } from '../pptxdeck.js';
import { commitDoc, docManifest } from '../docstage.js';

const enc = p => p.split('/').map(encodeURIComponent).join('/');
const TEXT = /\.(md|markdown|txt|json|jsonl|ya?ml|tex|bib|sty|cls|csv|tsv|html?|css|m?js|py|sh|toml|xml|svg)$|(^|\/)[^.]+$/i;
const STAGE_TEXT_ONLY = 'Stage files can be changed, not deleted';

/**
 * new ChangeSet({ items: [{ path, status, text, conflict, rejected }], after(path) → Blob|string|null, session, source })
 * After load(): each item has { before, after, hunks, accepted (Set of hunk ids | boolean), check } ready for the panel.
 */
export class ChangeSet {
  constructor({ items, after, session = null, src, owners }) {
    this.session = session; this.src = src; this.owners = owners; this._after = after;
    this.items = items.map(c => ({ ...c, text: c.text ?? TEXT.test(c.path), key: owners.get(c.path) || null }));
    for (const it of this.items) {
      if (!it.rejected && it.key && it.status === 'deleted') it.rejected = STAGE_TEXT_ONLY;
      if (!it.rejected && it.key && it.status === 'added') it.rejected = 'belongs to a stage';
      if (!it.rejected && !LOCAL && !it.key) it.rejected = 'the browser edition only changes the course’s own files';
    }
  }
  /** Read both sides and diff the text files. */
  async load() {
    for (const it of this.items) {
      const cur = it.status === 'added' ? null : await this.src.read(it.path).catch(() => null);
      const aft = it.status === 'deleted' ? null : await this._after(it.path);
      if (it.text) {
        it.before = cur ? await cur.blob.text() : '';
        it.after = aft == null ? '' : typeof aft === 'string' ? aft : await aft.text();
        it.hunks = it.status === 'deleted' ? [] : diffLines(it.before, it.after);
        it.accepted = it.rejected ? new Set() : new Set(it.hunks.map(h => h.id));
        if (it.status === 'deleted' || it.status === 'added') it.accepted = !it.rejected;
        if (it.status === 'modified' && !it.hunks.length) it.same = true;
      } else {
        it.beforeBlob = cur?.blob || null;
        it.afterBlob = aft == null ? null : aft instanceof Blob ? new Blob([aft], { type: typeOf(it.path) }) : new Blob([aft], { type: typeOf(it.path) });
        it.accepted = !it.rejected;
      }
    }
    this.items = this.items.filter(it => !it.same);
    return this;
  }
  get pending() { return this.items.filter(it => it.accepted === true || (it.accepted instanceof Set && it.accepted.size)); }
  isAccepted(it) { return it.accepted === true || (it.accepted instanceof Set && it.accepted.size > 0); }

  /** pptx/docx: what changed outside the instructor's selection (targets: 1-based slide or block numbers). */
  async check(it, targets) {
    if (!it.beforeBlob || !it.afterBlob) return null;
    const zero = (targets || []).map(n => n - 1);
    try {
      it.check = /\.pptx$/i.test(it.path) ? { kind: 'slides', ...await compareDecks(it.beforeBlob, it.afterBlob, zero) } : /\.docx$/i.test(it.path) ? { kind: 'paragraphs', ...await compareDocs(it.beforeBlob, it.afterBlob, zero) } : null;
    } catch (e) { it.check = { error: e.message }; }
    if (it.check) it.check.targets = targets || [];
    return it.check;
  }

  /** The content to write for an accepted item (null: delete). */
  async result(it) {
    if (it.status === 'deleted') return null;
    if (it.text) return it.accepted === true ? it.after : applyHunks(it.before, it.hunks, it.accepted);
    return it.afterBlob;
  }

  /** Apply the accepted changes. Returns { commit, paths } (commit: the git commit in the local app). */
  async keep(ctx) {
    const store = ctx.store; const items = this.pending.filter(it => !it.rejected);
    if (!items.length) throw new Error('Nothing selected');
    await store.flush();
    const files = [], removed = [], paths = [];
    store.held = true;
    try {
      for (const it of items) {
        const data = await this.result(it);
        if (it.key) {
          const info = stageInfo(ctx, it.key); if (!info) throw new Error(`${it.path}: its stage is gone`);
          if (/\.pptx$/i.test(it.path)) { if (!deckManifest(info.stage.output)) throw new Error(`${it.path} is not a deck stage`); await commitDeck(store, info.chapter.id, data, { label: info.label, where: info.where }); }
          else if (/\.docx$/i.test(it.path)) { if (!docManifest(info.stage.output)) throw new Error(`${it.path} is not a Word stage`); await commitDoc(store, info.chapter.id, info.stageId, data, { label: info.label, where: info.where }); }
          else {
            if (/\.json$/i.test(it.path)) { try { JSON.parse(data); } catch (e) { throw new Error(`${it.path}: not valid JSON after the accepted changes (${e.message})`); } }
            store.userEdit(info.stage, info.label, data, info.where);
          }
        } else if (data === null) removed.push(it.path);
        else files.push({ path: it.path, data: await toBase64(typeof data === 'string' ? new Blob([data]) : data) });
        paths.push(it.path);
      }
      store.log({ type: 'agent_keep', note: `kept ${paths.length} file${paths.length > 1 ? 's' : ''}`, files: paths, agent: this.agent || null });
      const message = `agent: ${paths.slice(0, 4).join(', ')}${paths.length > 4 ? ` (+${paths.length - 4})` : ''}`;
      if (LOCAL) {
        const r = await backend.applyAgent(store.project, { files, removed, message, session: this.session });
        store.held = false; store.dirty = false; clearTimeout(store._t);
        return { commit: r.commit, paths };
      }
      store.held = false; store.dirty = true; await store.flush();
      return { commit: null, paths };
    } finally { if (store.held) { store.held = false; store.save(); } }
  }
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A CLI agent's pending changes (local app). */
export function jobChanges({ projectId, session, items, src, owners }) {
  const P = `/api/projects/${encodeURIComponent(projectId)}/agent/sessions/${session}`;
  return new ChangeSet({ items, session, src, owners, after: async path => { try { return await (await api(`${P}/file/${enc(path)}`, { raw: true })).blob(); } catch (e) { if (e.status === 404) return null; throw e; } } });
}
/** The built-in agent's overlay. */
export async function overlayChanges({ overlay, src, owners }) {
  const items = [];
  for (const [path, content] of overlay) {
    const cur = await src.read(path).catch(() => null);
    items.push({ path, status: content === null ? 'deleted' : cur ? 'modified' : 'added', text: typeof content === 'string', conflict: false });
  }
  return new ChangeSet({ items, src, owners, after: async path => overlay.get(path) ?? null });
}
export const undoCommit = (projectId, oid) => api(`/api/projects/${encodeURIComponent(projectId)}/agent/undo`, { method: 'POST', body: { oid } });
