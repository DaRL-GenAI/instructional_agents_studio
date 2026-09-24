// video.js — narrated lecture video, produced entirely in the browser:
// TTS per slide (OpenAI /audio/speech) → canvas slides → MediaRecorder (WebM) + WebVTT captions.
import { drawSlideCanvas, resolveTheme } from './deck.js';
import { drawScene, W as SW, H as SH } from './scenes.js';
import { encoderSupport, encodeVideo, mixNarration, posterFrame } from './encode.js';
export const W = 1280, H = 720;

export const TTS_INSTRUCTIONS = 'Warm, clear teacher voice. Speak at a measured lecture pace, with natural emphasis on key terms.';

/** Synthesize narration for every slide. Returns [{slide_id, buffer(ArrayBuffer), seconds}]. */
export async function synthesize(client, store, script, { where, voice, onProgress, cache = new Map() } = {}) {
  const out = [];
  const audioCtx = getAudioContext();
  for (let i = 0; i < script.length; i++) {
    const s = script[i];
    const text = (s.narration || '').trim();
    if (!text) { out.push({ slide_id: s.slide_id, buffer: null, seconds: 3 }); continue; }
    const key = `${store.settings.ttsModel}|${voice}|${text}`;
    let item = cache.get(key);
    if (!item) {
      onProgress?.({ phase: 'tts', index: i, total: script.length, text: `Synthesizing narration for slide ${i + 1}…` });
      const entry = store.log({ type: 'tts_call', where, stage: 'Lecture video', model: store.settings.ttsModel, voice, slide: s.slide_id, chars: text.length, status: 'running' });
      const t0 = performance.now();
      try {
        const buffer = await client.speak(text, { voice, instructions: TTS_INSTRUCTIONS });
        const decoded = await audioCtx.decodeAudioData(buffer.slice(0));
        item = { buffer, decoded, seconds: decoded.duration };
        Object.assign(entry, { status: 'ok', ms: Math.round(performance.now() - t0), seconds: +decoded.duration.toFixed(2) });
        cache.set(key, item);
      } catch (e) { Object.assign(entry, { status: 'error', error: String(e.message || e) }); store.save(); throw e; }
      store.save();
    }
    out.push({ slide_id: s.slide_id, ...item });
  }
  return out;
}

let _ctx;
export function getAudioContext() { return _ctx ||= new (window.AudioContext || window.webkitAudioContext)(); }

export function buildVtt(script, audios, { pad = 0.8, lead = 0.3 } = {}) {
  let t = 0; const cues = [];
  script.forEach((s, i) => {
    const dur = (audios[i]?.seconds || 3) + pad;
    const sentences = splitSentences(s.narration || '');
    const words = sentences.reduce((a, x) => a + x.split(/\s+/).length, 0) || 1;
    let st = t + lead;
    for (const sent of sentences) {
      const share = (sent.split(/\s+/).length / words) * (dur - lead);
      cues.push({ start: st, end: Math.min(st + share, t + dur - 0.05), text: sent });
      st += share;
    }
    t += dur;
  });
  const fmt = x => { const h = Math.floor(x / 3600), m = Math.floor(x % 3600 / 60), s = x % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`; };
  return 'WEBVTT\n\n' + cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}\n`).join('\n');
}

function splitSentences(text) {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?。！？]+[.!?。！？]*/g) || [text];
  // merge tiny fragments
  const out = [];
  for (const p of parts.map(s => s.trim()).filter(Boolean)) { if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += ' ' + p; else out.push(p); }
  return out;
}

export function pickMime() {
  const c = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  return c.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

/**
 * Record the deck as a video. Draws each slide on a canvas while its narration plays through an
 * AudioContext destination; both streams are captured with MediaRecorder.
 * Returns { blob, mime, seconds, timeline:[{slide_id,start,end}] }.
 */
export async function recordVideo({ slides, script, audios, meta, theme, pad = 0.8, fps = 30, onProgress, signal }) {
  const mime = pickMime();
  if (!mime) throw new Error('This browser cannot record video (MediaRecorder unsupported). Try Chrome, Edge or Firefox.');
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const audioCtx = getAudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const dest = audioCtx.createMediaStreamDestination();
  const vStream = canvas.captureStream(fps);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 });
  const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  const timeline = [];
  const t = theme; const images = await loadThemeImages(t);
  // keep the canvas ticking even when nothing changes (captureStream only emits on paint)
  let tick = setInterval(() => { drawCurrent(); }, 1000 / fps);
  let current = 0;
  const drawCurrent = () => drawSlideCanvas(ctx, slides[current], t, current, slides.length, meta, W, H, images);
  rec.start(500);
  const startedAt = audioCtx.currentTime;
  try {
    for (let i = 0; i < slides.length; i++) {
      if (signal?.aborted) throw new Error('Recording cancelled');
      current = i; drawCurrent();
      const a = audios[i];
      const start = audioCtx.currentTime - startedAt;
      onProgress?.({ phase: 'record', index: i, total: slides.length, text: `Recording slide ${i + 1} of ${slides.length}…` });
      if (a?.decoded) {
        const src = audioCtx.createBufferSource(); src.buffer = a.decoded; src.connect(dest);
        const done = new Promise(res => { src.onended = res; });
        src.start();
        await Promise.race([done, abortPromise(signal)]);
      } else {
        await sleep(3000, signal);
      }
      await sleep(pad * 1000, signal);
      timeline.push({ slide_id: slides[i].slide_id, start: +start.toFixed(2), end: +(audioCtx.currentTime - startedAt).toFixed(2) });
    }
  } finally {
    clearInterval(tick);
    rec.stop(); await stopped;
    stream.getTracks().forEach(tr => tr.stop());
  }
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  return { blob, mime, seconds: timeline.at(-1)?.end || 0, timeline };
}

const sleep = (ms, signal) => new Promise((res, rej) => { const id = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(id); rej(new Error('Recording cancelled')); }, { once: true }); });
const abortPromise = signal => new Promise((_, rej) => signal?.addEventListener('abort', () => rej(new Error('Recording cancelled')), { once: true }));

/** Build a simple preview player (slides + audio, no recording) inside a container element. */
export function mountPreview(container, { slides, script, audios, meta, theme }) {
  container.innerHTML = '';
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; canvas.className = 'video-canvas';
  const ctx = canvas.getContext('2d');
  const bar = document.createElement('div'); bar.className = 'video-controls';
  const play = document.createElement('button'); play.className = 'button small'; play.textContent = '▶ Play preview';
  const stop = document.createElement('button'); stop.className = 'button small'; stop.textContent = '■ Stop';
  const pos = document.createElement('span'); pos.className = 'mono';
  bar.append(play, stop, pos); container.append(canvas, bar);
  const t = theme; let images = {};
  let i = 0, playing = false, src = null;
  const draw = () => { drawSlideCanvas(ctx, slides[i], t, i, slides.length, meta, W, H, images); pos.textContent = `${i + 1} / ${slides.length}`; };
  draw(); loadThemeImages(t).then(im => { images = im; draw(); });
  canvas.onclick = () => { if (!playing) { i = (i + 1) % slides.length; draw(); } };
  play.onclick = async () => {
    if (playing) return; playing = true; const actx = getAudioContext(); if (actx.state === 'suspended') await actx.resume();
    for (; i < slides.length && playing; i++) {
      draw(); const a = audios[i];
      if (a?.decoded) { src = actx.createBufferSource(); src.buffer = a.decoded; src.connect(actx.destination); await new Promise(res => { src.onended = res; src.start(); }); }
      else await new Promise(r => setTimeout(r, 2000));
    }
    if (i >= slides.length) i = 0; playing = false; draw();
  };
  stop.onclick = () => { playing = false; try { src?.stop(); } catch { /* ignore */ } };
  return { redraw: draw };
}

/** Preload the template background (data URL) for the canvas backend. */
export async function loadThemeImages(theme) {
  const out = {};
  if (theme?.background) { try { out[theme.background] = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = theme.background; }); } catch { /* ignore */ } }
  return out;
}

// ---------------------------------------------------------------- animated lesson (EduCast-style)
/**
 * Record the storyboard: each scene is drawn frame by frame (rAF) while its narration plays; the scene's
 * progress p = elapsed / (narration + tail). audios: [{decoded, seconds}] aligned with scenes.
 */
export async function recordAnimated({ scenes, audios, theme, meta, assets, pad = 0.6, fps = 30, onProgress, signal }) {
  const mime = pickMime();
  if (!mime) throw new Error('This browser cannot record video (MediaRecorder unsupported). Try Chrome, Edge or Firefox.');
  const canvas = document.createElement('canvas'); canvas.width = SW; canvas.height = SH;
  const ctx = canvas.getContext('2d');
  const audioCtx = getAudioContext(); if (audioCtx.state === 'suspended') await audioCtx.resume();
  const dest = audioCtx.createMediaStreamDestination();
  const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise(res => { rec.onstop = res; });
  const timeline = []; rec.start(500); const t0 = audioCtx.currentTime;
  try {
    for (let i = 0; i < scenes.length; i++) {
      if (signal?.aborted) throw new Error('Recording cancelled');
      const a = audios[i]; const dur = (a?.decoded?.duration || Math.max(4, scenes[i].target_seconds || 8)) + pad;
      onProgress?.({ phase: 'record', index: i, total: scenes.length, text: `Recording scene ${i + 1} of ${scenes.length}: ${scenes[i].title}` });
      const start = audioCtx.currentTime;
      if (a?.decoded) { const src = audioCtx.createBufferSource(); src.buffer = a.decoded; src.connect(dest); src.start(); }
      await new Promise((res, rej) => {
        const tick = () => { if (signal?.aborted) return rej(new Error('Recording cancelled')); const el = audioCtx.currentTime - start; drawScene(ctx, scenes[i], theme, Math.min(1, el / Math.max(dur - pad, 0.1)), { index: i, total: scenes.length, assets, meta }); if (el >= dur) res(); else requestAnimationFrame(tick); };
        tick();
      });
      timeline.push({ id: scenes[i].id, title: scenes[i].title, start: +(start - t0).toFixed(2), end: +(audioCtx.currentTime - t0).toFixed(2) });
    }
  } finally { rec.stop(); await stopped; stream.getTracks().forEach(tr => tr.stop()); }
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  return { blob, mime, seconds: timeline.at(-1)?.end || 0, timeline };
}

/** Preview player for the animated lesson: plays narration and animates; click a scene to jump. */
export function mountAnimatedPreview(container, { scenes, audios, theme, meta, assets, onScene }) {
  container.innerHTML = '';
  const canvas = document.createElement('canvas'); canvas.width = SW; canvas.height = SH; canvas.className = 'video-canvas';
  const ctx = canvas.getContext('2d');
  const bar = document.createElement('div'); bar.className = 'video-controls';
  const play = document.createElement('button'); play.className = 'btn sm'; play.textContent = 'Play preview';
  const stop = document.createElement('button'); stop.className = 'btn sm'; stop.textContent = 'Stop';
  const scrub = document.createElement('input'); scrub.type = 'range'; scrub.min = 0; scrub.max = 1000; scrub.value = 0; scrub.style.flex = '1'; scrub.setAttribute('aria-label', 'Scene progress');
  const pos = document.createElement('span'); pos.className = 'mono';
  bar.append(play, stop, scrub, pos); container.append(canvas, bar);
  let i = 0, playing = false, src = null, raf = 0;
  const draw = p => { drawScene(ctx, scenes[i], theme, p, { index: i, total: scenes.length, assets, meta }); pos.textContent = `${i + 1} / ${scenes.length}`; onScene?.(i, p); };
  scrub.oninput = () => { if (!playing) draw(scrub.value / 1000); };
  draw(0.999);
  play.onclick = async () => {
    if (playing) return; playing = true; const actx = getAudioContext(); if (actx.state === 'suspended') await actx.resume();
    for (; i < scenes.length && playing; i++) {
      const a = audios?.[i]; const dur = a?.decoded?.duration || Math.max(4, scenes[i].target_seconds || 8);
      const start = actx.currentTime; if (a?.decoded) { src = actx.createBufferSource(); src.buffer = a.decoded; src.connect(actx.destination); src.start(); }
      await new Promise(res => { const tick = () => { const el = actx.currentTime - start; const p = Math.min(1, el / dur); draw(p); scrub.value = Math.round(p * 1000); if (!playing || el >= dur + 0.4) res(); else raf = requestAnimationFrame(tick); }; tick(); });
      try { src?.stop(); } catch { /* ignore */ }
    }
    if (i >= scenes.length) i = 0; playing = false; draw(0.999);
  };
  stop.onclick = () => { playing = false; cancelAnimationFrame(raf); try { src?.stop(); } catch { /* ignore */ } };
  return { redraw: draw, select: k => { if (playing) return; i = Math.max(0, Math.min(scenes.length - 1, k)); draw(0.999); }, get scene() { return i; } };
}

// ---------------------------------------------------------------- offline, frame-accurate rendering (WebCodecs → MP4)

const RES = { '1080p': [1920, 1080], '720p': [1280, 720] };

/** Scene timeline for the animated lesson: [{id,title,start,end,dur,beat,narration}] + total seconds. */
export function sceneTimeline(scenes, audios, pad = 0.6) {
  let t = 0;
  const items = scenes.map((s, i) => { const dur = (audios?.[i]?.decoded?.duration || Math.max(4, s.target_seconds || 8)) + pad; const it = { id: s.id, title: s.title, beat: s.beat, narration: s.narration, start: +t.toFixed(3), end: +(t + dur).toFixed(3), dur }; t += dur; return it; });
  return { items, total: t };
}

/**
 * Render the animated lesson deterministically: every frame is drawn at its exact time and encoded to MP4
 * (H.264/AAC via WebCodecs). Falls back to real-time MediaRecorder capture (WebM) when WebCodecs is unavailable.
 * Returns { blob, mime, ext, seconds, timeline, poster, method }.
 */
export async function renderAnimated({ scenes, audios, theme, meta, assets, res = '1080p', pad = 0.6, fps = 30, onProgress, signal }) {
  const [PW, PH] = RES[res] || RES['1080p'];
  const { items, total } = sceneTimeline(scenes, audios, pad);
  const draw = (ctx, tt) => {
    let i = items.findIndex(x => tt < x.end); if (i < 0) i = items.length - 1; const it = items[i];
    const p = Math.min(1, Math.max(0, (tt - it.start) / Math.max(it.dur - pad, 0.1)));
    ctx.save(); ctx.scale(PW / SW, PH / SH); drawScene(ctx, scenes[i], theme, p, { index: i, total: scenes.length, assets, meta }); ctx.restore();
  };
  const support = await encoderSupport().catch(e => ({ ok: false, reason: String(e.message || e) }));
  if (support.ok) {
    onProgress?.({ phase: 'mix', text: 'Mixing narration…' });
    const audio = await mixNarration(items.map((it, i) => ({ decoded: audios?.[i]?.decoded || null, start: it.start })), total);
    const out = await encodeVideo({ width: PW, height: PH, fps, duration: total, draw, audio, onProgress, signal });
    const poster = posterFrame(draw, PW, PH, Math.min(total - 0.1, items[0].dur * 0.92));
    return { ...out, seconds: total, timeline: items.map(({ id, title, start, end, beat, narration }) => ({ id, title, start, end, beat, narration })), poster, method: `webcodecs:${support.video}/${support.audio}` };
  }
  onProgress?.({ phase: 'record', text: `WebCodecs unavailable (${support.reason || 'unsupported browser'}); recording in real time instead…` });
  const rec = await recordAnimated({ scenes, audios, theme, meta, assets, pad, fps, onProgress, signal });
  return { ...rec, ext: rec.mime.includes('mp4') ? 'mp4' : 'webm', poster: null, method: 'mediarecorder', fallback: support.reason };
}

/** Same for Option 1 (narrated slides): each slide is held while its narration plays. */
export async function renderSlides({ slides, script, audios, theme, meta, res = '1080p', pad = 0.8, fps = 30, onProgress, signal }) {
  const [PW, PH] = RES[res] || RES['1080p'];
  let t = 0; const items = slides.map((s, i) => { const dur = (audios?.[i]?.decoded?.duration || 3) + pad; const it = { slide_id: s.slide_id, title: s.title, start: +t.toFixed(3), end: +(t + dur).toFixed(3), dur, narration: script?.[i]?.narration || '' }; t += dur; return it; });
  const total = t; const images = await loadThemeImages(theme);
  const draw = (ctx, tt) => { let i = items.findIndex(x => tt < x.end); if (i < 0) i = items.length - 1; drawSlideCanvas(ctx, slides[i], theme, i, slides.length, meta, PW, PH, images); };
  const support = await encoderSupport().catch(e => ({ ok: false, reason: String(e.message || e) }));
  if (support.ok) {
    onProgress?.({ phase: 'mix', text: 'Mixing narration…' });
    const audio = await mixNarration(items.map((it, i) => ({ decoded: audios?.[i]?.decoded || null, start: it.start })), total);
    const out = await encodeVideo({ width: PW, height: PH, fps: Math.min(fps, 15), duration: total, draw, audio, onProgress, signal });
    return { ...out, seconds: total, timeline: items.map(({ slide_id, start, end }) => ({ slide_id, start, end })), poster: posterFrame(draw, PW, PH, 0.5), method: `webcodecs:${support.video}/${support.audio}` };
  }
  onProgress?.({ phase: 'record', text: `WebCodecs unavailable (${support.reason || 'unsupported browser'}); recording in real time instead…` });
  const rec = await recordVideo({ slides, script, audios, meta, theme, pad, fps, onProgress, signal });
  return { ...rec, ext: rec.mime.includes('mp4') ? 'mp4' : 'webm', poster: null, method: 'mediarecorder', fallback: support.reason };
}
