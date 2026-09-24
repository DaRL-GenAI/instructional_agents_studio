// views/videos.js — Lecture videos: (1) narrated slides, (2) animated lesson (EduCast-style storyboard).
import { el, button, badge, field, select, notice, empty, icon, toast, fmtBytes, tabs, segmented } from '../ui.js';
import { chapterRail, noChapters } from './chapters.js';
import { stageDetail, stageStatus } from './stage.js';
import { safeJson } from '../pipeline.js';
import { deckOf, resolveTheme } from '../deck.js';
import { storyboardOf, loadSceneAssets } from '../scenes.js';
import { synthesize, recordVideo, recordAnimated, buildVtt, mountPreview, mountAnimatedPreview, pickMime, getAudioContext } from '../video.js';
import { download, textBlob, slug, scriptMarkdown, loadJSZip } from '../export.js';
import { sha1Short } from '../llm.js';
import { go } from '../router.js';
import { CHAPTER_STAGES } from '../prompts.js';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

export function render(ctx) {
  const { store, pipe } = ctx; const p = store.project;
  if (!p.chapters.length) return noChapters(ctx, 'Lecture videos');
  const chId = store.chapter(ctx.route.a) ? ctx.route.a : p.chapters[0].id;
  const ch = store.chapter(chId); const idx = p.chapters.indexOf(ch);
  const m = ctx.media[chId] ||= {}; const mode = m.mode || ch.stages.video?.mode || (ch.stages.storyboard?.status === 'done' ? 'animated' : 'slides');
  const tab = ctx.route.b === 'storyboard' ? 'storyboard' : 'video';
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Lecture videos'), el('p', {}, 'Two ways to make a lecture video for each chapter. Both are narrated with the TTS model and recorded in this tab; audio, storyboards and videos are kept in this browser.'))));
  const main = el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' });
  main.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:12px' }, el('div', {}, el('span', { class: 'meta' }, `Chapter ${idx + 1} of ${p.chapters.length}`), el('h2', { style: 'margin-top:2px' }, ch.title)),
    el('div', { class: 'btn-row' }, button({ icon: 'arrow-left', size: 'sm', variant: 'ghost', title: 'Previous chapter', disabled: idx === 0, onClick: () => go('p', p.id, 'videos', p.chapters[idx - 1].id, tab) }), button({ icon: 'arrow-right', size: 'sm', variant: 'ghost', title: 'Next chapter', disabled: idx >= p.chapters.length - 1, onClick: () => go('p', p.id, 'videos', p.chapters[idx + 1].id, tab) }))));
  main.append(el('div', { class: 'mode-cards' },
    el('button', { class: 'mode-card', 'aria-pressed': String(mode === 'slides'), onClick: () => { m.mode = 'slides'; ctx.render(); } }, el('b', {}, 'Option 1 · Narrated slides'), el('small', {}, 'Each PowerPoint slide is shown while its lecture-script narration plays. Quick, faithful to the deck.')),
    el('button', { class: 'mode-card', 'aria-pressed': String(mode === 'animated'), onClick: () => { m.mode = 'animated'; ctx.render(); } }, el('b', {}, 'Option 2 · Animated lesson (EduCast)'), el('small', {}, 'A Lesson Director agent splits the chapter into 6–8 teaching scenes: lecture lines light up as they are spoken, diagrams, charts, formulas and steps build step by step, optional AI illustrations, takeaway strip, characters.'))));
  if (mode === 'animated') {
    main.append(tabs([['storyboard', 'Storyboard'], ['video', 'Video']], tab, k => go('p', p.id, 'videos', chId, k)));
    const body = el('div', { class: 'tab-body' });
    body.append(tab === 'storyboard' ? storyboardStage(ctx, ch) : animatedVideo(ctx, ch, m));
    main.append(body);
  } else main.append(slidesVideo(ctx, ch, m));
  page.append(el('div', { class: 'two-pane' }, chapterRail(ctx, 'videos', ['video'], chId), main));
  return page;
}

// ---------------------------------------------------------------- storyboard stage (stageDetail with the storyboard editor)
function storyboardStage(ctx, ch) {
  const { store, pipe } = ctx; const st = CHAPTER_STAGES.find(s => s.id === 'storyboard');
  const stage = store.chapterStage(ch.id, 'storyboard'); const inputs = pipe.chapterInputs(ch.id, 'storyboard');
  if (!ch.stages.slides?.output || !ch.stages.script?.output) return empty({ icon: 'presentation', title: 'Slides and script needed first', body: 'The Lesson Director plans scenes from the slide deck and the lecture script of this chapter.', actions: [button({ label: 'Open Slides', variant: 'primary', onClick: () => go('p', store.id, 'slides', ch.id) })] });
  const agent = pipe.defaultChapterPrompt(ch.id, 'storyboard').agents[0];
  return stageDetail(ctx, { key: `c:${ch.id}:storyboard`, title: 'Storyboard', subtitle: `${agent.name} · ${agent.role}`, stage, inputs, kind: 'storyboard', file: st.file, label: `${ch.title} / Storyboard`, where: ch.title, chapter: ch,
    defaultPrompt: () => pipe.defaultChapterPrompt(ch.id, 'storyboard'),
    run: ({ feedback } = {}) => ctx.guarded(`Planning scenes · ${ch.title}`, async () => { if (!ctx.requireKey()) return; await pipe.runChapterStage(ch.id, 'storyboard', { feedback }); toast(`Storyboard ${feedback ? 'revised' : 'planned'}`, 'ok'); }),
    next: () => go('p', store.id, 'videos', ch.id, 'video') });
}

// ---------------------------------------------------------------- option 1: narrated slides
function slidesVideo(ctx, ch, m) {
  const { store, pipe } = ctx; const p = store.project; const chId = ch.id;
  const stage = store.chapterStage(chId, 'video'); const inputs = pipe.chapterInputs(chId, 'video');
  const deck = deckOf(ch.stages.slides?.output); const scriptRaw = safeJson(ch.stages.script?.output, null);
  const slides = deck.slides.length ? deck.slides : null; const script = Array.isArray(scriptRaw) && scriptRaw.length ? scriptRaw : null;
  const theme = resolveTheme(deck.theme, p.deck);
  const box = el('div', {});
  box.append(el('div', { class: 'stage-head' }, el('div', {}, el('h3', {}, 'Narrated slides'), el('p', { class: 'muted', style: 'font-size:var(--fs-2)' }, `Deck theme: ${theme.name}`)), el('div', { class: 'meta-col' }, badge(stageStatus(pipe, stage, inputs)), stage.output && stage.mode !== 'animated' ? el('small', {}, stage.output) : null)));
  if (!slides || !script) { box.append(el('div', { style: 'margin-top:16px' }, empty({ icon: 'presentation', title: 'Slides and script needed first', body: 'The video reads the slide deck and the lecture script of this chapter.', actions: [button({ label: 'Open Slides', variant: 'primary', onClick: () => go('p', p.id, 'slides', chId) })] }))); return box; }
  if (slides.length !== script.length) box.append(el('div', { style: 'margin-top:12px' }, notice('warn', `The script has ${script.length} entries but the deck has ${slides.length} slides. Re-run the script after editing slides.`)));
  loadMedia(ctx, ch, m, 'audios', 'video', script);
  const voiceSel = select(VOICES, m.voice || store.settings.voice); voiceSel.onchange = () => { m.voice = voiceSel.value; };
  const progress = el('p', { class: 'meta', style: 'margin:8px 0' }, `${slides.length} slides · ${script.reduce((a, s) => a + (s.narration || '').length, 0).toLocaleString()} narration characters`);
  const previewBox = el('div', { style: 'margin:12px 0' }); const meta = { course: p.course.name, chapter: ch.title }; const mime = pickMime();
  const synth = () => ctx.guarded('Synthesizing narration', async () => {
    if (!ctx.requireKey()) return;
    m.audios = await synthesize(pipe.client, store, script, { where: ch.title, voice: voiceSel.value, cache: m.cache ||= new Map(), onProgress: e => { progress.textContent = e.text; } });
    m.vtt = buildVtt(script, m.audios); await store.putMedia(chId, 'audios', m.audios.map(a => ({ slide_id: a.slide_id, buffer: a.buffer, seconds: a.seconds })));
    const secs = m.audios.reduce((a, x) => a + (x.seconds || 0), 0);
    store.applyResult(stage, `${ch.title} / Lecture video`, { output: `Narration ready: ${m.audios.length} clips, ${Math.round(secs)} s (voice ${voiceSel.value}). Video not recorded yet.`, usage: null, durationMs: 0, transcript: [], inputHash: pipe.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, ch.title, { narrationSeconds: secs, voice: voiceSel.value, mode: 'slides' });
    toast('Narration ready. Preview it, then record.', 'ok');
  });
  const record = () => ctx.guarded('Recording video', async () => {
    const ctrl = new AbortController(); pipe.abort = ctrl; progress.textContent = 'Recording. Keep this tab visible until it finishes.';
    const res = await recordVideo({ slides, script, audios: m.audios, meta, theme, signal: ctrl.signal, onProgress: e => { progress.textContent = e.text; } });
    await finishRecording(ctx, ch, m, stage, res, slides.length, 'slides'); toast('Video recorded', 'ok');
  });
  box.append(el('div', { class: 'stage-actions', style: 'align-items:flex-end' }, field('Voice', voiceSel), button({ label: m.audios ? 'Re-synthesize narration' : '1 · Synthesize narration', icon: 'mic', variant: m.audios ? '' : 'primary', disabled: !!ctx.busy, onClick: synth }), button({ label: m.video ? 'Re-record video' : '2 · Record video', icon: 'video', variant: m.audios && !m.video ? 'primary' : '', disabled: !!ctx.busy || !m.audios || !mime, onClick: record }), ctx.busy ? button({ label: 'Cancel', variant: 'danger', onClick: () => pipe.cancel() }) : null));
  box.append(progress); if (!mime) box.append(notice('warn', 'This browser cannot record WebM video. Use Chrome, Edge or Firefox.'));
  box.append(previewBox);
  if (m.video) { const v = el('video', { controls: true, class: 'video-player', preload: 'metadata' }); v.src = URL.createObjectURL(m.video.blob); previewBox.append(v); }
  else if (m.audios) setTimeout(() => mountPreview(previewBox, { slides, script, audios: m.audios, meta, theme }), 0);
  box.append(downloads(ctx, ch, m, script));
  return box;
}

// ---------------------------------------------------------------- option 2: animated lesson
function animatedVideo(ctx, ch, m) {
  const { store, pipe } = ctx; const p = store.project; const chId = ch.id;
  const stage = store.chapterStage(chId, 'video'); const inputs = pipe.chapterInputs(chId, 'video');
  const sb = storyboardOf(ch.stages.storyboard?.output); const deck = deckOf(ch.stages.slides?.output); const theme = resolveTheme(deck.theme, p.deck);
  const box = el('div', {});
  box.append(el('div', { class: 'stage-head' }, el('div', {}, el('h3', {}, 'Animated lesson'), el('p', { class: 'muted', style: 'font-size:var(--fs-2)' }, `Theme: ${theme.name} · characters ${store.settings.characters === false ? 'off' : 'on'} (Account → Generation defaults)`)), el('div', { class: 'meta-col' }, badge(stageStatus(pipe, stage, inputs)), stage.output && stage.mode === 'animated' ? el('small', {}, stage.output) : null)));
  if (!sb.scenes.length) { box.append(el('div', { style: 'margin-top:16px' }, empty({ icon: 'video', title: 'No storyboard yet', body: 'Plan the scenes first; you can edit every scene, its narration and visual before recording.', actions: [button({ label: 'Open Storyboard', variant: 'primary', onClick: () => go('p', p.id, 'videos', chId, 'storyboard') })] }))); return box; }
  const script = sb.scenes.map((s, i) => ({ slide_id: i + 1, title: s.title, narration: s.narration }));
  loadMedia(ctx, ch, m, 'scene_audios', 'anim_video', script, 'images');
  const voiceSel = select(VOICES, m.voice || store.settings.voice); voiceSel.onchange = () => { m.voice = voiceSel.value; };
  const illu = sb.scenes.filter(s => s.beat === 'illustration'); const missingIllu = illu.filter(s => !(m.images || {})[s.id]);
  const progress = el('p', { class: 'meta', style: 'margin:8px 0' }, `${sb.scenes.length} scenes · about ${Math.round(sb.scenes.reduce((a, s) => a + (s.target_seconds || 0), 0) / 60)} min · ${illu.length} illustration scene${illu.length === 1 ? '' : 's'}`);
  const previewBox = el('div', { style: 'margin:12px 0' }); const meta = { course: p.course.name, chapter: ch.title }; const mime = pickMime();
  const synth = () => ctx.guarded('Synthesizing narration', async () => {
    if (!ctx.requireKey()) return;
    m.scene_audios = await synthesize(pipe.client, store, script, { where: ch.title, voice: voiceSel.value, cache: m.cache ||= new Map(), onProgress: e => { progress.textContent = e.text; } });
    await store.putMedia(chId, 'scene_audios', m.scene_audios.map(a => ({ slide_id: a.slide_id, buffer: a.buffer, seconds: a.seconds })));
    const secs = m.scene_audios.reduce((a, x) => a + (x.seconds || 0), 0);
    store.applyResult(stage, `${ch.title} / Lecture video`, { output: `Scene narration ready: ${m.scene_audios.length} clips, ${Math.round(secs)} s (voice ${voiceSel.value}). Video not recorded yet.`, usage: null, durationMs: 0, transcript: [], inputHash: pipe.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, ch.title, { narrationSeconds: secs, voice: voiceSel.value, mode: 'animated' });
    toast('Narration ready', 'ok');
  });
  const genImages = () => ctx.guarded('Generating illustrations', async () => {
    if (!ctx.requireKey()) return; m.images ||= {};
    for (const s of missingIllu) {
      progress.textContent = `Illustration for “${s.title}”…`;
      const entry = store.log({ type: 'image_call', where: ch.title, stage: 'Lecture video', scene: s.id, model: 'gpt-image-1', status: 'running', chars: (s.visual.prompt || '').length });
      try { const prompt = `Clean educational illustration for a lecture slide, flat vector style, generous whitespace, soft palette based on #${theme.primary} and #${theme.accent}, no text except these short labels: ${(s.visual.labels || []).join(', ') || 'none'}. ${s.visual.prompt}`; const url = await pipe.client.image(prompt, { quality: store.settings.imageQuality || 'low' }); m.images[s.id] = url; entry.status = 'ok'; }
      catch (e) { entry.status = 'error'; entry.error = String(e.message || e); store.save(); throw e; }
      store.save();
    }
    await store.putMedia(chId, 'images', m.images); toast('Illustrations ready', 'ok');
  });
  const record = () => ctx.guarded('Recording animated lesson', async () => {
    const ctrl = new AbortController(); pipe.abort = ctrl; progress.textContent = 'Recording. Keep this tab visible until it finishes.';
    const assets = await loadSceneAssets({ characters: store.settings.characters !== false, images: m.images || {} });
    const res = await recordAnimated({ scenes: sb.scenes, audios: m.scene_audios, theme, meta, assets, signal: ctrl.signal, onProgress: e => { progress.textContent = e.text; } });
    m.vtt = buildVtt(script, m.scene_audios); await finishRecording(ctx, ch, m, stage, res, sb.scenes.length, 'animated'); toast('Animated lesson recorded', 'ok');
  });
  box.append(el('div', { class: 'stage-actions', style: 'align-items:flex-end' }, field('Voice', voiceSel),
    button({ label: m.scene_audios ? 'Re-synthesize narration' : '1 · Synthesize narration', icon: 'mic', variant: m.scene_audios ? '' : 'primary', disabled: !!ctx.busy, onClick: synth }),
    illu.length ? button({ label: missingIllu.length ? `2 · Generate ${missingIllu.length} illustration${missingIllu.length === 1 ? '' : 's'}` : 'Illustrations ready', icon: 'image', variant: m.scene_audios && missingIllu.length ? 'primary' : '', disabled: !!ctx.busy || !missingIllu.length, onClick: genImages }) : null,
    button({ label: m.video ? 'Re-record video' : `${illu.length ? 3 : 2} · Record video`, icon: 'video', variant: m.scene_audios && !m.video ? 'primary' : '', disabled: !!ctx.busy || !m.scene_audios || !mime, onClick: record }),
    ctx.busy ? button({ label: 'Cancel', variant: 'danger', onClick: () => pipe.cancel() }) : null));
  box.append(progress);
  if (illu.length && missingIllu.length) box.append(notice('info', `Illustration scenes use the OpenAI image API (about $0.01–0.02 each at low quality). Without illustrations those scenes fall back to their labels as bullets.`));
  if (!mime) box.append(notice('warn', 'This browser cannot record WebM video. Use Chrome, Edge or Firefox.'));
  box.append(previewBox);
  if (m.video) { const v = el('video', { controls: true, class: 'video-player', preload: 'metadata' }); v.src = URL.createObjectURL(m.video.blob); previewBox.append(v); }
  else setTimeout(async () => { const assets = await loadSceneAssets({ characters: store.settings.characters !== false, images: m.images || {} }); mountAnimatedPreview(previewBox, { scenes: sb.scenes, audios: m.scene_audios, theme, meta, assets }); }, 0);
  box.append(downloads(ctx, ch, m, script, 'scene_audios'));
  box.append(el('details', { class: 'turn', style: 'margin-top:20px' }, el('summary', {}, icon('chevron-right', 'sm chev'), 'How the animated lesson is made'), el('div', { class: 'turn-body' }, el('ol', { style: 'margin:0;padding-left:18px;font-size:var(--fs-2);color:var(--text-2);line-height:1.7' },
    el('li', {}, 'The Lesson Director agent (EduCast’s main agent, adapted) splits the chapter into scenes with narration, lecture lines, animation steps, a takeaway and one visual beat each. You can edit everything in the Storyboard tab.'),
    el('li', {}, 'Each scene is drawn on the EduCast teaching board: title band, lecture column that lights up as the narration advances, the visual building step by step (bullets, formula card, compare, steps, stat counters, diagram, chart, illustration), a takeaway strip, characters and a progress bar.'),
    el('li', {}, 'Narration is synthesized per scene; frames are drawn in sync with the audio clock and captured with MediaRecorder into WebM. Every TTS and image call is in the audit trail.')))));
  return box;
}

// ---------------------------------------------------------------- shared helpers
function loadMedia(ctx, ch, m, audioKey, videoKey, script, imagesKey) {
  const { store } = ctx; const flag = `loaded_${audioKey}`; if (m[flag]) return; m[flag] = true;
  (async () => {
    let changed = false;
    const saved = await store.getMedia(ch.id, audioKey); if (saved?.length && !m[audioKey]) { const actx = getAudioContext(); m[audioKey] = []; for (const a of saved) m[audioKey].push(a.buffer ? { ...a, decoded: await actx.decodeAudioData(a.buffer.slice(0)) } : a); m.vtt = buildVtt(script, m[audioKey]); changed = true; }
    const vid = await store.getMedia(ch.id, videoKey); if (vid?.blob && !m.video) { m.video = vid; changed = true; }
    if (imagesKey) { const im = await store.getMedia(ch.id, imagesKey); if (im && !m.images) { m.images = im; changed = true; } }
    if (changed) ctx.render();
  })();
}
async function finishRecording(ctx, ch, m, stage, res, count, mode) {
  const { store } = ctx;
  m.video = { blob: res.blob, mime: res.mime, seconds: res.seconds, timeline: res.timeline };
  await store.putMedia(ch.id, mode === 'animated' ? 'anim_video' : 'video', m.video);
  store.log({ type: 'video', where: ch.title, mode, seconds: res.seconds, bytes: res.blob.size, mime: res.mime, scenes: count });
  stage.output = `${mode === 'animated' ? 'Animated lesson' : 'Video'} recorded: ${Math.round(res.seconds)} s, ${fmtBytes(res.blob.size)} (${res.mime}); ${count} ${mode === 'animated' ? 'scenes' : 'slides'}.`; stage.timeline = res.timeline; stage.mode = mode; store.save();
}
function downloads(ctx, ch, m, script, audioKey = 'audios') {
  return el('div', { class: 'btn-row' },
    m.video ? button({ label: 'Download video', icon: 'download', onClick: () => download(m.video.blob, `${slug(ch.title)}_lecture.${m.video.mime.includes('mp4') ? 'mp4' : 'webm'}`) }) : null,
    m.vtt ? button({ label: 'Captions (.vtt)', icon: 'download', onClick: () => download(textBlob(m.vtt, 'text/vtt'), `${slug(ch.title)}_captions.vtt`) }) : null,
    m[audioKey] ? button({ label: 'Narration MP3s', icon: 'download', onClick: async () => { const JSZip = await loadJSZip(); const z = new JSZip(); m[audioKey].forEach((a, i) => a?.buffer && z.file(`part_${String(i + 1).padStart(2, '0')}.mp3`, a.buffer)); download(await z.generateAsync({ type: 'blob' }), `${slug(ch.title)}_narration.zip`); } }) : null,
    button({ label: 'Script', icon: 'download', variant: 'ghost', onClick: () => download(textBlob(scriptMarkdown(ch, script), 'text/markdown'), `${slug(ch.title)}_script.md`) }));
}
