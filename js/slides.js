// slides.js — render slide JSON to HTML, to a canvas (for video), to Beamer LaTeX and to PPTX.

export const W = 1280, H = 720;

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function slideHTML(slide, idx, total, meta = {}) {
  const bullets = (slide.bullets || []).map(b => `<li>${esc(b)}</li>`).join('');
  const code = slide.code ? `<pre class="slide-code"><code>${esc(slide.code)}</code></pre>` : '';
  return `<section class="slide" data-idx="${idx}">
  <header class="slide-head"><span>${esc(meta.course || '')}</span><span>${esc(meta.chapter || '')}</span></header>
  <h2 class="slide-title">${esc(slide.title)}</h2>
  <div class="slide-body ${slide.code ? 'has-code' : ''}"><ul>${bullets}</ul>${code}</div>
  <footer class="slide-foot"><span>Instructional Agents</span><span>${idx + 1} / ${total}</span></footer>
</section>`;
}

/** Draw a slide onto a 2D canvas context of size W×H. Pure canvas; no DOM needed. */
export function drawSlide(ctx, slide, idx, total, meta = {}, theme = THEMES.studio) {
  ctx.save();
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H);
  // top accent bar
  ctx.fillStyle = theme.accent; ctx.fillRect(0, 0, W, 8);
  ctx.fillStyle = theme.muted; ctx.font = '500 20px "DM Sans", "Segoe UI", Arial, sans-serif'; ctx.textBaseline = 'top';
  ctx.fillText(truncate(ctx, meta.course || '', 620), 64, 32);
  ctx.textAlign = 'right'; ctx.fillText(truncate(ctx, meta.chapter || '', 520), W - 64, 32); ctx.textAlign = 'left';
  // title
  ctx.fillStyle = theme.ink; ctx.font = '700 44px Georgia, "Times New Roman", serif';
  let y = 84;
  const titleLines = wrap(ctx, slide.title || '', W - 128).slice(0, 2);
  for (const l of titleLines) { ctx.fillText(l, 64, y); y += 54; }
  ctx.fillStyle = theme.accent; ctx.fillRect(64, y + 2, 90, 4); y += 30;
  // body layout
  const hasCode = !!(slide.code && slide.code.trim());
  const bodyW = hasCode ? Math.floor((W - 128) * 0.52) : W - 128;
  const bullets = slide.bullets || [];
  const bodyH = H - y - 70;
  let size = bullets.length > 5 ? 24 : 28;
  let lines;
  do {
    ctx.font = `400 ${size}px "DM Sans", "Segoe UI", Arial, sans-serif`;
    lines = bullets.map(b => wrap(ctx, b, bodyW - 36));
    var needed = lines.reduce((a, ls) => a + ls.length * size * 1.35 + size * 0.6, 0);
    if (needed <= bodyH) break; size -= 2;
  } while (size >= 16);
  let by = y;
  ctx.fillStyle = theme.text;
  for (const ls of lines) {
    ctx.fillStyle = theme.accent; ctx.beginPath(); ctx.arc(64 + 8, by + size * 0.62, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.text;
    for (const l of ls) { ctx.fillText(l, 64 + 30, by); by += size * 1.35; }
    by += size * 0.6;
  }
  if (hasCode) {
    const cx = 64 + bodyW + 24, cw = W - 64 - cx, ch = bodyH;
    roundRect(ctx, cx, y, cw, ch, 12); ctx.fillStyle = theme.codeBg; ctx.fill();
    ctx.fillStyle = theme.codeText;
    const codeLines = slide.code.split('\n');
    let cs = codeLines.length > 14 ? 16 : 19;
    ctx.font = `${cs}px "DM Mono", Consolas, "Courier New", monospace`;
    let cy = y + 18;
    for (const raw of codeLines) {
      if (cy > y + ch - cs) break;
      const l = raw.replace(/\t/g, '  ');
      ctx.fillText(truncate(ctx, l, cw - 32), cx + 16, cy); cy += cs * 1.4;
    }
  }
  // footer
  ctx.fillStyle = theme.muted; ctx.font = '500 18px "DM Sans", Arial, sans-serif';
  ctx.fillText('Instructional Agents', 64, H - 40);
  ctx.textAlign = 'right'; ctx.fillText(`${idx + 1} / ${total}`, W - 64, H - 40);
  ctx.restore();
}

export const THEMES = {
  studio: { bg: '#fffefa', ink: '#283b31', text: '#29362f', muted: '#797e71', accent: '#bc5834', codeBg: '#283b31', codeText: '#f0f1ea' },
  dark: { bg: '#1c2420', ink: '#fffef7', text: '#e9eae2', muted: '#9aa094', accent: '#e0885f', codeBg: '#0f1512', codeText: '#dfe6da' },
};

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}
function truncate(ctx, text, maxW) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

// ---------- exports --------------------------------------------------------
const texEsc = s => String(s ?? '').replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');

/** Beamer source in the same spirit as the Python pipeline's LaTeX output. */
export function toBeamer(course, chapter, slides, script = []) {
  const notes = new Map(script.map(s => [s.slide_id, s.narration]));
  const frames = slides.map(s => {
    const bullets = (s.bullets || []).length ? `\\begin{itemize}\n${s.bullets.map(b => `  \\item ${texEsc(b)}`).join('\n')}\n\\end{itemize}` : '';
    const code = s.code ? `\\begin{verbatim}\n${s.code.replace(/\\end\{verbatim\}/g, '')}\n\\end{verbatim}` : '';
    const body = s.code ? `\\begin{columns}[T]\n\\begin{column}{0.55\\textwidth}\n${bullets}\n\\end{column}\n\\begin{column}{0.45\\textwidth}\n{\\scriptsize\n${code}\n}\n\\end{column}\n\\end{columns}` : bullets;
    const note = notes.get(s.slide_id) ? `\\note{${texEsc(notes.get(s.slide_id))}}\n` : '';
    return `\\begin{frame}[fragile]{${texEsc(s.title)}}\n${body}\n\\end{frame}\n${note}`;
  }).join('\n');
  return `\\documentclass[aspectratio=169]{beamer}
\\usetheme{Madrid}
\\usecolortheme{seahorse}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb}
\\usepackage{pgfpages}
% \\setbeameroption{show notes on second screen}
\\title{${texEsc(chapter.title)}}
\\subtitle{${texEsc(course.name)}}
\\author{Generated with Instructional Agents}
\\date{\\today}
\\begin{document}
\\frame{\\titlepage}
${frames}
\\end{document}
`;
}

/** Self-contained HTML deck with keyboard navigation. */
export function toHtmlDeck(course, chapter, slides, script = []) {
  const notes = new Map(script.map(s => [s.slide_id, s.narration]));
  const meta = { course: course.name, chapter: chapter.title };
  const body = slides.map((s, i) => slideHTML(s, i, slides.length, meta) + (notes.get(s.slide_id) ? `<aside class="notes">${esc(notes.get(s.slide_id))}</aside>` : '')).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(chapter.title)} — ${esc(course.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${DECK_CSS}</style></head><body>
<main id="deck">${body}</main>
<nav class="deck-nav"><button id="prev">‹</button><span id="pos"></span><button id="next">›</button><button id="notes-toggle">Notes</button></nav>
<script>${DECK_JS}</script></body></html>`;
}

export const DECK_CSS = `
:root{--bg:#fffefa;--ink:#283b31;--text:#29362f;--muted:#797e71;--accent:#bc5834;--code:#283b31}
body{margin:0;background:#e9eae2;font-family:"DM Sans","Segoe UI",Arial,sans-serif;color:var(--text)}
#deck{display:flex;flex-direction:column;align-items:center;gap:24px;padding:24px}
.slide{position:relative;width:min(100%,1120px);aspect-ratio:16/9;background:var(--bg);border-radius:12px;box-shadow:0 8px 28px #293b3114;padding:2.4% 4.6%;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;border-top:6px solid var(--accent)}
.slide-head,.slide-foot{display:flex;justify-content:space-between;color:var(--muted);font-size:clamp(9px,1.2vw,15px)}
.slide-title{font-family:Georgia,serif;color:var(--ink);font-size:clamp(16px,2.8vw,36px);margin:.5em 0 .3em;line-height:1.15}
.slide-title::after{content:"";display:block;width:70px;height:4px;background:var(--accent);margin-top:.35em}
.slide-body{flex:1;display:grid;grid-template-columns:1fr;gap:2%;min-height:0}
.slide-body.has-code{grid-template-columns:1.1fr .9fr}
.slide-body ul{margin:0;padding-left:1.2em;font-size:clamp(11px,1.7vw,22px);line-height:1.4}
.slide-body li{margin:.35em 0}.slide-body li::marker{color:var(--accent)}
.slide-code{margin:0;background:var(--code);color:#f0f1ea;border-radius:10px;padding:1em;font:clamp(9px,1.15vw,15px)/1.45 "DM Mono",Consolas,monospace;overflow:auto;white-space:pre}
.notes{width:min(100%,1120px);box-sizing:border-box;background:#fff;border-left:4px solid var(--accent);padding:12px 16px;border-radius:8px;color:#444;font-size:14px;display:none}
body.show-notes .notes{display:block}
.deck-nav{position:fixed;bottom:12px;right:12px;display:flex;gap:6px;align-items:center;background:#fff;padding:6px 10px;border-radius:8px;box-shadow:0 4px 14px #0002;font-size:13px}
.deck-nav button{border:1px solid #ddd;background:#fff;border-radius:6px;padding:4px 10px;cursor:pointer}
@media print{body{background:#fff}.slide{page-break-after:always;box-shadow:none;width:100%}.deck-nav{display:none}}
`;
const DECK_JS = `
const slides=[...document.querySelectorAll('.slide')];let i=0;const pos=document.getElementById('pos');
function go(n){i=Math.max(0,Math.min(slides.length-1,n));slides[i].scrollIntoView({behavior:'smooth',block:'center'});pos.textContent=(i+1)+' / '+slides.length}
document.getElementById('prev').onclick=()=>go(i-1);document.getElementById('next').onclick=()=>go(i+1);
document.getElementById('notes-toggle').onclick=()=>document.body.classList.toggle('show-notes');
addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')go(i+1);if(e.key==='ArrowLeft')go(i-1);if(e.key==='n')document.body.classList.toggle('show-notes')});go(0);
`;

let pptxLoading;
export async function toPptx(course, chapter, slides, script = []) {
  if (!window.PptxGenJS) {
    pptxLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/PptxGenJS/3.12.0/pptxgen.bundle.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load PptxGenJS from cdnjs')); document.head.appendChild(s); });
    await pptxLoading;
  }
  const pptx = new window.PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.defineSlideMaster({ title: 'IA', background: { color: 'FFFEFA' }, objects: [
    { rect: { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: 'BC5834' } } },
    { text: { text: course.name || '', options: { x: 0.5, y: 0.15, w: 6, h: 0.3, fontSize: 10, color: '797E71', fontFace: 'Calibri' } } },
    { text: { text: chapter.title || '', options: { x: 5.5, y: 0.15, w: 4, h: 0.3, fontSize: 10, color: '797E71', align: 'right', fontFace: 'Calibri' } } },
    { text: { text: 'Instructional Agents', options: { x: 0.5, y: 5.2, w: 4, h: 0.3, fontSize: 9, color: '797E71' } } },
  ], slideNumber: { x: 9.0, y: 5.2, fontSize: 9, color: '797E71' } });
  const notes = new Map(script.map(s => [s.slide_id, s.narration]));
  const title = pptx.addSlide({ masterName: 'IA' });
  title.addText(chapter.title || 'Lecture', { x: 0.6, y: 1.6, w: 8.8, h: 1.2, fontSize: 34, bold: true, color: '283B31', fontFace: 'Georgia' });
  title.addText(course.name || '', { x: 0.6, y: 2.9, w: 8.8, h: 0.5, fontSize: 18, color: '797E71' });
  for (const s of slides) {
    const sl = pptx.addSlide({ masterName: 'IA' });
    sl.addText(s.title, { x: 0.5, y: 0.5, w: 9, h: 0.8, fontSize: 26, bold: true, color: '283B31', fontFace: 'Georgia' });
    sl.addShape(pptx.ShapeType.rect, { x: 0.5, y: 1.28, w: 0.8, h: 0.05, fill: { color: 'BC5834' }, line: { color: 'BC5834' } });
    const hasCode = !!(s.code && s.code.trim());
    const bw = hasCode ? 4.8 : 9;
    const bullets = (s.bullets || []).map(b => ({ text: b, options: { bullet: { indent: 14 }, breakLine: true } }));
    if (bullets.length) sl.addText(bullets, { x: 0.5, y: 1.5, w: bw, h: 3.5, fontSize: bullets.length > 5 ? 14 : 16, color: '29362F', valign: 'top', paraSpaceAfter: 6 });
    if (hasCode) sl.addText(s.code, { x: 5.5, y: 1.5, w: 4, h: 3.5, fontSize: 10, fontFace: 'Consolas', color: 'F0F1EA', fill: { color: '283B31' }, valign: 'top', margin: 8 });
    const n = notes.get(s.slide_id) || s.notes; if (n) sl.addNotes(n);
  }
  return await pptx.write({ outputType: 'blob' });
}
