// fs/api.js — talking to the local server (npx instructional-agents). LOCAL is set by the server in index.html;
// on GitHub Pages it is null and nothing here runs.
export const LOCAL = globalThis.__IA_LOCAL__ || null;

export class ApiError extends Error { constructor(message, status, body) { super(message); this.status = status; this.body = body; this.conflict = status === 409; } }

/** fetch against the same origin (the session cookie authenticates); JSON in and out unless raw. */
export async function api(path, { method = 'GET', body, raw = false, headers = {}, signal } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) init.body = body;
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(path, init);
  if (!r.ok) { const j = await r.json().catch(() => null); throw new ApiError(j?.error || `Local server error ${r.status}`, r.status, j); }
  if (raw) return r;
  return r.status === 204 ? null : r.json();
}

// ---------------------------------------------------------------- change feed (/ws)
const listeners = new Set();
let socket = null, retry = 500;
export function onServerEvent(fn) { listeners.add(fn); connect(); return () => listeners.delete(fn); }
function connect() {
  if (!LOCAL || socket) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onopen = () => { retry = 500; };
  socket.onmessage = e => { let ev; try { ev = JSON.parse(e.data); } catch { return; } for (const fn of listeners) try { fn(ev); } catch (err) { console.warn(err); } };
  socket.onclose = () => { socket = null; setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); };
}
