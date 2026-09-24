// views/storyboard.js — edit the animated-lesson storyboard scene by scene, with a live frame preview.
import { el, button, field, input, textarea, select, notice, toast } from '../ui.js';
import { storyboardOf, BEATS, drawScene, loadSceneAssets, W, H } from '../scenes.js';
import { deckOf, resolveTheme } from '../deck.js';

const BEAT_LABEL = { title_card: 'Title card', bullets: 'Bullets', formula: 'Formula card', compare: 'Compare', steps: 'Steps', stat_row: 'Stat row', recap: 'Recap', diagram: 'Diagram', chart: 'Chart', illustration: 'Illustration' };
const VISUAL_FIELDS = {
  title_card: [['subtitle', 'Subtitle', 'text'], ['accent_label', 'Small label', 'text']],
  bullets: [['bullets', 'Bullets (one per line)', 'lines'], ['highlights', 'Highlighted terms (comma separated)', 'csv']],
  recap: [['bullets', 'Takeaways (one per line)', 'lines'], ['formula', 'Formula (optional)', 'text']],
  formula: [['formula', 'Formula', 'text'], ['bullets', 'Explanation lines', 'lines'], ['highlights', 'Highlighted symbols (comma separated)', 'csv']],
  compare: [['left_title', 'Left title', 'text'], ['left_items', 'Left items', 'lines'], ['right_title', 'Right title', 'text'], ['right_items', 'Right items', 'lines'], ['formula', 'Rule (optional)', 'text']],
  steps: [['steps', 'Steps (one per line)', 'lines']],
  stat_row: [['stats', 'Stats — "value | unit | name" per line', 'stats']],
  diagram: [['nodes', 'Nodes — "id | label | kind" per line (kind: input, process, result, danger)', 'nodes'], ['edges', 'Edges — "from -> to | label" per line', 'edges'], ['caption', 'Caption', 'text']],
  chart: [['type', 'Chart type', 'charttype'], ['labels', 'Labels (comma separated)', 'csv'], ['series', 'Series — "name: v1, v2, v3" per line', 'series'], ['unit', 'Unit', 'text'], ['highlight', 'Highlight label', 'text']],
  illustration: [['prompt', 'Illustration prompt', 'long'], ['labels', 'Labels (comma separated)', 'csv'], ['caption', 'Caption', 'text']],
};

export function storyboardEditor(ctx, o) {
  const { store } = ctx; const st = o.stage; const ch = o.chapter; const p = store.project;
  const sb = storyboardOf(st.output); if (!sb.scenes.length) return null;
  const deck = deckOf(ch.stages.slides?.output); const theme = resolveTheme(deck.theme, p.deck); const meta = { course: p.course.name, chapter: ch.title };
  const ui = ctx.ui[o.key] ||= {}; let cur = Math.min(ui.scene || 0, sb.scenes.length - 1);
  const m = ctx.media[ch.id] ||= {};
  const frame = el('div', { class: 'deck-frame' }); const canvas = el('canvas', { width: W, height: H, class: 'video-canvas', style: 'max-width:100%' }); const cx = canvas.getContext('2d');
  const scrub = el('input', { type: 'range', min: 0, max: 1000, value: 850, style: 'flex:1', 'aria-label': 'Time in scene' });
  const counter = el('span', { class: 'meta' });
  let assets = { characters: [], images: {} };
  const draw = () => { drawScene(cx, sb.scenes[cur], theme, scrub.value / 1000, { index: cur, total: sb.scenes.length, assets, meta }); counter.textContent = `${cur + 1} / ${sb.scenes.length} · ${BEAT_LABEL[sb.scenes[cur].beat]} · ~${sb.scenes[cur].target_seconds}s`; };
  scrub.oninput = draw;
  loadSceneAssets({ characters: store.settings.characters !== false, images: m.images || {} }).then(a => { assets = a; draw(); });
  const strip = el('div', { class: 'deck-strip', role: 'listbox' });
  const renderStrip = () => { strip.innerHTML = ''; sb.scenes.forEach((s, i) => strip.append(el('button', { class: 'scene-chip', 'aria-current': String(i === cur), onClick: () => { cur = i; ui.scene = i; renderStrip(); draw(); buildForm(); } }, el('b', {}, `${i + 1}`), el('span', {}, `${BEAT_LABEL[s.beat] || s.beat}`), el('small', {}, s.title)))); };
  const form = el('div', { class: 'slide-form' });
  const buildForm = () => {
    const s = sb.scenes[cur]; form.innerHTML = '';
    const beat = select(BEATS.map(b => [b, BEAT_LABEL[b]]), s.beat); beat.onchange = () => { s.beat = beat.value; s.visual = s.visual || {}; buildForm(); draw(); renderStrip(); };
    const title = input({ value: s.title }); title.oninput = () => { s.title = title.value; draw(); renderStrip(); };
    const narration = textarea({ rows: 4 }, s.narration); narration.oninput = () => { s.narration = narration.value; s.target_seconds = Math.max(8, Math.round(narration.value.split(/\s+/).filter(Boolean).length / 2.6)); };
    const lines = textarea({ rows: 3 }, s.lecture_lines.join('\n')); lines.oninput = () => { s.lecture_lines = lines.value.split('\n').map(x => x.trim()).filter(Boolean); draw(); };
    const take = input({ value: s.takeaway }); take.oninput = () => { s.takeaway = take.value; draw(); };
    form.append(el('div', { class: 'form-grid' }, field('Beat', beat), field('Title', title)), field('Narration (spoken)', narration), field('Lecture lines (light up while spoken)', lines), field('Takeaway (result strip)', take));
    for (const [key, label, kind] of VISUAL_FIELDS[s.beat] || []) form.append(visualField(s, key, label, kind, draw));
    form.append(el('div', { class: 'btn-row' },
      button({ label: 'Insert scene after', icon: 'plus', size: 'sm', onClick: () => { sb.scenes.splice(cur + 1, 0, { id: `s${Date.now().toString(36)}`, beat: 'bullets', title: 'New scene', narration: '', lecture_lines: [], animations: [], takeaway: '', key_scene: false, target_seconds: 15, key_elements: [], visual: { bullets: [], highlights: [] } }); cur++; renderStrip(); buildForm(); draw(); } }),
      button({ icon: 'arrow-up', size: 'sm', variant: 'ghost', title: 'Move up', disabled: cur === 0, onClick: () => { sb.scenes.splice(cur - 1, 0, sb.scenes.splice(cur, 1)[0]); cur--; renderStrip(); buildForm(); draw(); } }),
      button({ icon: 'arrow-down', size: 'sm', variant: 'ghost', title: 'Move down', disabled: cur === sb.scenes.length - 1, onClick: () => { sb.scenes.splice(cur + 1, 0, sb.scenes.splice(cur, 1)[0]); cur++; renderStrip(); buildForm(); draw(); } }),
      button({ label: 'Delete scene', icon: 'trash', size: 'sm', variant: 'danger', disabled: sb.scenes.length < 2, onClick: () => { sb.scenes.splice(cur, 1); cur = Math.max(0, cur - 1); renderStrip(); buildForm(); draw(); } })));
  };
  const save = () => { if (store.userEdit(st, o.label, JSON.stringify(sb, null, 2), o.where)) { toast('Storyboard saved and logged', 'ok'); ctx.render(); } else toast('No changes'); };
  const box = el('div', {});
  const secs = sb.scenes.reduce((a, s) => a + (s.target_seconds || 0), 0);
  box.append(el('div', { class: 'editor-bar' }, el('span', {}, `${sb.scenes.length} scenes · about ${Math.round(secs / 60)} min · theme ${theme.name}`), button({ label: 'Save edits', size: 'sm', variant: 'primary', onClick: save }), button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => ctx.render() })));
  frame.append(el('div', { class: 'deck-toolbar' }, counter, el('span', { class: 'spacer' }), el('span', { class: 'meta' }, 'time in scene'), scrub), canvas, strip);
  box.append(el('div', { class: 'deck-grid' }, frame, form));
  renderStrip(); buildForm(); draw();
  return box;
}

function visualField(s, key, label, kind, onChange) {
  const v = s.visual ||= {};
  if (kind === 'text') { const i = input({ value: v[key] || '' }); i.oninput = () => { v[key] = i.value; onChange(); }; return field(label, i); }
  if (kind === 'long') { const t = textarea({ rows: 4 }, v[key] || ''); t.oninput = () => { v[key] = t.value; }; return field(label, t); }
  if (kind === 'lines') { const t = textarea({ rows: 4 }, (v[key] || []).join('\n')); t.oninput = () => { v[key] = t.value.split('\n').map(x => x.trim()).filter(Boolean); onChange(); }; return field(label, t); }
  if (kind === 'csv') { const i = input({ value: (v[key] || []).join(', ') }); i.oninput = () => { v[key] = i.value.split(',').map(x => x.trim()).filter(Boolean); onChange(); }; return field(label, i); }
  if (kind === 'charttype') { const sel = select([['bar', 'Bar'], ['line', 'Line'], ['pie', 'Pie']], v.type || 'bar'); sel.onchange = () => { v.type = sel.value; onChange(); }; return field(label, sel); }
  if (kind === 'stats') { const t = textarea({ rows: 4 }, (v.stats || []).map(x => `${x.value} | ${x.unit || ''} | ${x.name || ''}`).join('\n')); t.oninput = () => { v.stats = t.value.split('\n').filter(l => l.trim()).map(l => { const [a, b, c] = l.split('|').map(x => (x || '').trim()); return { value: a, unit: b, name: c }; }); onChange(); }; return field(label, t); }
  if (kind === 'nodes') { const t = textarea({ rows: 4, class: 'textarea mono' }, (v.nodes || []).map(n => `${n.id} | ${n.label} | ${n.kind || ''}`).join('\n')); t.oninput = () => { v.nodes = t.value.split('\n').filter(l => l.trim()).map((l, i) => { const [a, b, c] = l.split('|').map(x => (x || '').trim()); return { id: a || `n${i + 1}`, label: b || a, kind: c }; }); onChange(); }; return field(label, t); }
  if (kind === 'edges') { const t = textarea({ rows: 3, class: 'textarea mono' }, (v.edges || []).map(e => `${e.from} -> ${e.to}${e.label ? ' | ' + e.label : ''}`).join('\n')); t.oninput = () => { v.edges = t.value.split('\n').filter(l => l.includes('->')).map(l => { const [lhs, label] = l.split('|'); const [from, to] = lhs.split('->').map(x => x.trim()); return { from, to, label: (label || '').trim() }; }); onChange(); }; return field(label, t); }
  if (kind === 'series') { const t = textarea({ rows: 3, class: 'textarea mono' }, (v.series || []).map(sr => `${sr.name}: ${(sr.values || []).join(', ')}`).join('\n')); t.oninput = () => { v.series = t.value.split('\n').filter(l => l.includes(':')).map(l => { const k = l.indexOf(':'); return { name: l.slice(0, k).trim(), values: l.slice(k + 1).split(',').map(x => Number(x.trim())).map(x => (isFinite(x) ? x : 0)) }; }); onChange(); }; return field(label, t); }
  return el('div');
}
