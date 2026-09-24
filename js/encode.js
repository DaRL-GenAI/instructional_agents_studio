// encode.js — deterministic, frame-accurate MP4 export in the browser.
// WebCodecs (VideoEncoder / AudioEncoder) draws every frame at its exact timestamp — no captureStream,
// no real-time recording, no dropped frames when the tab is busy — and mp4-muxer writes a proper .mp4
// (moov up front, correct duration) that PowerPoint, QuickTime and LMSs open. Nothing leaves the browser.
// Callers fall back to MediaRecorder when encoderSupport().ok is false (e.g. Safari without AudioEncoder).

const MUXER_SOURCES = [
  'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs',
  'https://unpkg.com/mp4-muxer@5.2.2/build/mp4-muxer.mjs',
];
let muxerLoading;
/** Load mp4-muxer (ESM build) once; jsDelivr first, unpkg as fallback. */
export function loadMuxer() {
  muxerLoading ||= (async () => {
    let lastErr;
    for (const src of MUXER_SOURCES) {
      try { const m = await import(/* webpackIgnore: true */ src); if (m?.Muxer && m?.ArrayBufferTarget) return m; }
      catch (e) { lastErr = e; }
    }
    muxerLoading = null;
    throw new Error(`The MP4 muxer library could not be loaded (${lastErr?.message || 'network'}). Check your connection or content blockers, then try again.`);
  })();
  return muxerLoading;
}

// ---------------------------------------------------------------- capability probe
const VIDEO_CANDIDATES = (width, height) => {
  const big = width * height > 1280 * 720;
  return [
    { id: 'avc', codec: big ? 'avc1.640028' : 'avc1.4d401f', extra: { avc: { format: 'avcC' } } },
    { id: 'avc', codec: 'avc1.640028', extra: { avc: { format: 'avcC' } } },
    { id: 'avc', codec: 'avc1.42001f', extra: { avc: { format: 'avcC' } } },
    { id: 'vp9', codec: 'vp09.00.40.08', extra: {} },
  ];
};
const AUDIO_CANDIDATES = [
  { id: 'aac', codec: 'mp4a.40.2' },
  { id: 'opus', codec: 'opus' },
];
const supportCache = new Map();

async function pickVideo(width, height) {
  for (const c of VIDEO_CANDIDATES(width, height)) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width, height, bitrate: 4_000_000, framerate: 30, hardwareAcceleration: 'no-preference', latencyMode: 'quality', ...c.extra });
      if (r.supported) return c;
    } catch { /* try next */ }
  }
  return null;
}
async function pickAudio() {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const c of AUDIO_CANDIDATES) {
    try { const r = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 }); if (r.supported) return c; }
    catch { /* try next */ }
  }
  return null;
}

/**
 * Probe WebCodecs support for the given frame size. Cached per size.
 * @returns {Promise<{ok:boolean, video:'avc'|'vp9'|null, videoCodec:string|null, audio:'aac'|'opus'|null, audioCodec:string|null, reason:string}>}
 */
export async function encoderSupport(width = 1920, height = 1080) {
  const key = `${width}x${height}`;
  if (supportCache.has(key)) return supportCache.get(key);
  const p = (async () => {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { ok: false, video: null, videoCodec: null, audio: null, audioCodec: null, reason: 'WebCodecs (VideoEncoder) is not available in this browser' };
    const v = await pickVideo(width, height);
    if (!v) return { ok: false, video: null, videoCodec: null, audio: null, audioCodec: null, reason: `No supported H.264/VP9 encoder for ${key}` };
    const a = await pickAudio();
    if (!a) return { ok: false, video: v.id, videoCodec: v.codec, audio: null, audioCodec: null, reason: 'No supported AAC/Opus audio encoder (AudioEncoder)' };
    return { ok: true, video: v.id, videoCodec: v.codec, audio: a.id, audioCodec: a.codec, reason: '' };
  })();
  supportCache.set(key, p);
  const res = await p; supportCache.set(key, res); return res;
}

// ---------------------------------------------------------------- helpers
const yieldNow = () => new Promise(r => setTimeout(r, 0));
const abortError = () => Object.assign(new Error('Encoding cancelled'), { name: 'AbortError' });

/** Resample/mix any AudioBuffer to 48 kHz stereo. */
async function toStereo48k(buffer, sampleRate = 48000) {
  if (buffer.sampleRate === sampleRate && buffer.numberOfChannels === 2) return buffer;
  const length = Math.ceil(buffer.duration * sampleRate);
  const off = new OfflineAudioContext(2, Math.max(1, length), sampleRate);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start(0);
  return await off.startRendering();
}

/** Render narration clips onto one stereo timeline. clips = [{ decoded: AudioBuffer|null, start: seconds, gain = 1 }]. */
export async function mixNarration(clips, totalSeconds, { sampleRate = 48000 } = {}) {
  const frames = Math.max(1, Math.ceil(Math.max(totalSeconds || 0, 0.05) * sampleRate));
  const off = new OfflineAudioContext(2, frames, sampleRate);
  for (const c of clips || []) {
    if (!c?.decoded) continue;
    const src = off.createBufferSource(); src.buffer = c.decoded;
    const g = off.createGain(); g.gain.value = c.gain ?? 1;
    src.connect(g).connect(off.destination);
    src.start(Math.max(0, c.start || 0));
  }
  return await off.startRendering();
}

/** Draw one frame to a temporary canvas and return it as a data URL (JPEG by default). */
export function posterFrame(draw, width, height, tSeconds = 0, { type = 'image/jpeg', quality = 0.85 } = {}) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  draw(ctx, tSeconds, 0);
  return c.toDataURL(type, quality);
}

/** Duration of a video/audio blob in seconds (null when unknown, e.g. MediaRecorder WebM without cues). */
export function blobDuration(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
    const done = val => { URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(val); };
    v.onloadedmetadata = () => { const d = v.duration; done(Number.isFinite(d) ? d : null); };
    v.onerror = () => done(null);
    v.src = url;
  });
}

// ---------------------------------------------------------------- main encoder
/**
 * Encode a video offline, frame by frame.
 * @param {object} o
 * @param {number} o.width  frame width in px
 * @param {number} o.height frame height in px
 * @param {number} [o.fps=30]
 * @param {number} o.duration total seconds
 * @param {(ctx:CanvasRenderingContext2D, tSeconds:number, frameIndex:number)=>void} o.draw paints frame i
 * @param {AudioBuffer|null} [o.audio] full-length soundtrack (any rate/channels)
 * @param {number} [o.bitrate] video bitrate in bps (default 6 Mbps at 1080p, 3.5 Mbps at 720p)
 * @param {(p:{phase:string, frame:number, total:number, text:string})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{blob:Blob, mime:string, ext:string, seconds:number, frames:number, codecs:{video:string, audio:string|null}}>}
 */
export async function encodeVideo({ width, height, fps = 30, duration, draw, audio = null, bitrate, onProgress, signal }) {
  const support = await encoderSupport(width, height);
  if (!support.ok) throw new Error(`WebCodecs unavailable: ${support.reason}`);
  if (signal?.aborted) throw abortError();
  const { Muxer, ArrayBufferTarget } = await loadMuxer();

  const total = Math.max(1, Math.round(duration * fps));
  const frameUs = Math.round(1e6 / fps);
  const vbr = bitrate || (width * height > 1280 * 720 ? 6_000_000 : 3_500_000);
  const useAudio = !!audio && audio.length > 0;
  const audioCodec = useAudio ? support.audio : null;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: support.video, width, height, frameRate: fps },
    ...(useAudio ? { audio: { codec: audioCodec, sampleRate: 48000, numberOfChannels: 2 } } : {}),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let failure = null;
  const fail = e => { failure ||= (e instanceof Error ? e : new Error(String(e?.message || e))); };
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        if (support.video === 'vp9' && meta?.decoderConfig && !meta.decoderConfig.colorSpace) meta.decoderConfig.colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
        muxer.addVideoChunk(chunk, meta);
      } catch (e) { fail(e); }
    },
    error: fail,
  });
  videoEncoder.configure({ codec: support.videoCodec, width, height, bitrate: vbr, framerate: fps, hardwareAcceleration: 'no-preference', latencyMode: 'quality', ...(support.video === 'avc' ? { avc: { format: 'avcC' } } : {}) });

  let audioEncoder = null;
  if (useAudio) {
    audioEncoder = new AudioEncoder({ output: (chunk, meta) => { try { muxer.addAudioChunk(chunk, meta); } catch (e) { fail(e); } }, error: fail });
    audioEncoder.configure({ codec: support.audioCodec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 });
  }

  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  const cleanup = () => { try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch { /* ignore */ } try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch { /* ignore */ } };
  const onAbort = () => { fail(abortError()); };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    // --- audio first (cheap, fixed-size chunks of 1024 frames)
    if (useAudio) {
      const pcm = await toStereo48k(audio, 48000);
      const L = pcm.getChannelData(0), R = pcm.numberOfChannels > 1 ? pcm.getChannelData(1) : L;
      const CH = 1024; const n = pcm.length; const maxFrames = Math.ceil(duration * 48000);
      for (let off = 0; off < Math.min(n, maxFrames); off += CH) {
        if (failure) throw failure;
        const len = Math.min(CH, n - off);
        const data = new Float32Array(CH * 2); data.set(L.subarray(off, off + len), 0); data.set(R.subarray(off, off + len), CH);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: CH, numberOfChannels: 2, timestamp: Math.round(off / 48000 * 1e6), data });
        audioEncoder.encode(ad); ad.close();
        if (audioEncoder.encodeQueueSize > 16) await yieldNow();
      }
    }
    // --- video frames
    const gop = fps * 2; let lastReport = 0;
    for (let i = 0; i < total; i++) {
      if (failure) throw failure;
      const t = i / fps;
      draw(ctx, t, i);
      const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
      videoEncoder.encode(frame, { keyFrame: i % gop === 0 });
      frame.close();
      while (videoEncoder.encodeQueueSize > 4) { if (failure) throw failure; await yieldNow(); }
      const now = performance.now();
      if (now - lastReport > 250 || i === total - 1) { lastReport = now; onProgress?.({ phase: 'encode', frame: i + 1, total, text: `Encoding frame ${i + 1} of ${total} (${Math.round((i + 1) / total * 100)}%)` }); }
      if (i % 3 === 2) await yieldNow();
    }
    onProgress?.({ phase: 'finalize', frame: total, total, text: 'Finalising the MP4…' });
    await videoEncoder.flush();
    if (audioEncoder) await audioEncoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    return { blob, mime: 'video/mp4', ext: 'mp4', seconds: total / fps, frames: total, codecs: { video: support.videoCodec, audio: audioCodec ? support.audioCodec : null } };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    cleanup();
  }
}
