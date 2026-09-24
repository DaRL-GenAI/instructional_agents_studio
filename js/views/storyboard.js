// views/storyboard.js — edit the animated-lesson storyboard scene by scene: live frame preview with playback,
// per-beat visual fields (incl. interactive practice templates), and the visual reviewer's verdicts with one-click repairs.
import { el, button, field, input, textarea, select, notice, toast, icon } from '../ui.js';
import { storyboardOf, BEATS, drawScene, loadSceneAssets, W, H } from '../scenes.js';
import { deckOf, resolveTheme } from '../deck.js';
import { PRACTICE_TEMPLATES, normalizePractice } from '../practice.js';
import { applyOps } from '../review.js';
import { getAudioContext } from '../video.js';

const BEAT_LABEL = { title_card: 'Title card', bullets: 'Bullets', formula: 'Formula card', compare: 'Compare', steps: 'Steps', stat_row: 'Stat row', recap: 'Recap', diagram: 'Diagram', chart: 'Chart', illustration: 'Illustration', practice: 'Practice (interactive)' };
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
  practice: [['__practice', 'Practice', 'practice']],
};

export function storyboardEditor(ctx, o) {
  const { store, pipe } = ctx; const st = o.stage; const ch = o.chapter; const p = store.project;
  const sb = storyboardOf(st.output); if (!sb.scenes.length) return null;
  const deck = deckOf(ch.stages.slides?.output); const theme = resolveTheme(deck.theme, p.deck); const meta = { course: p.course.name, chapter: ch.title };
  const ui = ctx.ui[o.key] ||= {}; let cur = Math.min(ui.scene || 0, sb.scenes.length - 1);
  const m = ctx.media[ch.id] ||= {};
  const verdicts = st.reviews?.scenes || {};
  const frame = el('div', { class: 'deck-frame' }); const canvas = el('canvas', { width: W, height: H, class: 'video-canvas', style: 'max-width:100%' }); const cx = canvas.getContext('2d');
  const scrub = el('input', { type: 'range', min: 0, max: 1000, value: 850, style: 'flex:1', 'aria-label': 'Time in scene' });
  const counter = el('span', { class: 'meta' });
  let assets = { characters: [], images: {} }; let dirty = false;
  const draw = () => { drawScene(cx, sb.scenes[cur], theme, scrub.value / 1000, { index: cur, total: sb.scenes.length, assets, meta }); counter.textContent = `${cur + 1} / ${sb.scenes.length} · ${BEAT_LABEL[sb.scenes[cur].beat] || sb.scenes[cur].beat} · ~${sb.scenes[cur].target_seconds}s`; };
  scrub.oninput = () => { stopPlay(); draw(); };
  loadSceneAssets({ characters: store.settings.characters !== false, images: m.images || {} }).then(a => { assets = a; draw(); });

  // ---- playback of the current scene (with its narration when synthesized)
  let raf = 0, playing = false, src = null;
  const playBtn = button({ label: 'Play scene', icon: 'play', size: 'sm', onClick: () => (playing ? stopPlay() : play()) });
  function stopPlay() { if (!playing) return; playing = false; cancelAnimationFrame(raf); try { src?.stop(); } catch { /* ignore */ } src = null; playBtn.querySelector('span:last-child') && (playBtn.lastChild.textContent = 'Play scene'); }
  async function play() {
    const a = m.scene_audios?.[cur]; const actx = getAudioContext(); if (actx.state === 'suspended') await actx.resume();
    const dur = a?.decoded?.duration || Math.max(4, sb.scenes[cur].target_seconds || 8); playing = true; playBtn.lastChild.textContent = 'Stop';
    const t0 = actx.currentTime; if (a?.decoded) { src = actx.createBufferSource(); src.buffer = a.decoded; src.connect(actx.destination); src.start(); }
    const tick = () => { if (!playing) return; const pr = Math.min(1, (actx.currentTime - t0) / dur); scrub.value = Math.round(pr * 1000); draw(); if (pr >= 1) { playing = false; try { src?.stop(); } catch { /* ignore */ } playBtn.lastChild.textContent = 'Play scene'; return; } raf = requestAnimationFrame(tick); };
    tick();
  }

  const strip = el('div', { class: 'deck-strip', role: 'listbox' });
  const chip = (s, i) => {
    const v = verdicts[s.id]; const rc = v ? el('span', { class: `review-chip ${v.passed ? 'pass' : 'fail'}`, title: v.summary }, v.passed ? '✓' : '✗', ` ${v.score ?? '–'}`) : null;
    return el('button', { class: 'scene-chip', 'aria-current': String(i === cur), onClick: () => { stopPlay(); cur = i; ui.scene = i; renderStrip(); draw(); buildForm(); } }, el('b', {}, `${i + 1}`, rc ? ' ' : '', rc), el('span', {}, `${BEAT_LABEL[s.beat] || s.beat}`), el('small', {}, s.title));
  };
  const renderStrip = () => { strip.innerHTML = ''; sb.scenes.forEach((s, i) => strip.append(chip(s, i))); };
  const form = el('div', { class: 'slide-form' });
  const touch = () => { dirty = true; };
  const buildForm = () => {
    const s = sb.scenes[cur]; form.innerHTML = '';
    const beat = select(BEATS.map(b => [b, BEAT_LABEL[b]]), s.beat); beat.onchange = () => { s.beat = beat.value; s.visual = s.visual || {}; if (s.beat === 'practice' && !s.visual.template) { const pr = normalizePractice({ template: 'multiple_choice', parameters: PRACTICE_TEMPLATES.multiple_choice?.defaults || {}, instruction: s.title }); s.visual = { template: pr.template, parameters: pr.parameters, instruction: pr.instruction, warnings: pr.warnings }; } touch(); buildForm(); draw(); renderStrip(); };
    const title = input({ value: s.title }); title.oninput = () => { s.title = title.value; touch(); draw(); renderStrip(); };
    const narration = textarea({ rows: 4 }, s.narration); narration.oninput = () => { s.narration = narration.value; s.target_seconds = Math.max(8, Math.round(narration.value.split(/\s+/).filter(Boolean).length / 2.6)); touch(); };
    const lines = textarea({ rows: 3 }, s.lecture_lines.join('\n')); lines.oninput = () => { s.lecture_lines = lines.value.split('\n').map(x => x.trim()).filter(Boolean); touch(); draw(); };
    const take = input({ value: s.takeaway }); take.oninput = () => { s.takeaway = take.value; touch(); draw(); };
    const keys = input({ value: (s.key_elements || []).join('; ') }); keys.oninput = () => { s.key_elements = keys.value.split(';').map(x => x.trim()).filter(Boolean); touch(); };
    form.append(el('div', { class: 'form-grid' }, field('Beat', beat), field('Title', title)), field('Narration (spoken)', narration), field('Lecture lines (light up while spoken)', lines), field('Takeaway (result strip)', take), field('Key elements (checked by the visual reviewer; separate with ;)', keys));
    if (s.visual_fallback) form.append(el('p', { class: 'notice warn' }, 'The model left this scene’s visual empty, so the lecture lines are shown as bullets. Edit the visual below, or re-run the storyboard with comments.'));
    for (const [key, label, kind] of VISUAL_FIELDS[s.beat] || []) form.append(visualField(s, key, label, kind, () => { touch(); draw(); }));
    const v = verdicts[s.id]; if (v) form.append(reviewPanel(v, s));
    form.append(el('div', { class: 'btn-row' },
      button({ label: 'Insert scene after', icon: 'plus', size: 'sm', onClick: () => { sb.scenes.splice(cur + 1, 0, { id: `s${Date.now().toString(36)}`, beat: 'bullets', title: 'New scene', narration: '', lecture_lines: [], animations: [], takeaway: '', key_scene: false, target_seconds: 15, key_elements: [], visual: { bullets: [], highlights: [] } }); cur++; touch(); renderStrip(); buildForm(); draw(); } }),
      button({ icon: 'arrow-up', size: 'sm', variant: 'ghost', title: 'Move up', disabled: cur === 0, onClick: () => { sb.scenes.splice(cur - 1, 0, sb.scenes.splice(cur, 1)[0]); cur--; touch(); renderStrip(); buildForm(); draw(); } }),
      button({ icon: 'arrow-down', size: 'sm', variant: 'ghost', title: 'Move down', disabled: cur === sb.scenes.length - 1, onClick: () => { sb.scenes.splice(cur + 1, 0, sb.scenes.splice(cur, 1)[0]); cur++; touch(); renderStrip(); buildForm(); draw(); } }),
      button({ label: 'Delete scene', icon: 'trash', size: 'sm', variant: 'danger', disabled: sb.scenes.length < 2, onClick: () => { sb.scenes.splice(cur, 1); cur = Math.max(0, cur - 1); touch(); renderStrip(); buildForm(); draw(); } })));
  };

  // ---- reviewer verdict panel for one scene
  function reviewPanel(v, s) {
    const box = el('div', { class: 'review-panel' });
    box.append(el('h4', {}, icon(v.passed ? 'check' : 'alert', 'sm'), `Visual review · ${v.summary || (v.passed ? 'passed' : 'failed')}`, el('span', { class: 'meta' }, `round ${v.round || 1}${v.repair ? ` · ${v.repair}` : ''}`)));
    const list = (title, items, cls) => items?.length ? el('div', {}, el('b', { class: cls || '' }, title), el('ul', {}, ...items.map(x => el('li', {}, x)))) : null;
    box.append(...[list('Missing key elements', v.missing_key_elements, 'bad'), list('Blocking issues', v.blocking_issues, 'bad'), list('Layout / timing', [...(v.layout_issues || []), ...(v.temporal_issues || [])]), list('Minor', v.minor_issues), list('Present', v.present_key_elements, 'ok')].filter(Boolean));
    if (v.guard?.length) { const g = list('Measured by the layout guard', v.guard.map(g => g.message)); if (g) box.append(g); }
    if (v.fallback_instructions) box.append(el('p', {}, el('b', {}, 'Instructions: '), v.fallback_instructions));
    const frames = el('div', { class: 'review-frames' }); box.append(frames);
    store.getMedia(ch.id, 'review_frames').then(fr => { (fr?.[s.id] || []).forEach(u => frames.append(el('img', { src: u, alt: 'reviewed frame' }))); }).catch(() => {});
    const actions = el('div', { class: 'btn-row' });
    if (v.ops?.length) actions.append(el('details', { style: 'width:100%' }, el('summary', {}, `${v.ops.length} suggested edit${v.ops.length === 1 ? '' : 's'}`), el('pre', { class: 'mono', style: 'font-size:11px;white-space:pre-wrap' }, JSON.stringify(v.ops, null, 1))),
      button({ label: 'Apply suggested edits', icon: 'check', size: 'sm', variant: 'primary', onClick: () => { const r = applyOps(s, v.ops); if (!r.applied.length) return toast(`No edit could be applied${r.failed.length ? `: ${r.failed.join('; ')}` : ''}`, 'error'); Object.assign(s, r.scene); touch(); buildForm(); draw(); toast(`Applied: ${r.applied.join(', ')} — save edits, then re-review`, 'ok'); } }));
    if (!v.passed) actions.append(button({ label: 'Re-plan this scene', icon: 'refresh', size: 'sm', disabled: !!ctx.busy, onClick: () => ctx.guarded('Re-planning scene', async () => { if (!ctx.requireKey()) return; if (dirty) save(false); const next = await pipe.repairScene(ch.id, s, v); next.id = s.id; sb.scenes[cur] = next; store.autoRevise(st, o.label, JSON.stringify(sb, null, 2), o.where, `scene ${cur + 1} re-planned after visual review`); toast('Scene re-planned. Re-review it to confirm.', 'ok'); }) }));
    actions.append(button({ label: 'Re-review this scene', icon: 'search', size: 'sm', variant: 'ghost', disabled: !!ctx.busy, onClick: () => ctx.guarded('Reviewing scene', async () => { if (!ctx.requireKey()) return; if (dirty) save(false); await pipe.reviewStoryboard(ch.id, { assets, rounds: 0, only: [s.id] }); }) }));
    box.append(actions);
    return box;
  }

  const save = (rerender = true) => { if (store.userEdit(st, o.label, JSON.stringify(sb, null, 2), o.where)) { dirty = false; toast('Storyboard saved and logged', 'ok'); if (rerender) ctx.render(); } else if (rerender) toast('No changes'); };
  const box = el('div', {});
  const secs = sb.scenes.reduce((a, s) => a + (s.target_seconds || 0), 0);
  const rv = st.reviews; const passed = rv ? Object.values(rv.scenes).filter(v => v.passed).length : 0;
  box.append(el('div', { class: 'editor-bar' }, el('span', {}, `${sb.scenes.length} scenes · about ${Math.round(secs / 60)} min · theme ${theme.name}${rv ? ` · review: ${passed}/${Object.keys(rv.scenes).length} passed` : ''}`),
    button({ label: rv ? 'Review again' : 'Run visual review', icon: 'search', size: 'sm', disabled: !!ctx.busy, title: 'An independent vision model audits rendered frames of every scene and repairs failures', onClick: () => ctx.guarded('Visual review', async () => { if (!ctx.requireKey()) return; if (dirty) save(false); const r = await pipe.reviewStoryboard(ch.id, { assets }); toast(`Visual review: ${r.summary}`, 'ok'); }) }),
    button({ label: 'Save edits', size: 'sm', variant: 'primary', onClick: () => save(true) }), button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => ctx.render() })));
  frame.append(el('div', { class: 'deck-toolbar' }, playBtn, counter, el('span', { class: 'spacer' }), el('span', { class: 'meta' }, 'time in scene'), scrub), canvas, strip);
  box.append(el('div', { class: 'deck-grid' }, frame, form));
  renderStrip(); buildForm(); draw();
  return box;
}

function visualField(s, key, label, kind, onChange) {
  const v = s.visual ||= {};
  if (kind === 'practice') return practiceFields(s, onChange);
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

/** Practice scene: template chooser + a form generated from the template's parameters; validated live like EduCast's registry. */
function practiceFields(s, onChange) {
  const v = s.visual ||= {}; const ids = Object.keys(PRACTICE_TEMPLATES);
  if (!ids.length) return notice('warn', 'Practice templates are not available in this build.');
  const box = el('div', { class: 'slide-form' });
  const warn = el('p', { class: 'practice-warn' });
  const validate = () => { const r = normalizePractice({ template: v.template, parameters: v.parameters, instruction: v.instruction }); v.warnings = r.warnings; warn.textContent = r.warnings.length ? `Validator: ${r.warnings.join(' · ')}` : ''; };
  const rebuild = () => { box.innerHTML = ''; build(); };
  const build = () => {
    const tplId = PRACTICE_TEMPLATES[v.template] ? v.template : ids[0]; v.template = tplId; const spec = PRACTICE_TEMPLATES[tplId];
    if (!v.parameters || typeof v.parameters !== 'object') v.parameters = { ...spec.defaults };
    const sel = select(ids.map(k => [k, PRACTICE_TEMPLATES[k].title]), tplId); sel.onchange = () => { v.template = sel.value; v.parameters = { ...PRACTICE_TEMPLATES[sel.value].defaults }; onChange(); rebuild(); };
    const instr = input({ value: v.instruction || '' }); instr.oninput = () => { v.instruction = instr.value; onChange(); };
    box.append(el('div', { class: 'form-grid' }, field('Practice template', sel), field('Instruction (task title)', instr)), el('p', { class: 'meta' }, spec.description));
    const params = v.parameters;
    for (const [key, def] of Object.entries(spec.defaults)) {
      const label = key.replace(/_/g, ' '); const hint = spec.parameters_schema?.[key] ? String(spec.parameters_schema[key]) : '';
      const cur = params[key] ?? def;
      if (typeof def === 'boolean') { const c = select([['true', 'yes'], ['false', 'no']], String(cur)); c.onchange = () => { params[key] = c.value === 'true'; validate(); onChange(); }; box.append(field(label, c, { hint })); }
      else if (typeof def === 'number') { const c = input({ type: 'number', step: 'any', value: cur }); c.oninput = () => { params[key] = Number(c.value); validate(); onChange(); }; box.append(field(label, c, { hint })); }
      else if (Array.isArray(def) && def.length && typeof def[0] === 'object') { const c = textarea({ rows: 3 }, (Array.isArray(cur) ? cur : []).map(b => `${b.label || ''} | ${b.answer || ''}`).join('\n')); c.oninput = () => { params[key] = c.value.split('\n').filter(l => l.trim()).map(l => { const [a, b] = l.split('|').map(x => (x || '').trim()); return { label: a, answer: b }; }); validate(); onChange(); }; box.append(field(`${label} — "label | answer" per line`, c, { hint })); }
      else if (Array.isArray(def)) { const c = textarea({ rows: 3 }, (Array.isArray(cur) ? cur : []).join('\n')); c.oninput = () => { params[key] = c.value.split('\n').map(x => x.trim()).filter(Boolean); validate(); onChange(); }; box.append(field(`${label} (one per line)`, c, { hint })); }
      else { const long = /explanation|prompt|question|instruction|hint/.test(key); const c = long ? textarea({ rows: 2 }, String(cur ?? '')) : input({ value: String(cur ?? '') }); c.oninput = () => { params[key] = c.value; validate(); onChange(); }; box.append(field(label, c, { hint })); }
    }
    box.append(warn); validate();
  };
  build();
  return box;
}
