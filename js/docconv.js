// docconv.js — Markdown ⇄ Word (.docx), in the browser or in Node (no DOM): md → docx with the `docx` package
// (headings, paragraphs with bold/italic/code/links, nested lists, code blocks, quotes, tables), docx → md with
// mammoth. Both libraries come from the prebuilt js/vendor/docconv.js and load on first use.
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export { DOCX_TYPE };

let lib;
const load = () => (lib ||= import('./vendor/docconv.js'));

/** Markdown text → .docx bytes (ArrayBuffer). */
export async function mdToDocx(md, { title } = {}) {
  const m = await load();
  const { Paragraph, TextRun, HeadingLevel, ExternalHyperlink, Table, TableRow, TableCell, WidthType, LevelFormat, AlignmentType, ShadingType } = m;
  const tokens = m.marked.lexer(String(md || '').replace(/\r\n?/g, '\n'), { gfm: true });
  const H = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  let lists = 0; // every ordered list restarts its numbering
  const decode = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));

  const inline = (toks = [], fmt = {}) => toks.flatMap(t => {
    switch (t.type) {
      case 'strong': return inline(t.tokens, { ...fmt, bold: true });
      case 'em': return inline(t.tokens, { ...fmt, italics: true });
      case 'del': return inline(t.tokens, { ...fmt, strike: true });
      case 'codespan': return [new TextRun({ ...fmt, text: decode(t.text), font: 'Consolas' })];
      case 'br': return [new TextRun({ ...fmt, text: '', break: 1 })];
      case 'link': return [new ExternalHyperlink({ link: t.href, children: inline(t.tokens, { ...fmt, style: 'Hyperlink' }) })];
      case 'image': return [new TextRun({ ...fmt, text: `[${t.text || 'image'}]` })];
      case 'text': case 'escape': return t.tokens ? inline(t.tokens, fmt) : [new TextRun({ ...fmt, text: decode(t.text) })];
      default: return [new TextRun({ ...fmt, text: decode(t.raw ?? t.text ?? '') })];
    }
  });

  const blocks = (toks, ctx = {}) => toks.flatMap(t => {
    switch (t.type) {
      case 'heading': return [new Paragraph({ heading: H[Math.min(6, t.depth) - 1], children: inline(t.tokens) })];
      case 'paragraph': return [new Paragraph({ children: inline(t.tokens), ...(ctx.quote ? { indent: { left: 567 }, style: 'Quote' } : {}) })];
      case 'text': return [new Paragraph({ children: inline(t.tokens || [{ type: 'text', text: t.text }]) })];
      case 'code': return t.text.split('\n').map(line => new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })], shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' }, spacing: { after: 0 } }));
      case 'blockquote': return blocks(t.tokens, { ...ctx, quote: true });
      case 'hr': return [new Paragraph({ border: { bottom: { style: 'single', size: 6, color: '999999', space: 1 } } })];
      case 'list': {
        const level = ctx.level ?? 0; const instance = t.ordered ? ++lists : 0;
        return t.items.flatMap(item => {
          const [first, ...rest] = item.tokens; const lead = first && (first.type === 'text' || first.type === 'paragraph') ? first : null;
          const mark = item.task ? [new TextRun({ text: item.checked ? '☑ ' : '☐ ' })] : [];
          const para = new Paragraph({ children: [...mark, ...(lead ? inline(lead.tokens || [{ type: 'text', text: lead.text }]) : [])], ...(t.ordered ? { numbering: { reference: 'ia-ordered', level: Math.min(level, 8), instance } } : { bullet: { level: Math.min(level, 8) } }) });
          return [para, ...blocks(lead ? rest : item.tokens, { ...ctx, level: level + 1 })];
        });
      }
      case 'table': {
        const cell = (c, head) => new TableCell({ children: [new Paragraph({ children: inline(c.tokens, head ? { bold: true } : {}) })] });
        return [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: t.header.map(c => cell(c, true)) }), ...t.rows.map(r => new TableRow({ children: r.map(c => cell(c, false)) }))] }), new Paragraph({})];
      }
      case 'space': case 'def': return [];
      case 'html': return t.text.trim() ? [new Paragraph({ children: [new TextRun({ text: t.text.trim() })] })] : [];
      default: return t.raw?.trim() ? [new Paragraph({ children: [new TextRun({ text: t.raw.trim() })] })] : [];
    }
  });

  const children = blocks(tokens);
  const levels = Array.from({ length: 9 }, (_, i) => ({ level: i, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][i % 3], text: `%${i + 1}.`, alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } }));
  const doc = new m.Document({ title: title || undefined, creator: 'Instructional Agents', numbering: { config: [{ reference: 'ia-ordered', levels }] }, sections: [{ children: children.length ? children : [new Paragraph({})] }] });
  return m.Packer.toArrayBuffer(doc);
}

/** .docx bytes (ArrayBuffer | Uint8Array | Blob) → Markdown text. */
export async function docxToMd(data) {
  const m = await load();
  const arrayBuffer = await toArrayBuffer(data);
  const r = await m.mammoth.convertToMarkdown({ arrayBuffer });
  return r.value
    .replace(/__(?=\S)([^_\n]+?)__/g, '**$1**') // mammoth writes bold as __x__
    .replace(/\\([.()!\-#+])/g, '$1')         // and escapes punctuation Markdown does not need escaped here
    .replace(/<a id="[^"]*"><\/a>/g, '')
    .replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function toArrayBuffer(d) {
  if (d instanceof ArrayBuffer) return d;
  if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
  if (typeof Blob !== 'undefined' && d instanceof Blob) return d.arrayBuffer();
  throw new Error('Expected the bytes of a .docx file');
}
