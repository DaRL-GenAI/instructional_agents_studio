// llm.js — thin OpenAI-compatible client that runs entirely in the browser.
// Every call is streamed, timed, token-counted and handed to the audit log.

export class LLMError extends Error {
  constructor(message, detail) { super(message); this.detail = detail; }
}

function trimSlash(u) { return (u || '').replace(/\/+$/, ''); }

export function sha1Short(text) {
  // Non-cryptographic fingerprint used to detect stale inputs; stable per string.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export class LLMClient {
  constructor(settings) { this.settings = settings; }

  get headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.settings.apiKey) h['Authorization'] = `Bearer ${this.settings.apiKey}`;
    return h;
  }

  get base() { return trimSlash(this.settings.baseUrl || 'https://api.openai.com/v1'); }

  async listModels() {
    const r = await fetch(`${this.base}/models`, { headers: this.headers });
    if (!r.ok) throw new LLMError(`Model list failed (${r.status})`, await r.text());
    const j = await r.json();
    return (j.data || []).map(m => m.id).sort();
  }

  /**
   * Chat completion with streaming. onToken(text) receives incremental text.
   * Returns { text, usage:{prompt_tokens, completion_tokens, total_tokens}, durationMs, model }.
   */
  async chat(messages, { onToken, json = false, temperature, seed, signal, model } = {}) {
    const started = performance.now();
    const useModel = model || this.settings.model;
    const body = { model: useModel, messages, stream: true, stream_options: { include_usage: true } };
    if (temperature !== undefined && temperature !== null && temperature !== '') body.temperature = Number(temperature);
    if (seed !== undefined && seed !== null && seed !== '') body.seed = Number(seed);
    if (json) body.response_format = { type: 'json_object' };

    let r;
    try {
      r = await fetch(`${this.base}/chat/completions`, { method: 'POST', headers: this.headers, body: JSON.stringify(body), signal });
    } catch (e) {
      throw new LLMError(`Network error contacting ${this.base}: ${e.message}`);
    }
    if (!r.ok) {
      const detail = await r.text();
      // Some OpenAI-compatible servers reject json mode / stream_options; retry once without extras.
      if (r.status === 400 && (json || body.stream_options)) {
        delete body.response_format; delete body.stream_options;
        r = await fetch(`${this.base}/chat/completions`, { method: 'POST', headers: this.headers, body: JSON.stringify(body), signal });
        if (!r.ok) throw new LLMError(`API error ${r.status}`, await r.text());
      } else {
        throw new LLMError(`API error ${r.status}`, detail);
      }
    }

    let text = '';
    let usage = null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      const j = await r.json();
      text = j.choices?.[0]?.message?.content || '';
      usage = j.usage || null;
      onToken && onToken(text);
    } else {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) { text += delta; onToken && onToken(delta); }
          } catch { /* ignore keep-alives */ }
        }
      }
    }
    if (!usage) usage = { prompt_tokens: estimateTokens(messages.map(m => m.content).join('\n')), completion_tokens: estimateTokens(text), estimated: true };
    usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    return { text, usage, durationMs: Math.round(performance.now() - started), model: useModel };
  }

  /** Text-to-speech. Returns an ArrayBuffer of MP3 audio. */
  async speak(text, { voice, model, instructions, signal } = {}) {
    const body = { model: model || this.settings.ttsModel || 'gpt-4o-mini-tts', voice: voice || this.settings.voice || 'alloy', input: text, response_format: 'mp3' };
    if (instructions && (body.model || '').includes('gpt-4o')) body.instructions = instructions;
    const r = await fetch(`${this.base}/audio/speech`, { method: 'POST', headers: this.headers, body: JSON.stringify(body), signal });
    if (!r.ok) throw new LLMError(`TTS error ${r.status}`, await r.text());
    return await r.arrayBuffer();
  }
}

export function estimateTokens(s) { return Math.ceil((s || '').length / 4); }

/** Extract the first JSON array/object from a model response (mirrors the Python regex fallbacks). */
export function extractJson(text, want = 'any') {
  if (!text) throw new Error('Empty response');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { const v = JSON.parse(cleaned); return unwrap(v, want); } catch { /* fall through */ }
  const candidates = [];
  const openers = want === 'array' ? ['['] : want === 'object' ? ['{'] : ['[', '{'];
  for (const op of openers) {
    const cl = op === '[' ? ']' : '}';
    const start = cleaned.indexOf(op);
    const end = cleaned.lastIndexOf(cl);
    if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1));
  }
  for (const c of candidates) {
    try { return unwrap(JSON.parse(c), want); } catch { /* try next */ }
    try { return unwrap(JSON.parse(repairJson(c)), want); } catch { /* try next */ }
  }
  throw new Error('No valid JSON found in the response');
}

function unwrap(v, want) {
  if (want === 'array') return toArray(v);
  return v;
}

/** Coerce the many shapes models return in JSON mode into an array of items. */
export function toArray(v, depth = 0) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && depth < 2) { try { return toArray(JSON.parse(v), depth + 1); } catch { return []; } }
  if (!v || typeof v !== 'object') return [];
  // 1. the longest array of objects anywhere in the tree (e.g. {"chapter": "…", "deck": {"slides": [...]}})
  const arrays = [];
  const walk = (o, d) => { if (d > 4 || !o || typeof o !== 'object') return; for (const val of Object.values(o)) { if (Array.isArray(val)) arrays.push(val); else if (val && typeof val === 'object') walk(val, d + 1); } };
  walk(v, 0);
  const nonEmpty = arrays.filter(a => a.length);
  const objArrays = nonEmpty.filter(a => a.every(x => x && typeof x === 'object'));
  if (objArrays.length) return objArrays.reduce((a, b) => (a.length >= b.length ? a : b));
  // 2. a dictionary of items keyed by id (e.g. {"1": {...}, "2": {...}} or {"slides": {"slide_1": {...}}})
  const isItem = o => o && typeof o === 'object' && !Array.isArray(o) && ('title' in o || 'question' in o || 'slide_id' in o || 'narration' in o || 'latex' in o || 'bullets' in o || 'description' in o);
  const dicts = [];
  const walk2 = (o, d) => { if (d > 4 || !o || typeof o !== 'object') return; const vals = Object.values(o); if (vals.length && vals.every(isItem)) dicts.push(vals); for (const val of vals) if (val && typeof val === 'object' && !Array.isArray(val)) walk2(val, d + 1); };
  walk2(v, 0);
  if (dicts.length) return dicts.reduce((a, b) => (a.length >= b.length ? a : b));
  // 3. a single item
  if (isItem(v)) return [v];
  // 4. last resort: an array of primitives (callers decide whether it is usable)
  if (nonEmpty.length) return nonEmpty.reduce((a, b) => (a.length >= b.length ? a : b));
  return [];
}

function repairJson(s) {
  return s
    .replace(/,\s*([}\]])/g, '$1')       // trailing commas
    .replace(/[“”]/g, '"')      // smart quotes
    .replace(/[‘’]/g, "'");
}
