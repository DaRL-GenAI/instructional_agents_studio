// template.js — read a user's .pptx/.potx in the browser and extract what generated decks can reuse:
// theme colours and fonts, the slide size, the slide master (background, text styles, placeholder geometry)
// and every slide layout with its placeholders. Nothing is uploaded. The result is JSON-serialisable apart
// from `blob` (the original file), which the caller stores separately.
import { loadJSZip } from './export.js';

const NS = { a: 'http://schemas.openxmlformats.org/drawingml/2006/main', p: 'http://schemas.openxmlformats.org/presentationml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' };
const SYS = { windowText: '000000', window: 'FFFFFF' };
const EMU = 914400;
const TEXT_PH = new Set(['title', 'ctrTitle', 'subTitle', 'body', 'obj']);
const LAYOUT_BG_LIMIT = 1_500_000, MASTER_BG_LIMIT = 3_000_000;

export async function parseTemplate(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const files = Object.keys(zip.files);
  const read = async p => { const f = zip.file(p); return f ? await f.async('string') : null; };
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const el = (doc, ns, tag) => doc.getElementsByTagNameNS(NS[ns], tag)[0] || null;
  const els = (doc, ns, tag) => [...doc.getElementsByTagNameNS(NS[ns], tag)];

  // ---- theme
  const themePath = files.find(p => /^ppt\/theme\/theme\d*\.xml$/.test(p));
  if (!themePath) throw new Error('No theme found in this file. Is it a .pptx or .potx?');
  const th = xml(await read(themePath));
  const colorOf = tag => { const n = el(th, 'a', tag); const c = n?.firstElementChild; if (!c) return null; if (c.localName === 'srgbClr') return up(c.getAttribute('val')); if (c.localName === 'sysClr') return up(c.getAttribute('lastClr') || SYS[c.getAttribute('val')] || '000000'); return null; };
  const scheme = { dk1: colorOf('dk1'), lt1: colorOf('lt1'), dk2: colorOf('dk2'), lt2: colorOf('lt2'), accent1: colorOf('accent1'), accent2: colorOf('accent2'), accent3: colorOf('accent3'), accent4: colorOf('accent4'), accent5: colorOf('accent5'), accent6: colorOf('accent6'), hlink: colorOf('hlink'), folHlink: colorOf('folHlink') };
  const fontOf = tag => el(th, 'a', tag)?.getElementsByTagNameNS(NS.a, 'latin')[0]?.getAttribute('typeface') || null;
  const fonts = { head: fontOf('majorFont'), body: fontOf('minorFont') };
  for (const k of Object.keys(fonts)) if (!fonts[k] || /^\+/.test(fonts[k])) delete fonts[k];
  const themeName = th.documentElement.getAttribute('name') || '';

  // ---- presentation: slide size, first master
  const pres = xml((await read('ppt/presentation.xml')) || '<p:presentation xmlns:p="' + NS.p + '"/>');
  const sz = el(pres, 'p', 'sldSz');
  const size = { w: round(Number(sz?.getAttribute('cx') || 9144000) / EMU), h: round(Number(sz?.getAttribute('cy') || 6858000) / EMU) };
  const presRels = await rels(read, 'ppt/presentation.xml');
  const firstMasterId = el(pres, 'p', 'sldMasterId')?.getAttributeNS(NS.r, 'id');
  let masterPath = presRels.find(r => r.id === firstMasterId && /slideMaster$/.test(r.type))?.target
    || presRels.find(r => /slideMaster$/.test(r.type))?.target
    || files.find(p => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p)) || null;

  // ---- colour resolution through the master's clrMap
  let clrMap = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink' };
  const resolveColor = node => { // node: an element that contains a colour choice child (srgbClr | schemeClr | sysClr | prstClr)
    if (!node) return null;
    const c = [...node.children].find(x => /^(srgbClr|schemeClr|sysClr|prstClr)$/.test(x.localName)); if (!c) return null;
    let hex = null;
    if (c.localName === 'srgbClr') hex = up(c.getAttribute('val'));
    else if (c.localName === 'sysClr') hex = up(c.getAttribute('lastClr') || SYS[c.getAttribute('val')] || '000000');
    else if (c.localName === 'schemeClr') { const v = c.getAttribute('val'); hex = scheme[clrMap[v] || v] || null; }
    else if (c.localName === 'prstClr') hex = PRESET[c.getAttribute('val')] || null;
    if (!hex) return null;
    const mod = num(c, 'lumMod'), off = num(c, 'lumOff');
    if (mod != null || off != null) hex = lum(hex, mod == null ? 1 : mod / 100000, off == null ? 0 : off / 100000);
    return hex;
  };
  const num = (c, tag) => { const n = c.getElementsByTagNameNS(NS.a, tag)[0]; return n ? Number(n.getAttribute('val')) : null; };

  // ---- backgrounds and placeholders of one part (master or layout)
  const partInfo = async (path, limit) => {
    const text = await read(path); if (!text) return null;
    const doc = xml(text); const partRels = await rels(read, path);
    const out = { doc, background: null, bgColor: null, placeholders: [] };
    const bg = el(doc, 'p', 'bg');
    if (bg) {
      const blip = bg.getElementsByTagNameNS(NS.a, 'blip')[0];
      if (blip) {
        const rid = blip.getAttributeNS(NS.r, 'embed') || blip.getAttribute('r:embed');
        const rel = partRels.find(r => r.id === rid);
        if (rel) { const f = zip.file(rel.target); if (f && /\.(png|jpe?g|gif|bmp|webp)$/i.test(rel.target)) { const blob = await f.async('blob'); const ext = rel.target.split('.').pop().toLowerCase(); out.background = await toDataUrl(new Blob([blob], { type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }), limit); } }
      } else {
        const pr = el(bg, 'p', 'bgPr'), ref = el(bg, 'p', 'bgRef');
        const solid = pr ? pr.getElementsByTagNameNS(NS.a, 'solidFill')[0] : null;
        const grad = pr ? pr.getElementsByTagNameNS(NS.a, 'gs')[0] : null;
        out.bgColor = resolveColor(solid || grad || ref) || null;
      }
    }
    for (const sp of els(doc, 'p', 'sp')) {
      const ph = sp.getElementsByTagNameNS(NS.p, 'ph')[0]; if (!ph) continue;
      const hasType = ph.hasAttribute('type'); const type = hasType ? ph.getAttribute('type') : 'body';
      const idx = ph.hasAttribute('idx') ? Number(ph.getAttribute('idx')) : null;
      const xf = sp.getElementsByTagNameNS(NS.p, 'spPr')[0]?.getElementsByTagNameNS(NS.a, 'xfrm')[0];
      const off = xf?.getElementsByTagNameNS(NS.a, 'off')[0], ext = xf?.getElementsByTagNameNS(NS.a, 'ext')[0];
      const geom = off && ext ? { x: round(Number(off.getAttribute('x')) / EMU), y: round(Number(off.getAttribute('y')) / EMU), w: round(Number(ext.getAttribute('cx')) / EMU), h: round(Number(ext.getAttribute('cy')) / EMU) } : null;
      const anchor = sp.getElementsByTagNameNS(NS.a, 'bodyPr')[0]?.getAttribute('anchor') || null;
      out.placeholders.push({ type, hasType, idx, ...(geom || { x: null, y: null, w: null, h: null }), anchor, name: sp.getElementsByTagNameNS(NS.p, 'cNvPr')[0]?.getAttribute('name') || '' });
    }
    return { ...out, rels: partRels };
  };

  // ---- master
  let master = { background: null, bgColor: null, title: { size: 44, color: scheme.dk1 || '000000', font: fonts.head || null, align: 'left', anchor: 'middle' }, body: { size: 28, color: scheme.dk1 || '000000', font: fonts.body || null, bullet: '•', anchor: 'top' }, lvl2Size: 24, placeholders: [] };
  let masterInfo = null;
  if (masterPath) {
    const mdoc = xml((await read(masterPath)) || '');
    const cm = el(mdoc, 'p', 'clrMap');
    if (cm) for (const k of Object.keys(clrMap)) if (cm.getAttribute(k)) clrMap[k] = cm.getAttribute(k);
    masterInfo = await partInfo(masterPath, MASTER_BG_LIMIT);
    master.background = masterInfo.background; master.bgColor = masterInfo.bgColor; master.placeholders = masterInfo.placeholders.filter(p => p.x != null);
    const styles = el(mdoc, 'p', 'txStyles');
    const lvl = (styleTag, lvlTag) => styles ? el(styles, 'p', styleTag)?.getElementsByTagNameNS(NS.a, lvlTag)[0] || null : null;
    const t1 = lvl('titleStyle', 'lvl1pPr'), b1 = lvl('bodyStyle', 'lvl1pPr'), b2 = lvl('bodyStyle', 'lvl2pPr');
    const readStyle = (pPr, base) => {
      if (!pPr) return base;
      const rpr = pPr.getElementsByTagNameNS(NS.a, 'defRPr')[0];
      const size = rpr?.getAttribute('sz') ? Number(rpr.getAttribute('sz')) / 100 : base.size;
      const color = resolveColor(rpr?.getElementsByTagNameNS(NS.a, 'solidFill')[0]) || base.color;
      const latin = rpr?.getElementsByTagNameNS(NS.a, 'latin')[0]?.getAttribute('typeface');
      const font = latin && !/^\+/.test(latin) ? latin : base.font;
      const align = { l: 'left', ctr: 'center', r: 'right', just: 'left' }[pPr.getAttribute('algn')] || base.align || 'left';
      const bu = pPr.getElementsByTagNameNS(NS.a, 'buChar')[0]; const none = pPr.getElementsByTagNameNS(NS.a, 'buNone')[0];
      return { ...base, size, color, font, align, bullet: none ? '' : bu ? bu.getAttribute('char') : base.bullet };
    };
    master.title = readStyle(t1, master.title); master.body = readStyle(b1, master.body);
    const l2 = readStyle(b2, { size: master.lvl2Size }); master.lvl2Size = l2.size;
    const tph = master.placeholders.find(p => p.type === 'title'); if (tph?.anchor) master.title.anchor = { t: 'top', ctr: 'middle', b: 'bottom' }[tph.anchor] || 'middle';
    const bph = master.placeholders.find(p => p.type === 'body'); if (bph?.anchor) master.body.anchor = { t: 'top', ctr: 'middle', b: 'bottom' }[bph.anchor] || 'top';
    delete master.title.bullet;
  }
  const masterPh = (type, idx) => master.placeholders.find(p => p.type === type && (idx == null || p.idx === idx)) || master.placeholders.find(p => p.type === type) || null;

  // ---- layouts, in the master's order
  const layouts = [];
  if (masterInfo) {
    const ids = els(masterInfo.doc, 'p', 'sldLayoutId').map(n => n.getAttributeNS(NS.r, 'id'));
    const paths = ids.map(id => masterInfo.rels.find(r => r.id === id)?.target).filter(Boolean);
    for (const path of paths) {
      const info = await partInfo(path, LAYOUT_BG_LIMIT); if (!info) continue;
      const ldoc = info.doc; const root = ldoc.documentElement;
      const type = root.getAttribute('type') || '';
      const name = el(ldoc, 'p', 'cSld')?.getAttribute('name') || path.split('/').pop();
      const placeholders = info.placeholders.map(p => {
        if (p.x != null) return strip(p);
        const fb = masterPh(p.type === 'ctrTitle' ? 'title' : p.type === 'subTitle' ? 'body' : p.type === 'obj' ? 'body' : p.type, p.idx) || (TEXT_PH.has(p.type) && p.type !== 'title' && p.type !== 'ctrTitle' ? masterPh('body') : null);
        return strip({ ...p, x: fb?.x ?? null, y: fb?.y ?? null, w: fb?.w ?? null, h: fb?.h ?? null, inherited: true });
      }).filter(p => p.x != null || TEXT_PH.has(p.type));
      const hasText = placeholders.some(p => TEXT_PH.has(p.type));
      if (!hasText && type !== 'blank') continue;
      layouts.push({ id: path.split('/').pop().replace('.xml', ''), file: path, name, type, placeholders, background: info.background, bgColor: info.bgColor });
    }
  }

  // ---- palette roles: primary = the most saturated dark of accent1/dk2, secondary = light tint, accent = accent2
  const primary = pick([scheme.accent1, scheme.dk2, scheme.dk1], c => c && lumOf(c) < 0.5) || scheme.accent1 || '1E2761';
  const accent = pick([scheme.accent2, scheme.accent3, scheme.accent4, scheme.accent5, scheme.accent6], c => c && c !== primary) || 'F2B134';
  const secondary = pick([scheme.lt2, scheme.accent1 && tint(scheme.accent1, 0.85)], c => c && lumOf(c) > 0.6) || tint(primary, 0.85);
  master.bgLum = master.background ? await imageLuminance(master.background) : (master.bgColor ? lumOf(master.bgColor) : 1);
  for (const l of layouts) l.bgLum = l.background ? await imageLuminance(l.background) : (l.bgColor ? lumOf(l.bgColor) : master.bgLum);
  return {
    name: file.name.replace(/\.(pptx|potx)$/i, '') + (themeName ? ` · ${themeName}` : ''),
    scheme, fonts, palette: { primary, secondary, accent },
    background: master.background, bgColor: master.bgColor, bgLum: master.bgLum ?? null, sizeKB: Math.round(file.size / 1024),
    size, aspect: round(size.w / size.h),
    layouts, master, blob: file,
  };
}

/** Names of the layouts an instructor can pick per slide. */
export function templateLayoutNames(tpl) { return (tpl?.layouts || []).map(l => l.name); }

// ---------------------------------------------------------------- helpers
async function rels(read, partPath) {
  const dir = partPath.slice(0, partPath.lastIndexOf('/') + 1); const name = partPath.slice(dir.length);
  const text = await read(`${dir}_rels/${name}.rels`); if (!text) return [];
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return [...doc.getElementsByTagName('Relationship')].map(r => ({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', target: resolvePath(dir, r.getAttribute('Target') || ''), mode: r.getAttribute('TargetMode') || '' }));
}
export function resolvePath(baseDir, target) {
  if (/^\//.test(target)) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
  return parts.join('/');
}
const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', gray: '808080', yellow: 'FFFF00' };
function strip(p) { const { hasType, ...rest } = p; return { ...rest, hasType: !!hasType }; }
function pick(list, pred) { return list.find(pred) || null; }
function up(h) { return String(h || '').replace('#', '').toUpperCase().slice(0, 6); }
function round(v) { return Math.round(v * 1000) / 1000; }
function lumOf(hex) { const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function tint(hex, amount) { const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).map(v => Math.round(v + (255 - v) * amount)); return c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(); }
/** DrawingML lumMod/lumOff: scale and offset HSL luminance. */
function lum(hex, mod, off) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; let l = (max + min) / 2;
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min); h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? ((b - r) / d + 2) : ((r - g) / d + 4); h /= 6; }
  l = Math.max(0, Math.min(1, l * mod + off));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  const out = max === min ? [l, l, l] : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
  return out.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Average relative luminance (0..1) of an image data URL, sampled on a small canvas; null when it cannot be read. */
export function imageLuminance(dataUrl) {
  return new Promise(res => {
    if (!dataUrl || typeof document === 'undefined') return res(null);
    const im = new Image(); im.onload = () => { try { const c = document.createElement('canvas'); c.width = 24; c.height = 14; const ctx = c.getContext('2d'); ctx.drawImage(im, 0, 0, 24, 14); const d = ctx.getImageData(0, 0, 24, 14).data; let sum = 0, n = 0; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; sum += a * l + (1 - a); n++; } res(n ? sum / n : null); } catch { res(null); } }; im.onerror = () => res(null); im.src = dataUrl;
  });
}
function toDataUrl(blob, limit) { return new Promise(res => { if (blob.size > limit) return res(null); const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(null); r.readAsDataURL(blob); }); }
