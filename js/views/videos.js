// views/videos.js — narration + in-browser recording per chapter; media persisted in IndexedDB.
import { el, button, badge, field, select, notice, empty, icon, toast, fmtBytes } from '../ui.js';
import { chapterRail, noChapters } from './chapters.js';
import { stageStatus } from './stage.js';
import { safeJson } from '../pipeline.js';
import { deckOf, resolveTheme } from '../deck.js';
import { synthesize, recordVideo, buildVtt, mountPreview, pickMime, getAudioContext } from '../video.js';
import { download, textBlob, slug, scriptMarkdown, loadJSZip } from '../export.js';
import { sha1Short } from '../llm.js';
import { go } from '../router.js';

export function render(ctx) {
  const { store, pipe } = ctx; const p = store.project;
  if (!p.chapters.length) return noChapters(ctx, 'Lecture videos');
  const chId = store.chapter(ctx.route.a) ? ctx.route.a : p.chapters[0].id;
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Lecture videos'), el('p', {}, 'Narration is synthesized per slide with the TTS model, the deck is drawn on a canvas and recorded in this tab. Audio and video are kept in this browser so you can come back to them.'))));
  const main = el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' });
  main.append(videoView(ctx, chId));
  page.append(el('div', { class: 'two-pane' }, chapterRail(ctx, 'videos', ['video'], chId), main));
  return page;
}

function videoView(ctx, chId) {
  const { store, pipe } = ctx; const p = store.project; const ch = store.chapter(chId); const idx = p.chapters.indexOf(ch);
  const stage = store.chapterStage(chId, 'video'); const inputs = pipe.chapterInputs(chId, 'video');
  const deck = deckOf(ch.stages.slides?.output); const scriptRaw = safeJson(ch.stages.script?.output, null);
  const slides = deck.slides.length ? deck.slides : null; const script = Array.isArray(scriptRaw) && scriptRaw.length ? scriptRaw : null;
  const theme = resolveTheme(deck.theme, p.deck);
  const m = ctx.media[chId] ||= { audios: null, video: null, vtt: null, cache: new Map(), loaded: false };
  const box = el('div', {});
  box.append(el('div', { class: 'stage-head' }, el('div', {}, el('span', { class: 'meta' }, `Chapter ${idx + 1} of ${p.chapters.length}`), el('h2', { style: 'margin-top:2px' }, ch.title)), el('div', { class: 'meta-col' }, badge(stageStatus(pipe, stage, inputs)), stage.output ? el('small', {}, stage.output) : null)));
  if (!slides || !script) { box.append(el('div', { style: 'margin-top:16px' }, empty({ icon: 'presentation', title: 'Slides and script needed first', body: 'The video reads the slide deck and the lecture script of this chapter.', actions: [button({ label: 'Open Slides', variant: 'primary', onClick: () => go('p', p.id, 'slides', chId) })] }))); return box; }
  if (slides.length !== script.length) box.append(el('div', { style: 'margin-top:12px' }, notice('warn', `The script has ${script.length} entries but the deck has ${slides.length} slides. Re-run the script after editing slides.`)));

  // lazy-load persisted media once per view
  if (!m.loaded) { m.loaded = true; (async () => { const saved = await store.getMedia(chId, 'audios'); if (saved?.length && !m.audios) { const actx = getAudioContext(); m.audios = []; for (const a of saved) m.audios.push(a.buffer ? { ...a, decoded: await actx.decodeAudioData(a.buffer.slice(0)) } : a); m.vtt = buildVtt(script, m.audios); } const vid = await store.getMedia(chId, 'video'); if (vid?.blob && !m.video) m.video = vid; if (saved || vid) ctx.render(); })(); }

  const voiceSel = select(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'], m.voice || store.settings.voice); voiceSel.onchange = () => { m.voice = voiceSel.value; };
  const progress = el('p', { class: 'meta', style: 'margin:8px 0' }, `${slides.length} slides · ${script.reduce((a, s) => a + (s.narration || '').length, 0).toLocaleString()} narration characters`);
  const previewBox = el('div', { style: 'margin:12px 0' }); const meta = { course: p.course.name, chapter: ch.title }; const mime = pickMime();

  const synth = () => ctx.guarded('Synthesizing narration', async () => {
    if (!ctx.requireKey()) return;
    m.audios = await synthesize(pipe.client, store, script, { where: ch.title, voice: voiceSel.value, cache: m.cache, onProgress: e => { progress.textContent = e.text; } });
    m.vtt = buildVtt(script, m.audios);
    await store.putMedia(chId, 'audios', m.audios.map(a => ({ slide_id: a.slide_id, buffer: a.buffer, seconds: a.seconds })));
    const secs = m.audios.reduce((a, x) => a + (x.seconds || 0), 0);
    store.applyResult(stage, `${ch.title} / Lecture video`, { output: `Narration ready: ${m.audios.length} clips, ${Math.round(secs)} s (voice ${voiceSel.value}). Video not recorded yet.`, usage: null, durationMs: 0, transcript: [], inputHash: pipe.inputHash(inputs), provenance: inputs.map(i => ({ label: i.label, hash: sha1Short(i.text), version: i.version })) }, ch.title, { narrationSeconds: secs, voice: voiceSel.value });
    toast('Narration ready. Preview it, then record.', 'ok');
  });
  const record = () => ctx.guarded('Recording video', async () => {
    const ctrl = new AbortController(); pipe.abort = ctrl; progress.textContent = 'Recording. Keep this tab visible until it finishes.';
    const res = await recordVideo({ slides, script, audios: m.audios, meta, theme, signal: ctrl.signal, onProgress: e => { progress.textContent = e.text; } });
    m.video = { blob: res.blob, mime: res.mime, seconds: res.seconds, timeline: res.timeline };
    await store.putMedia(chId, 'video', m.video);
    store.log({ type: 'video', where: ch.title, seconds: res.seconds, bytes: res.blob.size, mime: res.mime, slides: slides.length });
    stage.output = `Video recorded: ${Math.round(res.seconds)} s, ${fmtBytes(res.blob.size)} (${res.mime}); ${m.audios.length} narration clips.`; stage.timeline = res.timeline; store.save();
    toast('Video recorded', 'ok');
  });

  box.append(el('div', { class: 'stage-actions', style: 'align-items:flex-end' }, field('Voice', voiceSel), el('span', { class: 'meta', style: 'align-self:center' }, `Deck theme: ${theme.name}`),
    button({ label: m.audios ? 'Re-synthesize narration' : '1 · Synthesize narration', icon: 'mic', variant: m.audios ? '' : 'primary', disabled: !!ctx.busy, onClick: synth }),
    button({ label: m.video ? 'Re-record video' : '2 · Record video', icon: 'video', variant: m.audios && !m.video ? 'primary' : '', disabled: !!ctx.busy || !m.audios || !mime, onClick: record }),
    ctx.busy ? button({ label: 'Cancel', variant: 'danger', onClick: () => pipe.cancel() }) : null));
  box.append(progress);
  if (!mime) box.append(notice('warn', 'This browser cannot record WebM video. Use Chrome, Edge or Firefox; narration MP3s and the HTML deck still work.'));
  box.append(previewBox);
  if (m.video) { const v = el('video', { controls: true, class: 'video-player', preload: 'metadata' }); v.src = URL.createObjectURL(m.video.blob); previewBox.append(v); }
  else if (m.audios) setTimeout(() => mountPreview(previewBox, { slides, script, audios: m.audios, meta, theme: themeSel.value }), 0);
  box.append(el('div', { class: 'btn-row' },
    m.video ? button({ label: 'Download video', icon: 'download', onClick: () => download(m.video.blob, `${slug(ch.title)}_lecture.${m.video.mime.includes('mp4') ? 'mp4' : 'webm'}`) }) : null,
    m.vtt ? button({ label: 'Captions (.vtt)', icon: 'download', onClick: () => download(textBlob(m.vtt, 'text/vtt'), `${slug(ch.title)}_captions.vtt`) }) : null,
    m.audios ? button({ label: 'Narration MP3s', icon: 'download', onClick: async () => { const JSZip = await loadJSZip(); const z = new JSZip(); m.audios.forEach((a, i) => a?.buffer && z.file(`slide_${String(i + 1).padStart(2, '0')}.mp3`, a.buffer)); download(await z.generateAsync({ type: 'blob' }), `${slug(ch.title)}_narration.zip`); } }) : null,
    button({ label: 'Script', icon: 'download', variant: 'ghost', onClick: () => download(textBlob(scriptMarkdown(ch, script), 'text/markdown'), `${slug(ch.title)}_script.md`) })));
  box.append(el('details', { class: 'turn', style: 'margin-top:20px' }, el('summary', {}, icon('chevron-right', 'sm chev'), 'How the video is made'), el('div', { class: 'turn-body' }, el('ol', { style: 'margin:0;padding-left:18px;font-size:var(--fs-2);color:var(--text-2);line-height:1.7' },
    el('li', {}, `Each narration block is sent to ${store.settings.ttsModel}; every call is logged with slide number, characters and duration.`),
    el('li', {}, 'Slides are drawn from the same deck specification and theme as the PowerPoint export, so the video matches the .pptx.'),
    el('li', {}, 'Canvas and decoded audio are captured with the MediaRecorder API into WebM; captions are timed proportionally to sentence length.'),
    el('li', {}, 'For an MP4 rendered server-side, download the .pptx and script and use the Python pipeline with --video.')))));
  return box;
}
