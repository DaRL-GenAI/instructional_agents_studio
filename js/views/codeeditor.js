// views/codeeditor.js — a CodeMirror 6 text editor (prebuilt in js/vendor/codemirror.js, loaded on first use) for
// Workspace tabs: Markdown, JSON, YAML, LaTeX, CSV and plain text. Ctrl/⌘+S saves.
let cm;
export const loadCodeMirror = () => (cm ||= import('../vendor/codemirror.js'));

export const TEXT_EXT = new Set(['md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'tex', 'bib', 'sty', 'cls', 'txt', 'csv', 'tsv', 'gitignore', 'log', 'xml', 'html', 'css', 'js', 'mjs', 'py', 'sh', 'toml', 'svg']);

function language(m, ext) {
  if (ext === 'md' || ext === 'markdown') return m.markdown();
  if (ext === 'json' || ext === 'jsonl') return m.json();
  if (ext === 'yaml' || ext === 'yml') return m.StreamLanguage.define(m.yaml);
  if (['tex', 'bib', 'sty', 'cls'].includes(ext)) return m.StreamLanguage.define(m.stex);
  if (ext === 'csv' || ext === 'tsv') return m.StreamLanguage.define(m.spreadsheet);
  return [];
}

/** { el, getText(), setText(text), focus(), destroy(), view } — onChange(text) on every edit, onSave() on Ctrl/⌘+S. */
export async function createCodeEditor({ text, ext, readOnly = false, wrap = true, onChange = () => {}, onSave = () => {} }) {
  const m = await loadCodeMirror();
  const host = document.createElement('div'); host.className = 'cm-host';
  const theme = m.EditorView.theme({
    '&': { height: '100%', fontSize: 'var(--ws-font, 13px)', backgroundColor: 'var(--surface)', color: 'var(--text)' },
    '.cm-scroller': { fontFamily: 'var(--mono, ui-monospace, monospace)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--surface-2)', color: 'var(--text-3)', borderRight: '1px solid var(--line-soft)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 7%, transparent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' },
  });
  const view = new m.EditorView({
    parent: host,
    state: m.EditorState.create({
      doc: text,
      extensions: [
        m.basicSetup, theme, language(m, ext), wrap ? m.EditorView.lineWrapping : [],
        m.keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } }, m.indentWithTab]),
        m.EditorState.readOnly.of(readOnly), m.EditorView.editable.of(!readOnly),
        m.EditorView.updateListener.of(u => { if (u.docChanged) onChange(u.state.doc.toString()); }),
        m.EditorView.contentAttributes.of({ 'aria-label': 'File contents' }),
      ],
    }),
  });
  return {
    el: host, view,
    getText: () => view.state.doc.toString(),
    setText(t) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } }); },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
