// views/videos.js — Lecture videos: (1) narrated slides, (2) animated lesson (EduCast-style storyboard → review → MP4 → interactive lesson player).
import { el, button, badge, field, select, notice, empty, icon, toast, fmtBytes, tabs } from '../ui.js';
import { chapterRail, noChapters } from './chapters.js';
import { stageDetail, stageStatus } from './stage.js';
import { safeJson } from '../pipeline.js';
import { deckOf, resolveTheme } from '../deck.js';
import { storyboardOf, loadSceneAssets } from '../scenes.js';
import { synthesize, buildVtt, mountPreview, mountAnimatedPreview, getAudioContext, renderAnimated, renderSlides } from '../video.js';
import { buildManifest, buildLessonZip, standaloneHtml, mountPlayerPreview } from '../player.js';
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
  const tab = ['storyboard', 'player'].includes(ctx.route.b) ? ctx.route.b : 'video';
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Lecture videos'), el('p', {}, 'Two ways to make a lecture video for each chapter. Narration, storyboards, videos and the interactive lesson bundle are produced in this browser and kept here.'))));
  const main = el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' });
  main.append(el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:12px' }, el('div', {}, el('span', { class: 'meta' }, `Chapter ${idx + 1} of ${p.chapters.length}`), el('h2', { style: 'margin-top:2px' }, ch.title)),
    el('div', { class: 'btn-row' }, button({ icon: 'arrow-left', size: 'sm', variant: 'ghost', title: 'Previous chapter', disabled: idx === 0, onClick: () => go('p', p.id, 'videos', p.chapters[idx - 1].id, tab) }), button({ icon: 'arrow-right', size: 'sm', variant: 'ghost', title: 'Next chapter', disabled: idx >= p.chapters.length - 1, onClick: () => go('p', p.id, 'videos', p.chapters[idx + 1].id, tab) }))));
  main.append(el('div', { class: 'mode-cards' },
    el('button', { class: 'mode-card', 'aria-pressed': String(mode === 'slides'), onClick: () => { m.mode = 'slides'; ctx.render(); } }, el('b', {}, 'Option 1 · Narrated slides'), el('small', {}, 'Each PowerPoint slide is shown while its lecture-script narration plays. Quick, faithful to the deck. Exports an MP4.')),
    el('button', { class: 'mode-card', 'aria-pressed': String(mode === 'animated'), onClick: () => { m.mode = 'animated'; ctx.render(); } }, el('b', {}, 'Option 2 · Animated lesson (EduCast)'), el('small', {}, 'A Lesson Director plans 6–8 teaching scenes (lecture lines light up as spoken; diagrams, charts, formulas and steps build step by step; one interactive practice check). An independent vision model reviews every scene. Exports an MP4 and an interactive lesson player.'))));
  if (mode === 'animated') {
    main.append(tabs([['storyboard', 'Storyboard'], ['video', 'Video'], ['player', 'Lesson player']], tab, k => go('p', p.id, 'videos', chId, k)));
    const body = el('div', { class: 'tab-body' });
    body.append(tab === 'storyboard' ? storyboardStage(ctx, ch) : tab === 'player' ? playerTab(ctx, ch, m) : animatedVideo(ctx, ch, m));
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

// ---------------------------------------------------------------- shared: step rows
function stepRow(n, done, title, sub, ...actions) {
  return el('div', { class: `step-row${done ? ' done' : ''}` }, el('span', { class: 'num' }, done ? icon('check', 'sm') : String(n)), el('div', {}, el('b', {}, title), sub ? el('small', {}, sub) : null), el('div', { class: 'btn-row' }, ...actions));
}
const vext = v => v?.ext || ((v?.mime || '').includes('mp4') ? 'mp4' : 'webm');

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
  const previewBox = el('div', { style: 'margin:12px 0' }); const meta = { course: p.course.name, chapter: ch.title };
  const synth = () => ctx.guarded('Synthesizing narration', async () => {
    if (!ctx.requireKey()) return;
    m.audios = await synthesize(pipe.client, store, script, { where: ch.title, voice: voiceSel.value, cache: m.cache ||= new Map(), onProgress: e => { progress.textContent = e.text; } });
    m.vtt = buildVtt(script, m.audios); await store.putMedia(chId, 'audios', m.audios.map(a => ({ slide_id: a.slide_id, buffer: a.buffer, seconds: a.seconds })));
    const secs = m.audios.reduce((a, x) => a + (x.seconds || 0), 0);
    store.applyResult(stage, `${ch.title} / Lecture video`, { output: `Narration ready: ${m.audios.length} clips, ${Math.round(secs)} s (voice ${voiceSel.value}). Video not rendered yet.`, usage: null, durationMs: 0, transcript: [], inputHash: pipe.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, ch.title, { narrationSeconds: secs, voice: voiceSel.value, mode: 'slides' });
    toast('Narration ready. Preview it, then render.', 'ok');
  });
  const renderIt = () => ctx.guarded('Rendering video', async () => {
    const ctrl = new AbortController(); pipe.abort = ctrl; progress.textContent = 'Rendering…';
    const res = await renderSlides({ slides, script, audios: m.audios, meta, theme, res: store.settings.videoRes || '1080p', signal: ctrl.signal, onProgress: e => { progress.textContent = e.text || ''; } });
    m.vtt = buildVtt(script, m.audios);
    await finishRecording(ctx, ch, m, stage, res, slides.length, 'slides'); toast('Video rendered', 'ok');
  });
  box.append(el('div', { class: 'step-list' },
    stepRow(1, !!m.audios, 'Synthesize narration', `${script.length} clips with the TTS model · voice`, field('Voice', voiceSel), button({ label: m.audios ? 'Re-synthesize' : 'Synthesize', icon: 'mic', variant: m.audios ? '' : 'primary', disabled: !!ctx.busy, onClick: synth })),
    stepRow(2, !!m.video, 'Render MP4', `Frame-accurate encoding in this browser (${store.settings.videoRes || '1080p'}); each slide is held while its narration plays.`, button({ label: m.video ? 'Re-render' : 'Render video', icon: 'video', variant: m.audios && !m.video ? 'primary' : '', disabled: !!ctx.busy || !m.audios, onClick: renderIt }), ctx.busy ? button({ label: 'Cancel', variant: 'danger', onClick: () => pipe.cancel() }) : null)));
  box.append(progress);
  box.append(previewBox);
  if (m.video) { previewBox.append(videoEl(m.video)); const cn = codecNotice(m.video); if (cn) previewBox.append(cn); }
  else if (m.audios) setTimeout(() => mountPreview(previewBox, { slides, script, audios: m.audios, meta, theme }), 0);
  box.append(downloads(ctx, ch, m, script, 'audios', 'video'));
  return box;
}

// ---------------------------------------------------------------- option 2: animated lesson
function animatedVideo(ctx, ch, m) {
  const { store, pipe } = ctx; const p = store.project; const chId = ch.id;
  const stage = store.chapterStage(chId, 'video'); const inputs = pipe.chapterInputs(chId, 'video'); const sbStage = store.chapterStage(chId, 'storyboard');
  const sb = storyboardOf(ch.stages.storyboard?.output); const deck = deckOf(ch.stages.slides?.output); const theme = resolveTheme(deck.theme, p.deck);
  const box = el('div', {});
  box.append(el('div', { class: 'stage-head' }, el('div', {}, el('h3', {}, 'Animated lesson'), el('p', { class: 'muted', style: 'font-size:var(--fs-2)' }, `Theme: ${theme.name} · characters ${store.settings.characters === false ? 'off' : 'on'} · ${store.settings.videoRes || '1080p'} (Account → Generation defaults)`)), el('div', { class: 'meta-col' }, badge(stageStatus(pipe, stage, inputs)), stage.output && stage.mode === 'animated' ? el('small', {}, stage.output) : null)));
  if (!sb.scenes.length) { box.append(el('div', { style: 'margin-top:16px' }, empty({ icon: 'video', title: 'No storyboard yet', body: 'Plan the scenes first; you can edit every scene, its narration and visual before rendering.', actions: [button({ label: 'Open Storyboard', variant: 'primary', onClick: () => go('p', p.id, 'videos', chId, 'storyboard') })] }))); return box; }
  const script = sb.scenes.map((s, i) => ({ slide_id: i + 1, title: s.title, narration: s.narration }));
  loadMedia(ctx, ch, m, 'scene_audios', 'anim_video', script, 'images');
  const voiceSel = select(VOICES, m.voice || store.settings.voice); voiceSel.onchange = () => { m.voice = voiceSel.value; };
  const illu = sb.scenes.filter(s => s.beat === 'illustration'); const missingIllu = illu.filter(s => !(m.images || {})[s.id]);
  const practice = sb.scenes.filter(s => s.beat === 'practice');
  const progress = el('p', { class: 'meta', style: 'margin:8px 0' }, `${sb.scenes.length} scenes · about ${Math.round(sb.scenes.reduce((a, s) => a + (s.target_seconds || 0), 0) / 60)} min · ${illu.length} illustration scene${illu.length === 1 ? '' : 's'} · ${practice.length} practice scene${practice.length === 1 ? '' : 's'}`);
  const previewBox = el('div', { style: 'margin:12px 0' }); const meta = { course: p.course.name, chapter: ch.title };
  const assetsFor = () => loadSceneAssets({ characters: store.settings.characters !== false, images: m.images || {} });
  const synth = () => ctx.guarded('Synthesizing narration', async () => {
    if (!ctx.requireKey()) return;
    m.scene_audios = await synthesize(pipe.client, store, script, { where: ch.title, voice: voiceSel.value, cache: m.cache ||= new Map(), onProgress: e => { progress.textContent = e.text; } });
    await store.putMedia(chId, 'scene_audios', m.scene_audios.map(a => ({ slide_id: a.slide_id, buffer: a.buffer, seconds: a.seconds })));
    const secs = m.scene_audios.reduce((a, x) => a + (x.seconds || 0), 0);
    store.applyResult(stage, `${ch.title} / Lecture video`, { output: `Scene narration ready: ${m.scene_audios.length} clips, ${Math.round(secs)} s (voice ${voiceSel.value}). Video not rendered yet.`, usage: null, durationMs: 0, transcript: [], inputHash: pipe.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, ch.title, { narrationSeconds: secs, voice: voiceSel.value, mode: 'animated' });
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
  const reviewIt = () => ctx.guarded('Visual review', async () => {
    if (!ctx.requireKey()) return;
    const assets = await assetsFor(); const r = await pipe.reviewStoryboard(chId, { assets, onProgress: e => { progress.textContent = e.text; } });
    toast(`Visual review: ${r.summary}`, Object.values(r.scenes).every(v => v.passed) ? 'ok' : '');
  });
  const renderIt = () => ctx.guarded('Rendering animated lesson', async () => {
    const ctrl = new AbortController(); pipe.abort = ctrl; progress.textContent = 'Rendering…';
    const assets = await assetsFor();
    const res = await renderAnimated({ scenes: sb.scenes, audios: m.scene_audios, theme, meta, assets, res: store.settings.videoRes || '1080p', signal: ctrl.signal, onProgress: e => { progress.textContent = e.text || ''; } });
    m.vtt = buildVtt(sb.scenes, m.scene_audios, { pad: 0.6 });
    await finishRecording(ctx, ch, m, stage, res, sb.scenes.length, 'animated');
    await buildLesson(ctx, ch, m, sb, theme); toast(res.method === 'mediarecorder' ? 'Recorded (WebM fallback: WebCodecs unavailable in this browser)' : 'Animated lesson rendered', 'ok');
  });
  const rv = sbStage.reviews; const rvPassed = rv ? Object.values(rv.scenes).filter(v => v.passed).length : 0; const rvTotal = rv ? Object.keys(rv.scenes).length : 0;
  let n = 0;
  box.append(el('div', { class: 'step-list' },
    stepRow(++n, !!m.scene_audios, 'Synthesize narration', `${sb.scenes.length} scene clips with the TTS model`, field('Voice', voiceSel), button({ label: m.scene_audios ? 'Re-synthesize' : 'Synthesize', icon: 'mic', variant: m.scene_audios ? '' : 'primary', disabled: !!ctx.busy, onClick: synth })),
    illu.length ? stepRow(++n, !missingIllu.length, 'Generate illustrations', `${illu.length} illustration scene${illu.length === 1 ? '' : 's'} via the image API (about $0.01–0.02 each at low quality)`, button({ label: missingIllu.length ? `Generate ${missingIllu.length}` : 'Ready', icon: 'image', variant: m.scene_audios && missingIllu.length ? 'primary' : '', disabled: !!ctx.busy || !missingIllu.length, onClick: genImages })) : null,
    stepRow(++n, !!rv && rvPassed === rvTotal && rvTotal > 0, 'Visual review (optional)', rv ? `${rv.summary || `${rvPassed}/${rvTotal} passed`} · model ${rv.model}` : `An independent vision model checks rendered frames of every scene (key elements visible, nothing clipped or overlapping) and repairs failures, up to ${store.settings.reviewRounds ?? 2} round(s).`, button({ label: rv ? 'Review again' : 'Run visual review', icon: 'search', disabled: !!ctx.busy, onClick: reviewIt }), rv ? button({ label: 'Details', variant: 'ghost', size: 'sm', onClick: () => go('p', p.id, 'videos', chId, 'storyboard') }) : null),
    stepRow(++n, !!m.anim_video, 'Render MP4', `Frame-accurate encoding in this browser (${store.settings.videoRes || '1080p'}, H.264/AAC). Practice scenes appear as “Your turn” cards; the lesson player pauses there for the real exercise.`, button({ label: m.anim_video ? 'Re-render' : 'Render video', icon: 'video', variant: m.scene_audios && !m.anim_video ? 'primary' : '', disabled: !!ctx.busy || !m.scene_audios, onClick: renderIt }), ctx.busy ? button({ label: 'Cancel', variant: 'danger', onClick: () => pipe.cancel() }) : null)));
  box.append(progress);
  if (rv && rvPassed < rvTotal) box.append(notice('warn', `${rvTotal - rvPassed} scene${rvTotal - rvPassed === 1 ? '' : 's'} did not pass the visual review. Open the Storyboard tab to see the verdicts, apply the suggested fixes or re-plan those scenes, then render.`));
  box.append(previewBox);
  if (m.anim_video) { previewBox.append(videoEl(m.anim_video)); const cn = codecNotice(m.anim_video); if (cn) previewBox.append(cn); }
  else setTimeout(async () => { const assets = await assetsFor(); mountAnimatedPreview(previewBox, { scenes: sb.scenes, audios: m.scene_audios, theme, meta, assets }); }, 0);
  box.append(downloads(ctx, ch, m, script, 'scene_audios', 'anim_video', ch));
  if (m.anim_video) box.append(el('p', { class: 'meta', style: 'margin-top:8px' }, 'The interactive version (video + practice checks + captions) is in the Lesson player tab.'));
  box.append(el('details', { class: 'turn', style: 'margin-top:20px' }, el('summary', {}, icon('chevron-right', 'sm chev'), 'How the animated lesson is made'), el('div', { class: 'turn-body' }, el('ol', { style: 'margin:0;padding-left:18px;font-size:var(--fs-2);color:var(--text-2);line-height:1.7' },
    el('li', {}, 'The Lesson Director agent (EduCast’s main agent, adapted) splits the chapter into scenes with narration, lecture lines, animation steps, a takeaway and one visual beat each, including one interactive practice check. Everything is editable in the Storyboard tab.'),
    el('li', {}, 'Each scene is drawn on the EduCast teaching board: title band, lecture column that lights up as the narration advances, the visual building step by step, a takeaway strip, characters and a progress bar.'),
    el('li', {}, 'The visual reviewer (EduCast’s independent VLM auditor) looks at sampled frames of every scene against its key elements plus deterministic layout guards; failed scenes are patched with structured edits or re-planned, then re-reviewed. Every call and repair is in the audit trail.'),
    el('li', {}, 'Narration is synthesized per scene; the video is encoded frame by frame with WebCodecs into MP4 (H.264/AAC) so playback is smooth and the file opens everywhere. The lesson player bundles the video with the practice checks (EduCast’s trusted runtime) and captions.')))));
  return box;
}

// ---------------------------------------------------------------- lesson player tab
function playerTab(ctx, ch, m) {
  const { store } = ctx; const p = store.project; const sb = storyboardOf(ch.stages.storyboard?.output); const deck = deckOf(ch.stages.slides?.output); const theme = resolveTheme(deck.theme, p.deck);
  const script = sb.scenes.map((s, i) => ({ slide_id: i + 1, title: s.title, narration: s.narration }));
  loadMedia(ctx, ch, m, 'scene_audios', 'anim_video', script, 'images');
  const box = el('div', {});
  if (!m.anim_video) { box.append(empty({ icon: 'video', title: 'Render the animated lesson first', body: 'The lesson player wraps the rendered video with the interactive practice checks and captions.', actions: [button({ label: 'Open Video', variant: 'primary', onClick: () => go('p', p.id, 'videos', ch.id, 'video') })] })); return box; }
  const practice = sb.scenes.filter(s => s.beat === 'practice');
  box.append(el('div', { class: 'stage-head' }, el('div', {}, el('h3', {}, 'Interactive lesson player'), el('p', { class: 'muted', style: 'font-size:var(--fs-2)' }, `${sb.scenes.length} chapters · ${practice.length} practice check${practice.length === 1 ? '' : 's'} · captions · resume · event log. Built like EduCast’s bundle: open index.html anywhere, no server needed.`))));
  const frame = el('div', { class: 'player-frame', style: 'margin:12px 0' });
  const status = el('span', { class: 'meta' });
  const actions = el('div', { class: 'btn-row' },
    button({ label: 'Export lesson (ZIP)', icon: 'download', variant: 'primary', onClick: () => ctx.guarded('Building lesson ZIP', async () => { const L = await buildLesson(ctx, ch, m, sb, theme); const blob = await buildLessonZip({ manifest: L.manifest, files: L.files }); download(blob, `${slug(ch.title)}_lesson.zip`); store.log({ type: 'export', stage: `${ch.title} / Lesson player`, file: 'lesson.zip', bytes: blob.size }); }) }),
    button({ label: 'Standalone HTML', icon: 'download', onClick: () => ctx.guarded('Building standalone lesson', async () => { const L = await buildLesson(ctx, ch, m, sb, theme); const blob = await standaloneHtml({ manifest: L.manifest, files: L.files }); download(blob, `${slug(ch.title)}_lesson.html`); store.log({ type: 'export', stage: `${ch.title} / Lesson player`, file: 'lesson.html', bytes: blob.size }); }) }),
    button({ label: 'Rebuild preview', icon: 'refresh', variant: 'ghost', size: 'sm', onClick: () => { delete m.lesson; ctx.render(); } }),
    status);
  box.append(actions, frame);
  setTimeout(async () => {
    try { const L = await buildLesson(ctx, ch, m, sb, theme); m.player?.destroy?.(); m.player = mountPlayerPreview(frame, { manifest: L.manifest, files: L.files }); status.textContent = `${fmtBytes(m.anim_video.blob.size)} video · ${Object.keys(L.files).length} files`; }
    catch (e) { frame.append(notice('error', `The player preview could not be built: ${e.message}`)); }
  }, 0);
  box.append(el('p', { class: 'meta', style: 'margin-top:10px' }, 'Standalone HTML embeds the video as base64 (roughly one third larger than the MP4); the ZIP keeps files separate and is the better choice for an LMS or a web server.'));
  return box;
}

/** Assemble the lesson bundle (manifest + files) from the rendered video, storyboard and narration; cached on m.lesson and persisted for the project ZIP. */
async function buildLesson(ctx, ch, m, sb, theme) {
  if (m.lesson && m.lesson.videoHash === m.anim_video?.hash) return m.lesson;
  const { store } = ctx; const p = store.project; const v = m.anim_video; const ext = vext(v);
  const files = {}; files[`media/lesson.${ext}`] = v.blob;
  const vtt = m.vtt || buildVtt(sb.scenes, m.scene_audios || [], { pad: 0.6 }); files['media/captions.vtt'] = vtt;
  if (v.poster) { try { files['media/poster.jpg'] = await (await fetch(v.poster)).blob(); } catch { /* optional */ } }
  const tl = v.timeline || []; const scenes = sb.scenes.map((s, i) => { const t = tl[i] || tl.find(x => x.id === s.id) || {}; return { id: s.id, title: s.title, start: t.start ?? 0, end: t.end ?? 0, narration: s.narration, beat: s.beat }; });
  const practice = [];
  sb.scenes.forEach((s, i) => {
    if (s.beat !== 'practice') return; const t = scenes[i]; const a = m.scene_audios?.[i];
    let audio_src = null; if (a?.buffer) { audio_src = `media/practice-${slug(s.id)}.mp3`; files[audio_src] = new Blob([a.buffer], { type: 'audio/mpeg' }); }
    practice.push({ id: s.id, title: s.title, trigger_at: +Math.min(t.start + 0.6, Math.max(t.start, t.end - 0.2)).toFixed(2), template: s.visual.template, parameters: s.visual.parameters, instruction: s.visual.instruction || s.title, narration: s.narration, audio_src });
  });
  const manifest = buildManifest({ topic: ch.title, chapter: ch.title, course: p.course.name, theme, video: { src: `media/lesson.${ext}`, duration: v.seconds, poster: files['media/poster.jpg'] ? 'media/poster.jpg' : null }, scenes, practice, captions: 'media/captions.vtt' });
  m.lesson = { manifest, files, videoHash: v.hash };
  try { await store.putMedia(ch.id, 'lesson_bundle', { manifest, files: Object.fromEntries(Object.entries(files).filter(([k]) => !k.startsWith('media/lesson.'))), at: new Date().toISOString() }); } catch { /* optional */ }
  return m.lesson;
}

// ---------------------------------------------------------------- shared helpers
function codecNotice(v) {
  const m = String(v?.method || '');
  if (m.startsWith('webcodecs:') && !m.includes('avc')) return el('div', { style: 'margin-top:8px' }, notice('info', `Encoded as ${m.slice(10).replace('/', ' + ')} inside MP4 because this browser has no H.264/AAC encoder. It plays in Chrome, Edge and Firefox; for a file that PowerPoint, QuickTime or an LMS transcoder accepts everywhere, render in desktop Chrome or Edge (H.264 + AAC).`));
  if (m === 'mediarecorder') return el('div', { style: 'margin-top:8px' }, notice('info', 'Recorded in real time as WebM (this browser lacks WebCodecs). Chrome or Edge produce a frame-accurate MP4 instead.'));
  return null;
}
function videoEl(v) { const e = el('video', { controls: true, class: 'video-player', preload: 'metadata', playsinline: true }); if (v.poster) e.poster = v.poster; e.src = URL.createObjectURL(v.blob); return e; }
function loadMedia(ctx, ch, m, audioKey, videoKey, script, imagesKey) {
  const { store } = ctx; const flag = `loaded_${audioKey}`; if (m[flag]) return; m[flag] = true;
  (async () => {
    let changed = false;
    const saved = await store.getMedia(ch.id, audioKey); if (saved?.length && !m[audioKey]) { const actx = getAudioContext(); m[audioKey] = []; for (const a of saved) m[audioKey].push(a.buffer ? { ...a, decoded: await actx.decodeAudioData(a.buffer.slice(0)) } : a); changed = true; }
    const vid = await store.getMedia(ch.id, videoKey); if (vid?.blob && !m[videoKey]) { m[videoKey] = vid; changed = true; }
    if (imagesKey) { const im = await store.getMedia(ch.id, imagesKey); if (im && !m.images) { m.images = im; changed = true; } }
    if (changed) ctx.render();
  })();
}
async function finishRecording(ctx, ch, m, stage, res, count, mode) {
  const { store } = ctx; const key = mode === 'animated' ? 'anim_video' : 'video';
  m[key] = { blob: res.blob, mime: res.mime, ext: res.ext || vext(res), seconds: res.seconds, timeline: res.timeline, poster: res.poster || null, method: res.method, hash: `${Date.now().toString(36)}-${res.blob.size}` };
  await store.putMedia(ch.id, key, m[key]); delete m.lesson;
  store.log({ type: 'video', where: ch.title, mode, seconds: +res.seconds.toFixed(1), bytes: res.blob.size, mime: res.mime, method: res.method, scenes: count, resolution: store.settings.videoRes || '1080p' });
  stage.output = `${mode === 'animated' ? 'Animated lesson' : 'Video'} rendered: ${Math.round(res.seconds)} s, ${fmtBytes(res.blob.size)} (${res.mime}${res.method ? `, ${res.method}` : ''}); ${count} ${mode === 'animated' ? 'scenes' : 'slides'}.`; stage.timeline = res.timeline; stage.mode = mode; store.save();
}
function downloads(ctx, ch, m, script, audioKey = 'audios', videoKey = 'video') {
  const v = m[videoKey];
  return el('div', { class: 'btn-row' },
    v ? button({ label: `Download video (.${vext(v)})`, icon: 'download', onClick: () => { download(v.blob, `${slug(ch.title)}_${videoKey === 'anim_video' ? 'animated_lesson' : 'lecture'}.${vext(v)}`); ctx.store.log({ type: 'export', stage: `${ch.title} / Lecture video`, file: `video.${vext(v)}`, bytes: v.blob.size }); } }) : null,
    m.vtt ? button({ label: 'Captions (.vtt)', icon: 'download', onClick: () => download(textBlob(m.vtt, 'text/vtt'), `${slug(ch.title)}_captions.vtt`) }) : null,
    m[audioKey] ? button({ label: 'Narration MP3s', icon: 'download', onClick: async () => { const JSZip = await loadJSZip(); const z = new JSZip(); m[audioKey].forEach((a, i) => a?.buffer && z.file(`part_${String(i + 1).padStart(2, '0')}.mp3`, a.buffer)); download(await z.generateAsync({ type: 'blob' }), `${slug(ch.title)}_narration.zip`); } }) : null,
    button({ label: 'Script', icon: 'download', variant: 'ghost', onClick: () => download(textBlob(scriptMarkdown(ch, script), 'text/markdown'), `${slug(ch.title)}_script.md`) }));
}
