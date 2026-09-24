// pptxtemplate.js — write a .pptx by editing the instructor's own template package (JSZip, in the browser):
// existing slides are removed, one slide per deck slide is created on the template's layout with real
// placeholders (title, body, subtitle…) plus free DrawingML shapes for Studio-drawn content, and speaker
// notes when the package has a notes master. The masters, layouts, theme and media stay untouched, so the
// result opens exactly like a deck authored on that template.
import { loadJSZip } from './export.js';
import { resolvePath } from './template.js';

const EMU = 914400;
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main', NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main', NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = { slide: `${NS_R}/slide`, layout: `${NS_R}/slideLayout`, notes: `${NS_R}/notesSlide`, notesMaster: `${NS_R}/notesMaster`, image: `${NS_R}/image`, comments: `${NS_R}/comments` };
const CT = { slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml', notes: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml', pres: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml' };
const FONT = { head: 'Cambria', body: 'Calibri', mono: 'Consolas' };

/**
 * @param {object} o
 * @param {Blob} o.templateBlob   the uploaded .pptx/.potx
 * @param {object} o.tpl          parseTemplate() output (layouts, fonts, size)
 * @param {object} o.deck         { slides: [...] }
 * @param {object} o.theme        resolved theme (fonts used for free text)
 * @param {object} o.meta         { course, chapter }
 * @param {Array}  o.script       [{ slide_id, narration }] → speaker notes
 * @param {function} o.elementsFor (slide, index) → { layout, els } — elements in deck.js's schema; `ph` marks placeholders
 * @param {function} [o.rasterize] (element) → PNG data URL, used for charts (and any element the writer cannot draw)
 * @returns {Promise<Blob>}
 */
export async function buildTemplatePptx({ templateBlob, tpl = {}, deck, theme = {}, meta = {}, script = [], elementsFor, rasterize }) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(templateBlob);
  const read = async p => { const f = zip.file(p); return f ? await f.async('string') : null; };
  const fonts = { head: theme.fonts?.head || tpl.fonts?.head || FONT.head, body: theme.fonts?.body || tpl.fonts?.body || FONT.body, mono: FONT.mono };

  // ---- package parts
  let ct = await read('[Content_Types].xml'); if (!ct) throw new Error('Not a PowerPoint package (missing [Content_Types].xml)');
  let pres = await read('ppt/presentation.xml'); if (!pres) throw new Error('Not a PowerPoint package (missing ppt/presentation.xml)');
  let presRels = (await read('ppt/_rels/presentation.xml.rels')) || `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

  // ---- remove existing slides (and their notes / comments), keep everything else
  const relList = parseRels(presRels);
  const oldSlides = relList.filter(r => r.type === REL.slide);
  const drop = new Set();
  for (const r of oldSlides) {
    const path = resolvePath('ppt/', r.target); drop.add(path); drop.add(relsOf(path));
    const sub = parseRels((await read(relsOf(path))) || '');
    for (const s of sub) if (s.type === REL.notes || s.type === REL.comments) { const sp = resolvePath(dirOf(path), s.target); drop.add(sp); drop.add(relsOf(sp)); }
  }
  for (const p of Object.keys(zip.files)) if (/^ppt\/slides\/(slide\d+\.xml|_rels\/slide\d+\.xml\.rels)$/.test(p)) drop.add(p);
  for (const p of drop) zip.remove(p);
  ct = ct.replace(/<Override PartName="\/([^"]+)"[^>]*\/>/g, (m, part) => (drop.has(part) ? '' : m));
  presRels = presRels.replace(/<Relationship\b[^>]*\/>/g, m => (/Type="[^"]*\/relationships\/slide"/.test(m) ? '' : m));
  pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>|<p:sldIdLst\/>/, '<p:sldIdLst></p:sldIdLst>');
  if (!/<p:sldIdLst>/.test(pres)) pres = pres.replace(/<p:sldSz\b/, '<p:sldIdLst></p:sldIdLst><p:sldSz');
  pres = pres.replace(/<p:custShowLst>[\s\S]*?<\/p:custShowLst>/, '').replace(/<p:ext\b[^>]*>(?:(?!<\/p:ext>)[\s\S])*?sectionLst[\s\S]*?<\/p:ext>/g, '');
  // a .potx opens as a template; the result is an ordinary presentation
  ct = ct.replace(/(<Override PartName="\/ppt\/presentation\.xml" ContentType=")[^"]+(")/, `$1${CT.pres}$2`);
  if (!/Extension="png"/i.test(ct)) ct = ct.replace('<Default Extension="rels"', '<Default Extension="png" ContentType="image/png"/><Default Extension="rels"');
  if (!/Extension="jpeg"/i.test(ct)) ct = ct.replace('<Default Extension="rels"', '<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="rels"');

  const notesMaster = Object.keys(zip.files).find(p => /^ppt\/notesMasters\/notesMaster\d+\.xml$/.test(p)) || null;
  const layoutFiles = Object.keys(zip.files).filter(p => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(p)).sort(natural);
  if (!layoutFiles.length) throw new Error('The template has no slide layouts.');
  let nextRid = Math.max(0, ...relList.map(r => Number((r.id.match(/\d+/) || [0])[0]))) + 1;
  let maxSldId = Math.max(255, ...[...pres.matchAll(/<p:sldId id="(\d+)"/g)].map(m => Number(m[1])));
  let mediaN = Math.max(0, ...Object.keys(zip.files).map(p => Number((p.match(/^ppt\/media\/studio_(\d+)\./) || [0, 0])[1]))) + 1;

  const sldIds = [], presRelAdd = [], ctAdd = [];
  const slides = deck?.slides || [];
  for (let i = 0; i < slides.length; i++) {
    const n = i + 1; const slide = slides[i];
    const frame = elementsFor(slide, i) || {}; const els = frame.els || [];
    const layoutFile = frame.layout?.file && zip.file(frame.layout.file) ? frame.layout.file : layoutFiles[0];
    const slideRels = [{ id: 'rId1', type: REL.layout, target: `../slideLayouts/${layoutFile.split('/').pop()}` }];
    let rid = 2, shapeId = 2; const shapes = [];
    for (const e of els) {
      if (!e || e.isBackground) continue;
      const id = shapeId++;
      if (e.ph) { shapes.push(placeholderXml(e, id, fonts)); continue; }
      if (e.kind === 'rect' || e.kind === 'ellipse') { shapes.push(shapeXml(e, id)); continue; }
      if (e.kind === 'line') { shapes.push(lineXml(e, id)); continue; }
      if (e.kind === 'code') { shapes.push(textXml({ ...e, mono: true, fill: e.fill || '1E2430', color: e.color || 'E6EDF3', lines: String(e.text || '').split('\n'), valign: 'top', margin: 0.14, radius: 0.12 }, id, fonts)); continue; }
      if (e.kind === 'text') { shapes.push(textXml(e, id, fonts)); continue; }
      if (e.kind === 'chart' || e.kind === 'image') {
        let data = e.kind === 'image' ? e.src : null;
        if (!data && rasterize) { try { data = await rasterize(e); } catch { data = null; } }
        if (data && /^data:image\/(png|jpeg);base64,/.test(data)) {
          const ext = /^data:image\/png/.test(data) ? 'png' : 'jpeg'; const name = `studio_${mediaN++}.${ext}`;
          zip.file(`ppt/media/${name}`, data.split(',')[1], { base64: true, createFolders: false });
          const r = `rId${rid++}`; slideRels.push({ id: r, type: REL.image, target: `../media/${name}` });
          shapes.push(picXml(e, id, r));
        } else shapes.push(textXml({ ...e, kind: 'text', text: e.kind === 'chart' ? `${e.title ? e.title + ' — ' : ''}chart (see the Studio preview)` : 'image', size: 12, color: '888888', valign: 'middle', align: 'center' }, id, fonts));
        continue;
      }
    }
    // notes
    const narration = (script || []).find(s => Number(s.slide_id) === Number(slide.slide_id))?.narration || slide.notes || '';
    if (notesMaster && String(narration).trim()) {
      const r = `rId${rid++}`; slideRels.push({ id: r, type: REL.notes, target: `../notesSlides/notesSlide${n}.xml` });
      zip.file(`ppt/notesSlides/notesSlide${n}.xml`, notesXml(narration), { createFolders: false });
      zip.file(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, relsXml([{ id: 'rId1', type: REL.notesMaster, target: `../notesMasters/${notesMaster.split('/').pop()}` }, { id: 'rId2', type: REL.slide, target: `../slides/slide${n}.xml` }]), { createFolders: false });
      ctAdd.push(`<Override PartName="/ppt/notesSlides/notesSlide${n}.xml" ContentType="${CT.notes}"/>`);
    }
    zip.file(`ppt/slides/slide${n}.xml`, slideXml(shapes), { createFolders: false });
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(slideRels), { createFolders: false });
    ctAdd.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT.slide}"/>`);
    const prid = `rId${nextRid++}`; presRelAdd.push(`<Relationship Id="${prid}" Type="${REL.slide}" Target="slides/slide${n}.xml"/>`);
    sldIds.push(`<p:sldId id="${++maxSldId}" r:id="${prid}"/>`);
  }
  pres = pres.replace('<p:sldIdLst></p:sldIdLst>', `<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>`);
  presRels = presRels.replace('</Relationships>', `${presRelAdd.join('')}</Relationships>`);
  ct = ct.replace('</Types>', `${ctAdd.join('')}</Types>`);
  zip.file('ppt/presentation.xml', pres); zip.file('ppt/_rels/presentation.xml.rels', presRels); zip.file('[Content_Types].xml', ct);
  const app = await read('docProps/app.xml'); if (app && /<Slides>\d+<\/Slides>/.test(app)) zip.file('docProps/app.xml', app.replace(/<Slides>\d+<\/Slides>/, `<Slides>${slides.length}</Slides>`).replace(/<Notes>\d+<\/Notes>/, `<Notes>${notesMaster ? slides.length : 0}</Notes>`));
  const core = await read('docProps/core.xml'); if (core) zip.file('docProps/core.xml', core.replace(/<dc:title>[\s\S]*?<\/dc:title>/, `<dc:title>${esc(meta.chapter || meta.course || 'Lecture')}</dc:title>`));
  return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', compression: 'DEFLATE' });
}

// ---------------------------------------------------------------- XML builders
const emu = v => Math.round((Number(v) || 0) * EMU);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const hex = h => { const s = String(h || '').replace('#', '').toUpperCase().slice(0, 6); return /^[0-9A-F]{6}$/.test(s) ? s : '000000'; };
const ALGN = { left: 'l', center: 'ctr', right: 'r' }, ANCHOR = { top: 't', middle: 'ctr', bottom: 'b' };

function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function notesXml(text) {
  const paras = String(text).split(/\n+/).map(l => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t xml:space="preserve">${esc(l)}</a:t></a:r></a:p>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}
function relsXml(list) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`).join('')}</Relationships>`;
}
function xfrm(e) { return `<a:xfrm><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${emu(e.w)}" cy="${emu(e.h)}"/></a:xfrm>`; }
function geom(e) {
  if (e.kind === 'ellipse') return '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>';
  if (e.radius) { const adj = Math.min(50000, Math.round(e.radius / Math.max(0.01, Math.min(e.w, e.h)) * 100000)); return `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${adj}"/></a:avLst></a:prstGeom>`; }
  return '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
}
function fill(color, opacity) { return color ? `<a:solidFill><a:srgbClr val="${hex(color)}">${opacity != null && opacity < 1 ? `<a:alpha val="${Math.round(opacity * 100000)}"/>` : ''}</a:srgbClr></a:solidFill>` : '<a:noFill/>'; }
function ln(color, width, arrow) { return color ? `<a:ln w="${Math.round((width || 1) * 12700)}">${fill(color)}${arrow ? '<a:tailEnd type="triangle"/>' : ''}</a:ln>` : '<a:ln><a:noFill/></a:ln>'; }
function name(e, id) { return `${e.ph ? phName(e.ph) : e.kind === 'text' ? 'TextBox' : e.kind === 'line' ? 'Connector' : e.kind === 'chart' ? 'Picture' : 'Shape'} ${id - 1}`; }
function phName(ph) { return { title: 'Title', ctrTitle: 'Title', subTitle: 'Subtitle', body: 'Text Placeholder', obj: 'Content Placeholder' }[ph.type] || (ph.type == null ? 'Content Placeholder' : 'Placeholder'); }

/** Free shape (rect / rounded rect / ellipse) with a solid fill and optional outline. */
function shapeXml(e, id) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name(e, id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(e)}${geom(e)}${fill(e.fill, e.opacity)}${ln(e.line, 0.75)}</p:spPr></p:sp>`;
}
/** Straight connector; `arrow` adds a triangle head at the end. */
function lineXml(e, id) {
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name(e, id)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="${emu(e.x)}" y="${emu(e.y)}"/><a:ext cx="${emu(e.w)}" cy="${emu(e.h || 0)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom>${ln(e.color || '000000', e.width || 1, e.arrow)}</p:spPr></p:cxnSp>`;
}
/** Picture from an embedded media part. */
function picXml(e, id, rid) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name(e, id)}" descr="${esc(e.title || e.alt || '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(e)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
/** Run properties for free text. */
function rPr(e, fonts, o = {}) {
  const sz = Math.round((o.size ?? e.size ?? 16) * 100);
  const face = e.mono ? fonts.mono : fonts[e.font || 'body'] || fonts.body;
  return `<a:rPr lang="en-US" sz="${sz}"${(o.bold ?? e.bold) ? ' b="1"' : ''}${(o.italic ?? e.italic) ? ' i="1"' : ''}${e.charSpacing ? ` spc="${Math.round(e.charSpacing * 100)}"` : ''} dirty="0">${fill(e.color || '000000', e.opacity)}<a:latin typeface="${esc(face)}"/><a:cs typeface="${esc(face)}"/></a:rPr>`;
}
/** Free text box: plain text, bullets (with levels) or code lines. */
function textXml(e, id, fonts) {
  const anchor = ANCHOR[e.valign] || 't'; const algn = ALGN[e.align] || 'l';
  const ins = e.margin === 0 ? 0 : emu(e.margin != null ? e.margin : 0.08);
  const spc = e.paraSpace ? `<a:spcAft><a:spcPts val="${Math.round(e.paraSpace * 100)}"/></a:spcAft>` : '';
  let paras;
  if (e.lines) paras = e.lines.map(l => `<a:p><a:pPr algn="l"/><a:r>${rPr(e, fonts)}<a:t xml:space="preserve">${esc(l.replace(/\t/g, '  '))}</a:t></a:r></a:p>`);
  else if (e.bullets) {
    const sz = e.size ?? 16;
    paras = e.bullets.map((b, k) => {
      const lvl = Number(e.levels?.[k]) || 0; const marL = emu(0.22 + lvl * 0.28), indent = -emu(0.22);
      const bu = (e.plain || e.plains?.[k]) ? '<a:buNone/>' : e.numbered ? `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>` : `<a:buFont typeface="Arial"/><a:buChar char="${lvl ? '–' : '•'}"/>`;
      return `<a:p><a:pPr marL="${e.plain ? 0 : marL}" indent="${e.plain ? 0 : indent}" algn="${algn}">${spc}${bu}</a:pPr><a:r>${rPr(e, fonts, { size: lvl ? sz * 0.88 : sz, bold: e.bold || (e.headings?.[k] ?? false) })}<a:t xml:space="preserve">${esc(b)}</a:t></a:r></a:p>`;
    });
  } else paras = String(e.text ?? '').split('\n').map(l => `<a:p><a:pPr algn="${algn}"/>${l ? `<a:r>${rPr(e, fonts)}<a:t xml:space="preserve">${esc(l)}</a:t></a:r>` : `<a:endParaRPr lang="en-US" sz="${Math.round((e.size ?? 16) * 100)}"/>`}</a:p>`);
  if (!paras.length) paras = ['<a:p><a:endParaRPr lang="en-US"/></a:p>'];
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name(e, id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(e)}${geom({ ...e, kind: 'rect' })}${e.fill ? fill(e.fill) : '<a:noFill/>'}${e.line ? ln(e.line, 0.75) : ''}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" rtlCol="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.join('')}</p:txBody></p:sp>`;
}
/** Placeholder shape: geometry and styling inherit from the layout; only text (and an explicit size when the text was shrunk) is written. */
function placeholderXml(e, id, fonts) {
  const ph = e.ph; const attrs = `${ph.type ? ` type="${esc(ph.type)}"` : ''}${ph.idx != null ? ` idx="${Number(ph.idx)}"` : ''}`;
  const sz = e.size && (e.shrunk || e.sizeFixed) ? ` sz="${Math.round(e.size * 100)}"` : '';
  const colorXml = e.colorFixed && e.color ? `<a:solidFill><a:srgbClr val="${hex(e.color)}"/></a:solidFill>` : '';
  const run = (t, o = {}) => `<a:r><a:rPr lang="en-US"${sz}${o.bold || e.bold ? ' b="1"' : ''}${e.italic ? ' i="1"' : ''} dirty="0"${colorXml ? `>${colorXml}</a:rPr>` : '/>'}<a:t xml:space="preserve">${esc(t)}</a:t></a:r>`;
  let paras;
  if (e.bullets) {
    paras = e.bullets.map((b, k) => {
      const lvl = Math.max(0, Math.min(8, Number(e.levels?.[k]) || 0));
      const pPr = (e.plain || e.plains?.[k]) ? `<a:pPr marL="0" indent="0"${lvl ? ` lvl="${lvl}"` : ''}><a:buNone/></a:pPr>` : e.numbered ? `<a:pPr${lvl ? ` lvl="${lvl}"` : ''}><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>` : lvl ? `<a:pPr lvl="${lvl}"/>` : '';
      return `<a:p>${pPr}${run(b, { bold: e.headings?.[k] })}</a:p>`;
    });
  } else paras = String(e.text ?? '').split('\n').map(l => `<a:p>${l ? run(l) : '<a:endParaRPr lang="en-US"/>'}</a:p>`);
  if (!paras.length) paras = ['<a:p><a:endParaRPr lang="en-US"/></a:p>'];
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name(e, id)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph${attrs}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.join('')}</p:txBody></p:sp>`;
}

// ---------------------------------------------------------------- package helpers
function parseRels(text) { return [...String(text).matchAll(/<Relationship\b([^>]*)\/>/g)].map(m => ({ id: attr(m[1], 'Id'), type: attr(m[1], 'Type'), target: attr(m[1], 'Target') })); }
function attr(s, k) { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1] : ''; }
function dirOf(p) { return p.slice(0, p.lastIndexOf('/') + 1); }
function relsOf(p) { return `${dirOf(p)}_rels/${p.slice(dirOf(p).length)}.rels`; }
function natural(a, b) { return Number((a.match(/(\d+)\.xml$/) || [0, 0])[1]) - Number((b.match(/(\d+)\.xml$/) || [0, 0])[1]); }
