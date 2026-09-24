// video.js — narrated lecture video, produced entirely in the browser:
// TTS per slide (OpenAI /audio/speech) → canvas slides → MediaRecorder (WebM) + WebVTT captions.
import { drawSlide, W, H, THEMES } from './slides.js';

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
export async function recordVideo({ slides, script, audios, meta, theme = 'studio', pad = 0.8, fps = 30, onProgress, signal }) {
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
  const t = THEMES[theme] || THEMES.studio;
  // keep the canvas ticking even when nothing changes (captureStream only emits on paint)
  let tick = setInterval(() => { ctx.fillStyle = t.bg; ctx.fillRect(0, 0, 1, 1); drawCurrent(); }, 1000 / fps);
  let current = 0;
  const drawCurrent = () => drawSlide(ctx, slides[current], current, slides.length, meta, t);
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
export function mountPreview(container, { slides, script, audios, meta, theme = 'studio' }) {
  container.innerHTML = '';
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H; canvas.className = 'video-canvas';
  const ctx = canvas.getContext('2d');
  const bar = document.createElement('div'); bar.className = 'video-controls';
  const play = document.createElement('button'); play.className = 'button small'; play.textContent = '▶ Play preview';
  const stop = document.createElement('button'); stop.className = 'button small'; stop.textContent = '■ Stop';
  const pos = document.createElement('span'); pos.className = 'mono';
  bar.append(play, stop, pos); container.append(canvas, bar);
  const t = THEMES[theme] || THEMES.studio;
  let i = 0, playing = false, src = null;
  const draw = () => { drawSlide(ctx, slides[i], i, slides.length, meta, t); pos.textContent = `${i + 1} / ${slides.length}`; };
  draw();
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
