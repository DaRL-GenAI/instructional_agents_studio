// llmproxy.mjs — model API calls from the page, forwarded by the local server. Many OpenAI-compatible endpoints
// (self-hosted, campus gateways) send no CORS headers, so the browser cannot call them directly; the local app
// sends them here instead (same origin, session cookie). The target is the API URL the page names in X-IA-Target.
import { Readable } from 'node:stream';
import { HttpError } from './projects.mjs';

const PASS_UP = ['authorization', 'content-type', 'accept', 'openai-organization', 'openai-project', 'api-key', 'x-api-key', 'anthropic-version'];
const PASS_DOWN = ['content-type', 'cache-control', 'x-request-id', 'openai-processing-ms'];

export async function forward(req, res) {
  let target; try { target = new URL(String(req.headers['x-ia-target'] || '')); } catch { throw new HttpError(400, 'X-IA-Target must be the API URL'); }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw new HttpError(400, 'Only http(s) API URLs');
  const headers = {}; for (const h of PASS_UP) if (req.headers[h]) headers[h] = req.headers[h];
  const ac = new AbortController(); res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  let up;
  try { up = await fetch(target, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? 'half' : undefined, signal: ac.signal, redirect: 'follow' }); }
  catch (e) { if (ac.signal.aborted) return res.end(); throw new HttpError(502, `Could not reach ${target.origin}: ${e.cause?.code || e.message}`); }
  const out = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  for (const h of PASS_DOWN) { const v = up.headers.get(h); if (v) out[h] = v; }
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}
