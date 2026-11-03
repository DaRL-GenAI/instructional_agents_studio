// agents/sessions.mjs — agent chats of one project, one JSON file each in .studio/sessions/ (not in git):
// { id, agent, title, createdAt, updatedAt, cli: { claude?: id, codex?: id }, messages: [{ role, text, at, ... }] }.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../projects.mjs';

export const AGENTS = ['builtin', 'claude', 'codex'];
const DIR = '.studio/sessions';
const MAX_MESSAGES = 400;
const idOk = id => typeof id === 'string' && /^[a-z0-9]{6,32}$/.test(id);
const file = (root, id) => { if (!idOk(id)) throw new HttpError(400, 'Bad session id'); return path.join(root, DIR, `${id}.json`); };

function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); }

export function create(root, { agent = 'builtin', title = '' } = {}) {
  if (!AGENTS.includes(agent)) throw new HttpError(400, 'Unknown agent');
  const now = new Date().toISOString();
  const s = { id: crypto.randomBytes(6).toString('hex'), agent, title: String(title).slice(0, 120), createdAt: now, updatedAt: now, cli: {}, messages: [] };
  writeJson(file(root, s.id), s); return s;
}
export function get(root, id) {
  let t; try { t = fs.readFileSync(file(root, id), 'utf8'); } catch (e) { if (e.code === 'ENOENT') throw new HttpError(404, 'No such chat'); throw e; }
  return JSON.parse(t);
}
/** Newest first, without the messages. */
export function list(root) {
  let names; try { names = fs.readdirSync(path.join(root, DIR)).filter(n => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) { try { const s = JSON.parse(fs.readFileSync(path.join(root, DIR, n), 'utf8')); out.push({ id: s.id, agent: s.agent, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, count: s.messages.length }); } catch { /* skip a broken file */ } }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
/** Change a session: fn(session) mutates it. */
export function update(root, id, fn) {
  const s = get(root, id); fn(s);
  if (s.messages.length > MAX_MESSAGES) s.messages.splice(0, s.messages.length - MAX_MESSAGES);
  if (!s.title) s.title = (s.messages.find(m => m.role === 'user')?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  s.updatedAt = new Date().toISOString(); writeJson(file(root, id), s); return s;
}
/** What the browser may set (the built-in agent keeps its own transcript; the panel records reviews). */
export function put(root, id, body) {
  return update(root, id, s => {
    if (Array.isArray(body.messages)) s.messages = body.messages.filter(m => m && typeof m === 'object' && ['user', 'assistant'].includes(m.role)).map(m => ({ ...m, text: String(m.text ?? '').slice(0, 200000) }));
    if (typeof body.title === 'string') s.title = body.title.slice(0, 120);
    if (AGENTS.includes(body.agent) && !s.messages.length) s.agent = body.agent;
  });
}
export function remove(root, id) { fs.rmSync(file(root, id), { force: true }); }
