// template.js — read a user's .pptx/.potx in the browser and extract what we can apply to generated decks:
// theme colours, theme fonts and the slide master's background (colour or picture). Nothing is uploaded.
import { loadJSZip } from './export.js';

const NS = { a: 'http://schemas.openxmlformats.org/drawingml/2006/main', p: 'http://schemas.openxmlformats.org/presentationml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' };
const SYS = { windowText: '000000', window: 'FFFFFF' };

export async function parseTemplate(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const read = async p => { const f = zip.file(p); return f ? await f.async('string') : null; };
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const themePath = Object.keys(zip.files).find(p => /^ppt\/theme\/theme\d*\.xml$/.test(p));
  if (!themePath) throw new Error('No theme found in this file. Is it a .pptx or .potx?');
  const th = xml(await read(themePath));
  const colorOf = tag => { const n = th.getElementsByTagNameNS(NS.a, tag)[0]; if (!n) return null; const c = n.firstElementChild; if (!c) return null; if (c.localName === 'srgbClr') return c.getAttribute('val').toUpperCase(); if (c.localName === 'sysClr') return (c.getAttribute('lastClr') || SYS[c.getAttribute('val')] || '000000').toUpperCase(); return null; };
  const scheme = { dk1: colorOf('dk1'), lt1: colorOf('lt1'), dk2: colorOf('dk2'), lt2: colorOf('lt2'), accent1: colorOf('accent1'), accent2: colorOf('accent2'), accent3: colorOf('accent3'), accent4: colorOf('accent4'), accent5: colorOf('accent5'), accent6: colorOf('accent6') };
  const fontOf = tag => th.getElementsByTagNameNS(NS.a, tag)[0]?.getElementsByTagNameNS(NS.a, 'latin')[0]?.getAttribute('typeface') || null;
  const fonts = { head: fontOf('majorFont'), body: fontOf('minorFont') };
  for (const k of Object.keys(fonts)) if (!fonts[k] || /^\+/.test(fonts[k])) delete fonts[k];
  const themeName = th.documentElement.getAttribute('name') || '';

  // slide master background: solid colour or picture
  let background = null, bgColor = null;
  const masterPath = Object.keys(zip.files).find(p => /^ppt\/slideMasters\/slideMaster1\.xml$/.test(p)) || Object.keys(zip.files).find(p => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(p));
  if (masterPath) {
    const m = xml(await read(masterPath));
    const bg = m.getElementsByTagNameNS(NS.p, 'bg')[0];
    if (bg) {
      const blip = bg.getElementsByTagNameNS(NS.a, 'blip')[0];
      const srgb = bg.getElementsByTagNameNS(NS.a, 'srgbClr')[0];
      const schemeClr = bg.getElementsByTagNameNS(NS.a, 'schemeClr')[0];
      if (blip) {
        const rid = blip.getAttributeNS(NS.r, 'embed') || blip.getAttribute('r:embed');
        const relsPath = masterPath.replace('slideMasters/', 'slideMasters/_rels/') + '.rels';
        const rels = xml(await read(relsPath) || '<Relationships/>');
        const rel = [...rels.getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid);
        if (rel) {
          const target = rel.getAttribute('Target').replace(/^\.\.\//, 'ppt/');
          const f = zip.file(target);
          if (f && /\.(png|jpe?g|gif|bmp|webp)$/i.test(target)) { const blob = await f.async('blob'); const ext = target.split('.').pop().toLowerCase(); background = await toDataUrl(new Blob([blob], { type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` })); }
        }
      } else if (srgb) bgColor = srgb.getAttribute('val').toUpperCase();
      else if (schemeClr) bgColor = scheme[schemeClr.getAttribute('val')] || null;
    }
  }
  // palette roles: primary = the most saturated dark of accent1/dk2, secondary = light tint, accent = accent2
  const primary = pick([scheme.accent1, scheme.dk2, scheme.dk1], c => c && lum(c) < 0.5) || scheme.accent1 || '1E2761';
  const accent = pick([scheme.accent2, scheme.accent3, scheme.accent4, scheme.accent5, scheme.accent6], c => c && c !== primary) || 'F2B134';
  const secondary = pick([scheme.lt2, scheme.accent1 && tint(scheme.accent1, 0.85)], c => c && lum(c) > 0.6) || tint(primary, 0.85);
  return { name: file.name.replace(/\.(pptx|potx)$/i, '') + (themeName ? ` · ${themeName}` : ''), scheme, fonts, palette: { primary, secondary, accent }, background, bgColor, sizeKB: Math.round(file.size / 1024) };
}

function pick(list, pred) { return list.find(pred) || null; }
function lum(hex) { const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function tint(hex, amount) { const c = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).map(v => Math.round(v + (255 - v) * amount)); return c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(); }
function toDataUrl(blob) { return new Promise((res, rej) => { if (blob.size > 3_000_000) return rej(new Error('Background image larger than 3 MB; use a template with a smaller background.')); const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); }); }
