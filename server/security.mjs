// security.mjs — who may talk to the local server. It listens on 127.0.0.1 only; on top of that:
//   - a random token per launch, handed over once in the opened URL (?token=) and then kept in an HttpOnly,
//     SameSite=Strict cookie (or sent as Authorization: Bearer by scripts);
//   - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
//   - Origin, when present, must be the server's own (another port on localhost is same-site, so the cookie alone
//     would not stop it), and Sec-Fetch-Site must not be cross-site / same-site for the API.
import crypto from 'node:crypto';

export const COOKIE = 'ia_token';
export const newToken = () => crypto.randomBytes(24).toString('base64url');

export function createGuard({ token, port, allowHosts = [] }) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map(h => `http://${h}`));
  // opt-in extra hostnames (e.g. a private tunnel in front of the app): https only, token still required
  for (const h of allowHosts.map(x => String(x).trim().toLowerCase()).filter(Boolean)) { hosts.add(h); origins.add(`https://${h}`); }
  const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const cookieToken = req => { for (const part of String(req.headers.cookie || '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === COOKIE) return v.join('='); } return null; };
  const bearer = req => { const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/); return m ? m[1] : null; };
  return {
    origins,
    /** null when the request may proceed this far, else [status, message]. */
    checkHost(req) { return hosts.has(String(req.headers.host || '').toLowerCase()) ? null : [421, 'Unknown host']; },
    checkOrigin(req, { api = false } = {}) {
      const o = req.headers.origin;
      if (o !== undefined && !origins.has(o)) return [403, 'Cross-origin request refused'];
      const site = req.headers['sec-fetch-site'];
      if (api && site && site !== 'same-origin' && site !== 'none') return [403, 'Cross-site request refused'];
      return null;
    },
    authed(req) { return same(cookieToken(req), token) || same(bearer(req), token); },
    tokenMatches: t => same(t, token),
    cookie: () => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
  };
}
