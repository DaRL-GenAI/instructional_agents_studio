// player.js — the interactive lesson player (EduCast-style hybrid player) built around one lecture video per
// chapter plus "practice" nodes that pause the video and mount the trusted interactive runtime
// (js/vendor/interactive-runtime.js). Exports: manifest builder, self-contained player HTML, ZIP bundle,
// single-file standalone HTML and an in-app preview (iframe). Everything is assembled in the browser.

const JSZIP_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
let jszipLoading;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = JSZIP_SRC; s.onload = () => res(window.JSZip); s.onerror = () => { jszipLoading = null; rej(new Error('Could not load JSZip from cdnjs')); }; document.head.appendChild(s); });
  return jszipLoading;
}

const RUNTIME_URL = new URL('./vendor/interactive-runtime.js', import.meta.url);
let runtimeText;
async function loadRuntimeText() {
  runtimeText ||= (async () => { const r = await fetch(RUNTIME_URL); if (!r.ok) throw new Error(`Could not read interactive-runtime.js (HTTP ${r.status})`); return await r.text(); })().catch(e => { runtimeText = null; throw e; });
  return runtimeText;
}

const slug = s => String(s || 'lesson').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'lesson';
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); }
const hex = (v, fb) => { const c = String(v || '').replace('#', '').trim(); return /^[0-9a-fA-F]{6}$/.test(c) ? `#${c.toUpperCase()}` : fb; };
const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const str = v => (v == null ? '' : String(v));
const MIME = { mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', vtt: 'text/vtt', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', js: 'text/javascript', html: 'text/html', txt: 'text/plain' };
const mimeOf = path => MIME[String(path).split('.').pop().toLowerCase()] || 'application/octet-stream';

// ---------------------------------------------------------------- manifest
/**
 * Build the lesson manifest the player reads.
 * theme: Studio deck theme ({primary, secondary, accent} hex without '#', optional fonts.body).
 * scenes: [{id, title, start, end, narration, beat}] in seconds on the video timeline.
 * practice: [{id, title, trigger_at, template, parameters, instruction, narration, audio_src}].
 */
export function buildManifest({ topic, chapter, course, theme = {}, video, scenes = [], practice = [], captions = null }) {
  const duration = num(video?.duration, 0);
  const cleanScenes = scenes.filter(Boolean).map((s, i) => ({ id: str(s.id || `s${i + 1}`), title: str(s.title || `Scene ${i + 1}`), start: Math.max(0, num(s.start)), end: Math.max(0, num(s.end ?? s.start)), narration: str(s.narration), beat: str(s.beat) }));
  const cleanPractice = practice.filter(p => p && p.template).map((p, i) => ({
    id: str(p.id || `practice-${i + 1}`), title: str(p.title || p.instruction || 'Your turn'),
    trigger_at: Math.min(Math.max(0, num(p.trigger_at)), Math.max(0, duration - 0.05)),
    template: str(p.template), parameters: p.parameters && typeof p.parameters === 'object' ? p.parameters : {},
    instruction: str(p.instruction), narration: str(p.narration), audio_src: p.audio_src ? str(p.audio_src) : null,
  })).sort((a, b) => a.trigger_at - b.trigger_at);
  const body = {
    topic: str(topic || chapter || 'Lesson'), chapter: str(chapter), course: str(course),
    style: {
      palette: { background: '#FAFBF8', primary: hex(theme.primary, '#356B8F'), secondary: hex(theme.accent, '#16734A'), text: '#17201B', muted: '#66706A', danger: '#B4423D' },
      font: str(theme.fonts?.body || 'Calibri'),
    },
    video: { src: str(video?.src || 'media/lesson.mp4'), duration, poster: video?.poster ? str(video.poster) : null },
    scenes: cleanScenes, practice: cleanPractice, captions: captions ? str(captions) : null, total_duration: duration,
  };
  const content_version = hash(JSON.stringify(body));
  return { bundle_id: `${slug(chapter || topic)}-${content_version.slice(0, 6)}`, ...body, content_version, generated_at: new Date().toISOString(), generator: 'Instructional Agents Studio' };
}

// ---------------------------------------------------------------- player page
const PLAYER_CSS = `
:root { color-scheme: light; --bg:#FAFBF8; --primary:#356B8F; --secondary:#16734A; --text:#17201B; --muted:#66706A; --danger:#B4423D;
  --pad:40px; --font:Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --base-size:16px; --heading-scale:1.25; --stage-ratio:16 / 9;
  --ui-ground:#f7f5f0; --ui-surface:#fffefa; --ui-soft:#f0f1e9; --ui-ink:#252a24; --ui-dim:#737871; --ui-line:#e4e5dd; --ui-line-strong:#cdd2c7;
  --ui-green:#54705b; --ui-green-soft:#eaf0e8; --ui-red:#aa5145; --ui-red-soft:#faece6; --ui-amber:#c45e3c; --ui-amber-soft:#f9ece3;
  --ui-shadow:0 8px 28px rgba(36,43,40,.05); --ui-sans:Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; --ui-mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
* { box-sizing:border-box; } html { background:var(--ui-ground); }
body { margin:0; min-width:280px; min-height:100vh; background:var(--ui-ground); color:var(--ui-ink); font-family:var(--ui-sans); font-size:14px; line-height:1.5; -webkit-font-smoothing:antialiased; }
button { font:inherit; color:inherit; } button:focus-visible { outline:2px solid var(--ui-green); outline-offset:3px; }
.topbar { min-height:66px; padding:12px 24px; display:flex; align-items:center; justify-content:space-between; gap:20px; background:var(--ui-surface); border-bottom:1px solid var(--ui-line); }
.brand { display:flex; align-items:center; gap:12px; min-width:0; }
.brand-mark { flex:0 0 auto; width:32px; height:32px; display:grid; grid-template-columns:repeat(2,1fr); gap:3px; padding:7px; background:var(--ui-green); border-radius:10px; }
.brand-mark i { background:#fff; border-radius:1px; } .brand-mark i:nth-child(2), .brand-mark i:nth-child(3) { opacity:.5; }
.brand-text { min-width:0; } #topic { margin:0; font-size:14px; font-weight:600; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.eyebrow { margin:3px 0 0; color:var(--ui-dim); font-size:10px; letter-spacing:.08em; text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.header-actions { display:flex; align-items:center; gap:7px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end; }
header button { min-height:34px; padding:0 11px; border:1px solid var(--ui-line); background:var(--ui-surface); border-radius:8px; cursor:pointer; font-size:11px; font-weight:500; color:var(--ui-ink); transition:border-color .18s, background .18s, color .18s; }
header button:hover { border-color:var(--ui-line-strong); background:var(--ui-soft); }
header button.ghost { color:var(--ui-dim); border-color:transparent; background:transparent; } header button.ghost:hover { background:var(--ui-soft); }
header button.ghost.active { color:var(--ui-green); background:var(--ui-green-soft); }
header button#next { background:var(--ui-green); border-color:var(--ui-green); color:#fff; } header button#next:hover { background:#45604f; border-color:#45604f; }
main { max-width:1320px; margin-inline:auto; }
.stage-band { padding:20px 24px 0; min-width:0; }
.stage-wrap { margin:0 auto; max-width:min(1120px, max(560px, calc((100vh - 300px) * 16 / 9))); }
.now-playing { display:flex; align-items:baseline; gap:14px; margin:0 0 12px; min-height:24px; }
.status-label { flex:0 0 auto; margin:0; color:var(--ui-dim); font-size:10px; letter-spacing:.08em; text-transform:uppercase; }
#status { display:flex; align-items:center; gap:9px; flex-wrap:wrap; min-width:0; }
#status .num, #status .time { font:500 10px/1 var(--ui-mono); color:var(--ui-dim); font-variant-numeric:tabular-nums; } #status .name { font-size:12px; font-weight:500; }
.badge { display:inline-flex; align-items:center; padding:3px 7px; border-radius:5px; font-size:9px; font-weight:500; white-space:nowrap; text-transform:uppercase; letter-spacing:.04em; }
.badge.ok { color:var(--ui-green); background:var(--ui-green-soft); } .badge.warn { color:var(--ui-amber); background:var(--ui-amber-soft); } .badge.lbl { color:var(--ui-green); background:var(--ui-green-soft); } .badge.caution { color:var(--ui-red); background:var(--ui-red-soft); }
#stage { position:relative; width:100%; aspect-ratio:var(--stage-ratio); background:#000; border:1px solid var(--ui-line); border-radius:14px; overflow:hidden; box-shadow:var(--ui-shadow); }
#stage[data-state="PRACTICE"] { border-color:#d7b199; } #stage[data-state="ERROR"] { border-color:#d9a9a5; }
#video { display:block; width:100%; height:100%; object-fit:contain; background:#000; }
#practice { position:absolute; inset:0; padding:clamp(14px, 3.4%, 40px); background:var(--bg); color:var(--text); overflow:auto; container-type:size; container-name:stage; }
#practice .practice-bar { position:absolute; right:14px; top:12px; display:flex; gap:6px; z-index:2; }
#practice .practice-bar button { min-height:30px; padding:0 10px; border:1px solid var(--ui-line); background:#fff; border-radius:8px; cursor:pointer; font-size:11px; color:var(--ui-dim); }
#practice .practice-bar button:hover { color:var(--ui-ink); border-color:var(--ui-line-strong); }
#practice-root { width:100%; height:100%; }
.hidden { display:none !important; }
.error { max-width:62ch; margin:9% auto 0; text-align:center; color:var(--danger); font:600 13.5px/1.7 var(--ui-mono); }
.lesson-done { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; text-align:center; padding:20px; }
.lesson-done strong { font-size:28px; font-weight:700; color:var(--text); } .lesson-done span { font:500 12px/1.4 var(--ui-mono); color:var(--muted); }
.lesson-done button { margin-top:8px; min-height:36px; padding:0 16px; border-radius:8px; border:1px solid var(--ui-line); background:#fff; cursor:pointer; }
.narration-block { display:grid; grid-template-columns:82px minmax(0,1fr); gap:14px; padding:16px 2px 6px; }
.narration-label { margin:3px 0 0; color:var(--ui-dim); font-size:9px; text-transform:uppercase; letter-spacing:.09em; }
#caption { margin:0; color:#646c62; font-size:12px; line-height:1.8; min-height:2.2em; } #caption.is-empty { color:transparent; }
.rail-band { padding:16px 24px 22px; min-width:0; }
.rail-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 0 12px; }
.rail-heading h2 { margin:0; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--ui-dim); font-weight:500; } .rail-heading span { font-size:9px; color:var(--ui-dim); }
#progress { display:flex; align-items:stretch; gap:8px; overflow-x:auto; padding:3px 0 5px; }
.step { position:relative; flex:1 1 0; min-width:84px; display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid transparent; border-radius:9px; background:transparent; text-align:left; cursor:pointer; color:var(--ui-dim); transition:background .18s, border-color .18s; }
.step:hover { color:var(--ui-ink); background:#f1f2ec; } .step:focus-visible { outline-offset:-2px; }
.step-track { position:relative; height:8px; display:flex; align-items:center; }
.step-track::before { content:""; position:absolute; left:0; right:0; height:3px; border-radius:3px; background:var(--ui-line); }
.step[data-type="practice"] { flex:0 0 auto; min-width:120px; } .step[data-type="practice"] .step-track::before { background:#ecd5c3; }
.step-fill { position:absolute; left:0; right:0; height:3px; border-radius:3px; background:var(--ui-green); transform:scaleX(0); transform-origin:left center; transition:transform .25s linear; }
.step[data-type="practice"] .step-fill { background:var(--ui-amber); }
.step-tick { position:absolute; top:0; height:8px; width:3px; border-radius:2px; background:var(--ui-amber); transform:translateX(-50%); }
.step-meta { display:flex; align-items:baseline; gap:8px; min-width:0; } .step-num { flex:0 0 auto; font:500 10px/1 var(--ui-mono); }
.step-label { flex:1 1 auto; min-width:0; font-size:11px; font-weight:400; line-height:1.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.step.done .step-num, .step.current .step-num { color:var(--ui-green); } .step[data-type="practice"].done .step-num, .step[data-type="practice"].current .step-num { color:var(--ui-amber); }
.step.current { color:var(--ui-ink); background:var(--ui-green-soft); border-color:#d9e2d5; } .step.current .step-label { font-weight:500; }
.step[data-type="practice"].current { background:var(--ui-amber-soft); border-color:#eddacb; }
footer { max-width:1320px; margin-inline:auto; display:flex; justify-content:space-between; gap:16px; padding:0 24px 20px; color:var(--ui-dim); font-size:10px; } footer a { color:inherit; }
@media (max-width:720px) {
  .topbar { align-items:flex-start; flex-wrap:wrap; gap:12px; padding:14px 16px; } .header-actions { width:100%; justify-content:flex-start; } .brand { width:100%; } #topic { white-space:normal; }
  .stage-band, .rail-band { padding-inline:16px; } .now-playing { gap:8px; flex-wrap:wrap; } .status-label { display:none; } #stage { border-radius:10px; }
  #stage[data-state="PRACTICE"] { min-height:460px; aspect-ratio:auto; } #stage[data-state="PRACTICE"] #practice { position:relative; min-height:460px; container-type:inline-size; }
  #stage[data-state="PRACTICE"] #practice .eh { height:auto; min-height:430px; gap:12px; } #stage[data-state="PRACTICE"] #practice .eh h2 { font-size:16px; }
  #stage[data-state="PRACTICE"] #practice .eh-stage { flex:0 0 140px; min-height:140px; } #stage[data-state="PRACTICE"] #practice svg.eh-svg { width:100%; height:140px; }
  .narration-block { grid-template-columns:1fr; gap:6px; padding-top:14px; } #caption { font-size:11px; } .step { min-width:124px; } .step-label { white-space:normal; } footer { padding:0 16px 18px; }
}
@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
`;

const PLAYER_JS = String.raw`
(function () {
  "use strict";
  var State = { IDLE: "IDLE", WATCHING: "WATCHING", PRACTICE: "PRACTICE", FINISHED: "FINISHED", ERROR: "ERROR" };
  var manifest = window.STUDIO_MANIFEST;
  var inline = window.STUDIO_INLINE || null;
  function resolve(src) { if (!src) return src; if (inline && Object.prototype.hasOwnProperty.call(inline, src)) return inline[src]; return src; }
  function clock(seconds) { var s = Math.max(0, Math.round(Number(seconds) || 0)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function $(id) { return document.getElementById(id); }
  function applyStyle(style) {
    var root = document.documentElement, p = (style && style.palette) || {};
    var tokens = { "--bg": p.background, "--primary": p.primary, "--secondary": p.secondary, "--text": p.text, "--muted": p.muted, "--danger": p.danger };
    Object.keys(tokens).forEach(function (k) { if (tokens[k]) root.style.setProperty(k, String(tokens[k])); });
  }

  function start() {
    applyStyle(manifest.style || {});
    $("topic").textContent = manifest.topic || "Lesson";
    var eyebrow = $("eyebrow"); if (eyebrow) eyebrow.textContent = [manifest.course, "Interactive lesson"].filter(Boolean).join(" · ");
    var stage = $("stage"), video = $("video"), practiceBox = $("practice"), practiceRoot = $("practice-root"), narration = $("narration");
    var status = $("status"), caption = $("caption"), captionToggle = $("captions"), progress = $("progress");
    var scenes = manifest.scenes || [], practice = (manifest.practice || []).slice().sort(function (a, b) { return a.trigger_at - b.trigger_at; });
    var duration = Number(manifest.video && manifest.video.duration) || 0;
    var state = State.IDLE, sceneIndex = -1, activePractice = null, cleanupPractice = null, captionsOn = true, generation = 0;
    var fired = {}; var events = []; var fills = {}; var lastSaved = 0;
    var contentVersion = manifest.content_version || "v";
    var resumeKey = "studio-lesson:" + (manifest.bundle_id || "lesson") + ":resume:" + contentVersion;
    var eventsKey = "studio-lesson:" + (manifest.bundle_id || "lesson") + ":events";

    // ---- rail nodes: scenes with practice nodes slotted after the scene containing their trigger
    var nodes = [];
    scenes.forEach(function (s, i) {
      nodes.push({ type: "scene", index: i, scene: s });
      practice.forEach(function (p, k) {
        var inScene = p.trigger_at >= s.start && (i === scenes.length - 1 || p.trigger_at < scenes[i + 1].start);
        if (inScene) nodes.push({ type: "practice", index: k, practice: p });
      });
    });
    practice.forEach(function (p, k) { if (!nodes.some(function (n) { return n.type === "practice" && n.index === k; })) nodes.push({ type: "practice", index: k, practice: p }); });
    if (!scenes.length) nodes.unshift({ type: "scene", index: 0, scene: { id: "video", title: manifest.topic || "Lesson", start: 0, end: duration, narration: "" } });
    if (!scenes.length) scenes = [nodes[0].scene];

    function record(type, detail) {
      events.push({ type: type, detail: detail || {}, state: state, scene: sceneIndex, t: Number(video.currentTime || 0), at: new Date().toISOString() });
      try { localStorage.setItem(eventsKey, JSON.stringify(events.slice(-500))); } catch (_) {}
    }
    function setState(next) { state = next; stage.dataset.state = next; document.body.dataset.mode = next === State.PRACTICE ? "practice" : "watch"; record("state", { value: next }); }
    function setCaption(text) { caption.textContent = captionsOn ? (text || "") : ""; caption.classList.toggle("is-empty", !captionsOn || !text); }
    function setStatus(parts) {
      status.replaceChildren();
      parts.forEach(function (pair) { if (!pair[0]) return; var span = document.createElement("span"); span.className = pair[1]; span.textContent = pair[0]; status.appendChild(span); });
    }
    function sceneAt(t) { var idx = 0; for (var i = 0; i < scenes.length; i++) if (t + 0.001 >= scenes[i].start) idx = i; return idx; }
    function sceneStatus() {
      var s = scenes[Math.max(0, sceneIndex)] || scenes[0];
      setStatus([[String(Math.max(1, sceneIndex + 1)).padStart(2, "0") + " / " + String(scenes.length).padStart(2, "0"), "num"], [s.title || s.id, "name"], [activePractice ? "your turn" : "video", "badge " + (activePractice ? "caution" : "lbl")], [clock(video.currentTime) + " / " + clock(duration || video.duration), "time"]]);
    }
    function setFill(key, ratio) { var f = fills[key]; if (f) f.style.transform = "scaleX(" + Math.max(0, Math.min(1, ratio)) + ")"; }

    function paintRail() {
      progress.replaceChildren(); fills = {};
      nodes.forEach(function (n) {
        var step = document.createElement("button"); step.type = "button";
        var isCurrent = n.type === "scene" ? (n.index === sceneIndex && !activePractice) : (activePractice && activePractice.id === n.practice.id);
        var isDone = n.type === "scene" ? n.index < sceneIndex : !!fired[n.practice.id];
        step.className = "step" + (isDone ? " done" : "") + (isCurrent ? " current" : "");
        step.dataset.type = n.type;
        var s = n.type === "scene" ? n.scene : null;
        var len = s ? Math.max(3, (s.end || duration) - s.start) : 10;
        step.style.flexGrow = n.type === "scene" ? String(Math.max(3, len)) : "0";
        var name = n.type === "scene" ? (s.title || s.id) : (n.practice.title || "Practice");
        step.title = n.type === "scene" ? (n.index + 1) + ". " + name + " · " + clock(s.start) : "Practice · " + name + " · " + clock(n.practice.trigger_at);
        step.setAttribute("aria-label", step.title);
        var track = document.createElement("span"); track.className = "step-track";
        var fill = document.createElement("span"); fill.className = "step-fill"; track.appendChild(fill);
        fills[n.type === "scene" ? "s" + n.index : "p" + n.practice.id] = fill;
        if (n.type === "scene") practice.forEach(function (p) {
          var within = p.trigger_at >= s.start && p.trigger_at < (s.end || duration);
          if (!within) return; var tick = document.createElement("span"); tick.className = "step-tick";
          tick.style.left = Math.min(96, Math.max(3, ((p.trigger_at - s.start) / Math.max(0.1, (s.end || duration) - s.start)) * 100)) + "%";
          tick.title = (p.title || "Practice") + " · " + clock(p.trigger_at); track.appendChild(tick);
        });
        var meta = document.createElement("span"); meta.className = "step-meta";
        var num = document.createElement("span"); num.className = "step-num"; num.textContent = n.type === "scene" ? String(n.index + 1).padStart(2, "0") : "★";
        var label = document.createElement("span"); label.className = "step-label"; label.textContent = name;
        meta.append(num, label); step.append(track, meta);
        step.addEventListener("click", function () { if (n.type === "scene") seekScene(n.index); else openPractice(n.practice, { manual: true }); });
        progress.appendChild(step);
        if (isDone) setFill(n.type === "scene" ? "s" + n.index : "p" + n.practice.id, 1);
      });
    }

    function saveResume(force) {
      var now = Date.now(); if (!force && now - lastSaved < 1000) return; lastSaved = now;
      try {
        if (state === State.FINISHED) { localStorage.removeItem(resumeKey); return; }
        localStorage.setItem(resumeKey, JSON.stringify({ version: contentVersion, t: Number(video.currentTime || 0), captions_on: captionsOn, saved_at: new Date().toISOString() }));
      } catch (_) {}
    }

    function playNarration(src) { stopNarration(); if (!src) return; narration.src = resolve(src); narration.play().catch(function () {}); }
    function stopNarration() { narration.pause(); narration.removeAttribute("src"); try { narration.load(); } catch (_) {} }

    function closePractice() {
      if (cleanupPractice) { try { cleanupPractice(); } catch (_) {} cleanupPractice = null; }
      practiceRoot.replaceChildren(); practiceBox.classList.add("hidden"); activePractice = null; stopNarration();
    }
    function openPractice(item, opts) {
      opts = opts || {};
      if (!item) return;
      if (activePractice && activePractice.id === item.id) return;
      closePractice();
      video.pause();
      if (opts.manual && Math.abs(video.currentTime - item.trigger_at) > 0.5) { try { video.currentTime = item.trigger_at; } catch (_) {} }
      activePractice = item; fired[item.id] = true;
      setState(State.PRACTICE);
      generation += 1; var token = generation;
      practiceBox.classList.remove("hidden"); $("skip-practice").classList.remove("hidden");
      setCaption(item.narration || item.instruction || "");
      sceneStatus(); paintRail();
      playNarration(item.audio_src);
      record("practice_open", { id: item.id, template: item.template, manual: !!opts.manual });
      try {
        if (!window.EduHarnessInteractive) throw new Error("Interactive runtime not loaded");
        cleanupPractice = window.EduHarnessInteractive.mountInteractive(practiceRoot, { template: item.template, parameters: item.parameters || {}, instruction: item.instruction || "" }, {
          onEvent: function (type, detail) { record("practice_" + type, Object.assign({ id: item.id }, detail || {})); },
          onSuccess: function (detail) { if (token !== generation) return; record("practice_success", Object.assign({ id: item.id }, detail || {})); resumeAfterPractice(); }
        });
      } catch (e) {
        var err = document.createElement("div"); err.className = "error"; err.textContent = "This practice could not be shown: " + (e.message || e); practiceRoot.appendChild(err);
        record("error", { message: String(e.message || e) });
      }
    }
    function resumeAfterPractice() {
      closePractice(); setState(State.WATCHING);
      sceneStatus(); paintRail(); setCaption((scenes[sceneIndex] || {}).narration);
      video.play().catch(function () {});
    }
    function skipPractice() { if (!activePractice) return; record("practice_skip", { id: activePractice.id }); resumeAfterPractice(); }

    function showFinished() {
      closePractice(); setState(State.FINISHED);
      setStatus([["complete", "badge ok"], [manifest.topic || "", "name"]]); setCaption("");
      practiceBox.classList.remove("hidden"); $("skip-practice").classList.add("hidden");
      var done = document.createElement("div"); done.className = "lesson-done";
      var head = document.createElement("strong"); head.textContent = "Lesson complete";
      var sub = document.createElement("span"); sub.textContent = scenes.length + " scenes · " + practice.length + " practice · " + clock(duration || video.duration);
      var again = document.createElement("button"); again.type = "button"; again.textContent = "Watch again"; again.addEventListener("click", restart);
      done.append(head, sub, again); practiceRoot.appendChild(done);
      Object.keys(fills).forEach(function (k) { setFill(k, 1); });
      record("lesson_finished", {}); saveResume(true);
    }

    function seekScene(i) {
      i = Math.max(0, Math.min(scenes.length - 1, i));
      closePractice();
      if (state === State.FINISHED || state === State.PRACTICE) setState(State.WATCHING);
      try { video.currentTime = scenes[i].start + 0.001; } catch (_) {}
      sceneIndex = i; sceneStatus(); paintRail(); setCaption(scenes[i].narration);
      record("seek_scene", { index: i });
      video.play().catch(function () {});
    }
    function restart() {
      fired = {}; closePractice(); try { localStorage.removeItem(resumeKey); } catch (_) {}
      setState(State.WATCHING); try { video.currentTime = 0; } catch (_) {}
      sceneIndex = 0; sceneStatus(); paintRail(); setCaption(scenes[0].narration); record("restart", {});
      video.play().catch(function () {});
    }

    function onTime() {
      var t = video.currentTime;
      var idx = sceneAt(t);
      if (idx !== sceneIndex) { sceneIndex = idx; paintRail(); if (!activePractice) setCaption(scenes[idx].narration); record("scene_enter", { index: idx, id: scenes[idx].id }); }
      scenes.forEach(function (s, i) { var end = s.end || (scenes[i + 1] ? scenes[i + 1].start : duration) || 1; setFill("s" + i, i < idx ? 1 : i > idx ? 0 : (t - s.start) / Math.max(0.1, end - s.start)); });
      if (!activePractice) sceneStatus();
      saveResume(false);
      if (activePractice || state === State.FINISHED) return;
      for (var k = 0; k < practice.length; k++) {
        var p = practice[k];
        if (fired[p.id]) continue;
        if (t >= p.trigger_at) {
          if (t - p.trigger_at > 2.5) { fired[p.id] = true; record("practice_passed_over", { id: p.id }); continue; }
          openPractice(p); break;
        }
      }
    }

    video.src = resolve(manifest.video.src);
    if (manifest.video.poster) video.poster = resolve(manifest.video.poster);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("seeking", function () { var t = video.currentTime; practice.forEach(function (p) { if (p.trigger_at > t + 0.2) delete fired[p.id]; else if (p.trigger_at < t - 1.0 && !activePractice) fired[p.id] = true; }); });
    video.addEventListener("play", function () { if (state !== State.PRACTICE) setState(State.WATCHING); if (activePractice) video.pause(); });
    video.addEventListener("ended", showFinished);
    video.addEventListener("error", function () { setState(State.ERROR); setStatus([["error", "badge caution"], ["The video could not be loaded", "name"]]); });
    video.addEventListener("loadedmetadata", function () { if (!duration && Number.isFinite(video.duration)) duration = video.duration; sceneStatus(); });

    $("next").addEventListener("click", function () { if (activePractice) skipPractice(); else if (sceneIndex >= scenes.length - 1) showFinished(); else seekScene(sceneIndex + 1); });
    $("prev").addEventListener("click", function () { seekScene(Math.max(0, activePractice ? sceneIndex : sceneIndex - 1)); });
    $("restart-lesson").addEventListener("click", restart);
    $("skip-practice").addEventListener("click", skipPractice);
    captionToggle.addEventListener("click", function () {
      captionsOn = !captionsOn; captionToggle.classList.toggle("active", captionsOn); captionToggle.setAttribute("aria-pressed", String(captionsOn));
      setCaption(activePractice ? (activePractice.narration || activePractice.instruction) : (scenes[Math.max(0, sceneIndex)] || {}).narration); saveResume(true);
    });
    var eventsButton = $("download-log");
    eventsButton.addEventListener("click", function () {
      var json = JSON.stringify(events, null, 2);
      try { var blob = new Blob([json], { type: "application/json" }); var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (manifest.bundle_id || "lesson") + "-events.json"; a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); }
      catch (_) { navigator.clipboard && navigator.clipboard.writeText(json); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.target && /INPUT|TEXTAREA|BUTTON/.test(e.target.tagName)) return;
      if (e.key === " ") { e.preventDefault(); if (activePractice) return; if (video.paused) video.play().catch(function () {}); else video.pause(); }
      if (e.key === "ArrowRight") { e.preventDefault(); if (!activePractice) seekScene(sceneIndex + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); if (!activePractice) seekScene(sceneIndex - 1); }
    });
    window.addEventListener("pagehide", function () { saveResume(true); });

    // resume
    var resumeButton = $("resume-last"), saved = null;
    try { saved = JSON.parse(localStorage.getItem(resumeKey) || "null"); } catch (_) {}
    if (saved && saved.version === contentVersion && Number(saved.t) > 3 && Number(saved.t) < duration - 1) {
      captionsOn = saved.captions_on !== false; captionToggle.classList.toggle("active", captionsOn); captionToggle.setAttribute("aria-pressed", String(captionsOn));
      resumeButton.classList.remove("hidden"); resumeButton.textContent = "Resume " + clock(saved.t);
      resumeButton.addEventListener("click", function () { resumeButton.classList.add("hidden"); try { video.currentTime = Number(saved.t); } catch (_) {} setState(State.WATCHING); video.play().catch(function () {}); });
    }
    sceneIndex = 0; sceneStatus(); paintRail(); setCaption(scenes[0].narration);
    setState(State.IDLE); record("player_ready", { scenes: scenes.length, practice: practice.length });
    window.StudioLessonPlayer = { get state() { return state; }, openPractice: openPractice, skipPractice: skipPractice, seekScene: seekScene, restart: restart, events: events, manifest: manifest };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
`;

const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const jsonForScript = v => JSON.stringify(v).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');

/**
 * The complete player page. `inline` = { files: { 'media/lesson.mp4': url|dataURL, ... }, runtime: '<js text>' } embeds
 * everything (standalone HTML / in-app preview); without it the page loads ./interactive-runtime.js and relative media.
 */
export function playerHtml(manifest, { inline = null, runtimeSrc = './interactive-runtime.js', title } = {}) {
  const t = title || manifest.topic || 'Lesson';
  const runtimeTag = inline?.runtime ? `<script>${inline.runtime.replace(/<\/script/gi, '<\\/script')}</script>` : `<script src="${escHtml(runtimeSrc)}"></script>`;
  const inlineTag = inline?.files ? `<script>window.STUDIO_INLINE = ${jsonForScript(inline.files)};</script>` : '';
  const captionsLink = manifest.captions && !inline ? `<a href="${escHtml(manifest.captions)}" download>Captions (.vtt)</a>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escHtml(t)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"/>
  <style>${PLAYER_CSS}</style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="brand-text"><h1 id="topic"></h1><p class="eyebrow" id="eyebrow">Interactive lesson</p></div>
    </div>
    <div class="header-actions">
      <button id="captions" class="ghost active" type="button" aria-pressed="true" title="Toggle captions">Captions</button>
      <button id="download-log" class="ghost" type="button" title="Download the interaction log">Events</button>
      <button id="resume-last" class="ghost hidden" type="button" title="Resume saved position">Resume</button>
      <button id="restart-lesson" class="ghost" type="button" title="Start the lesson over">Restart</button>
      <button id="prev" type="button">Back</button>
      <button id="next" type="button">Next</button>
    </div>
  </header>
  <main>
    <div class="stage-band">
      <div class="now-playing"><p class="status-label">Now playing</p><div id="status" role="status">Loading…</div></div>
      <div class="stage-wrap">
        <div id="stage" data-state="IDLE">
          <video id="video" playsinline controls preload="metadata"></video>
          <div id="practice" class="hidden"><div class="practice-bar"><button id="skip-practice" type="button" title="Skip this practice and continue the video">Skip</button></div><div id="practice-root"></div></div>
          <audio id="narration" preload="auto"></audio>
        </div>
        <div class="narration-block"><p class="narration-label">Narration</p><div id="caption" class="is-empty"></div></div>
      </div>
    </div>
    <div class="rail-band">
      <div class="rail-heading"><h2>Lesson chapters</h2><span>Select a chapter · ★ practice pauses the video</span></div>
      <nav id="progress" aria-label="Lesson progress"></nav>
    </div>
  </main>
  <footer><span>Video · narration · practice</span><span>${captionsLink}${captionsLink ? ' · ' : ''}Made with Instructional Agents Studio</span></footer>
  <script>window.STUDIO_MANIFEST = ${jsonForScript(manifest)};</script>
  ${inlineTag}
  ${runtimeTag}
  <script>${PLAYER_JS}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- bundles
const README = (manifest) => `${manifest.topic}
Interactive lesson bundle made with Instructional Agents Studio (${manifest.generated_at}).

Files
  index.html              the player (open it directly, or serve this folder over HTTP)
  interactive-runtime.js  the trusted practice runtime (multiple choice, sort, fill-in, number line, lever)
  manifest.json           scenes, practice items and timing
  media/                  the lecture video, practice narration and captions

Opening index.html from disk works in Chrome, Edge and Firefox. For an LMS, upload the whole folder and link to index.html.
Nothing in this bundle contacts a server; the player keeps a small resume point and an interaction log in the browser's localStorage.
`;

function toBlob(value, path) {
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value], { type: mimeOf(path) });
  if (typeof value === 'string' && value.startsWith('data:')) { const [head, b64] = value.split(','); const mime = head.slice(5).split(';')[0]; const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime || mimeOf(path) }); }
  return new Blob([String(value)], { type: `${mimeOf(path)};charset=utf-8` });
}
function blobToDataUrl(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error || new Error('read failed')); r.readAsDataURL(blob); }); }

/** ZIP bundle: index.html + interactive-runtime.js + manifest.json + README + every media file (relative paths). */
export async function buildLessonZip({ manifest, files = {} }) {
  const [JSZip, runtime] = await Promise.all([loadJSZip(), loadRuntimeText()]);
  const zip = new JSZip();
  zip.file('index.html', playerHtml(manifest));
  zip.file('interactive-runtime.js', runtime);
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('README.txt', README(manifest));
  for (const [path, value] of Object.entries(files)) { if (value == null) continue; zip.file(path, toBlob(value, path)); }
  return await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
}

/** Single-file player with every media file base64-inlined (large: roughly 4/3 of the media size). */
export async function standaloneHtml({ manifest, files = {} }) {
  const runtime = await loadRuntimeText();
  const inlineFiles = {};
  for (const [path, value] of Object.entries(files)) { if (value == null) continue; inlineFiles[path] = await blobToDataUrl(toBlob(value, path)); }
  const m = { ...manifest, captions: null };
  return new Blob([playerHtml(m, { inline: { files: inlineFiles, runtime } })], { type: 'text/html;charset=utf-8' });
}

/** Mount the player inside the Studio (iframe from a Blob URL; media served through blob: URLs). Returns { iframe, ready, destroy }. */
export function mountPlayerPreview(container, { manifest, files = {} }) {
  const urls = []; const inlineFiles = {};
  for (const [path, value] of Object.entries(files)) { if (value == null) continue; const u = URL.createObjectURL(toBlob(value, path)); urls.push(u); inlineFiles[path] = u; }
  const iframe = document.createElement('iframe');
  iframe.className = 'lesson-player-frame'; iframe.title = `${manifest.topic} — interactive lesson`; iframe.allow = 'autoplay; fullscreen';
  iframe.style.cssText = 'width:100%;aspect-ratio:16/11;min-height:520px;border:1px solid rgba(0,0,0,.08);border-radius:12px;background:#f7f5f0';
  container.append(iframe);
  const ready = loadRuntimeText().then(runtime => {
    const html = playerHtml({ ...manifest, captions: null }, { inline: { files: inlineFiles, runtime } });
    const u = URL.createObjectURL(new Blob([html], { type: 'text/html' })); urls.push(u); iframe.src = u;
    return iframe;
  });
  ready.catch(e => { iframe.srcdoc = `<p style="font:14px system-ui;padding:20px;color:#a33">The player could not be prepared: ${escHtml(e.message)}</p>`; });
  return { iframe, ready, destroy() { iframe.remove(); urls.forEach(u => URL.revokeObjectURL(u)); } };
}
