// agent/builtin.js — the built-in agent: a tool-calling loop over LLMClient (any OpenAI-compatible endpoint). It reads
// the project through the Workspace's file source (the folder in the local app, the virtual tree in the browser
// edition) and never writes it: every write goes to an in-memory overlay that the panel shows for review. Models
// that reject `tools` get the same tools through a fixed JSON protocol.
import { extractJson } from '../llm.js';

export const MAX_STEPS = 14;
const TEXT_WRITABLE = /\.(md|markdown|txt|json|jsonl|ya?ml|tex|bib|csv|tsv)$/i;
const MAX_READ = 40000;

/** Why the agent may not write `path` (or null). */
export function writeRefusal(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) return 'paths are relative to the project and stay inside it';
  if (/^sources(\/|$)/.test(path)) return 'sources/ is read-only';
  if (/^(\.studio|\.git)(\/|$)/.test(path) || ['course.json', 'AGENTS.md', 'CLAUDE.md'].includes(path)) return 'managed by the app';
  if (!TEXT_WRITABLE.test(path)) return 'write_file writes text files (.md, .json, .yaml, .tex, .txt, .csv); use the macro tool for the open slides or document';
  return null;
}

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
export function toolsFor(office) {
  const t = [
    fn('list_files', 'List the project files (paths relative to the project root).', { dir: { type: 'string', description: 'Only under this folder' } }),
    fn('read_file', 'Read a file. Text files come back as text (optionally a line range); .pptx as the text of every slide; .docx as Markdown.', { path: { type: 'string' }, from_line: { type: 'integer' }, to_line: { type: 'integer' } }, ['path']),
    fn('search', 'Find lines containing a phrase in the project text files.', { query: { type: 'string' } }, ['query']),
    fn('write_file', 'Replace the whole content of a text file (or create it). The instructor reviews every change before it is applied.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  ];
  if (office?.format === 'pptx') t.push(fn('run_slide_macro', `Run ONLYOFFICE Document Builder JavaScript in the open presentation ${office.path} and return its result. Use Api.GetPresentation(), GetSlideByIndex(i) (0-based), GetAllShapes(), shape.GetDocContent().GetElement(i).GetText(), paragraph.RemoveAllElements(), paragraph.AddText(text), slide.GetNotesPage().GetBodyShape(). Keep the design; edit text only. "return" a value to read.`, { code: { type: 'string' } }, ['code']));
  if (office?.format === 'docx') t.push(fn('run_doc_macro', `Run ONLYOFFICE Document Builder JavaScript in the open document ${office.path} and return its result. Use Api.GetDocument(), GetElementsCount(), GetElement(i) (0-based), paragraph.GetText(), paragraph.RemoveAllElements(), paragraph.AddText(text), Api.CreateParagraph(), doc.InsertContent([p]) / doc.Push(p). Keep styles. "return" a value to read.`, { code: { type: 'string' } }, ['code']));
  return t;
}

const SYSTEM = `You are the built-in agent of Instructional Agents Studio, working on one course project with the instructor.
Use the tools to look at the files you need, then make the requested change with write_file (or the macro tool for the
open slides/document). Change only what the instructor asked for, keep each file's format and structure (JSON stays valid
JSON with the same shape), and do not invent facts beyond the course material. Every change is reviewed before it is applied.
When you are done, answer with a short summary of what you changed (or your answer, when nothing needed changing).`;

const JSON_PROTOCOL = `Answer with exactly one JSON object per turn and nothing else:
{"tool": "<name>", "args": {...}} to use a tool (its result comes back in the next message), or
{"final": "<your summary for the instructor>"} when you are done.`;

/**
 * Run one turn. env: { llm, model, src: { list, read, search }, office: { path, format, macro(code), save(), reopen() } | null,
 *   readText(path, blob) → text for .pptx/.docx, guide: AGENTS.md text | null }
 * Returns { text, overlay: Map(path → string), steps, usage }.
 */
export async function runBuiltin({ env, history = [], message, context = [], onStep = () => {}, signal, maxSteps = MAX_STEPS, overlay = new Map(), log = () => {} }) {
  const tools = toolsFor(env.office);
  const steps = []; let officeTouched = false;
  const step = s => { steps.push(s); onStep(s); };
  const ctxText = context.length ? `\n\nIn scope (the instructor's current file and selection):\n${context.map(c => `- ${c.path}${c.label && c.label !== c.path ? ` (${c.label})` : ''}${c.text ? `:\n\`\`\`\n${c.text.slice(0, 6000)}\n\`\`\`` : ''}`).join('\n')}` : '';
  const sys = `${SYSTEM}${env.guide ? `\n\nThe project's guide (AGENTS.md):\n${env.guide.slice(0, 12000)}` : ''}`;
  const msgs = [{ role: 'system', content: sys }, ...history.filter(m => m.text).slice(-12).map(m => ({ role: m.role, content: m.text })), { role: 'user', content: `${message}${ctxText}` }];

  const exec = async (name, args = {}) => {
    if (name === 'list_files') {
      const { entries } = await env.src.list();
      const dir = String(args.dir || '').replace(/^\/+|\/+$/g, '');
      const files = entries.filter(e => !e.dir && !/^(\.git|\.studio|build)(\/|$)/.test(e.path) && (!dir || e.path.startsWith(`${dir}/`))).map(e => e.path);
      for (const p of overlay.keys()) if (!files.includes(p) && overlay.get(p) !== null) files.push(`${p} (new)`);
      return files.slice(0, 500).join('\n') || '(no files)';
    }
    if (name === 'read_file') {
      const p = String(args.path || '');
      let text;
      if (overlay.has(p)) text = overlay.get(p);
      else {
        const r = await env.src.read(p); if (!r) return `No such file: ${p}`;
        text = /\.(pptx|docx)$/i.test(p) ? await env.readText(p, r.blob) : await r.blob.text();
      }
      if (args.from_line || args.to_line) { const l = text.split('\n'); const a = Math.max(1, args.from_line || 1), b = Math.min(l.length, args.to_line || l.length); text = l.slice(a - 1, b).map((x, i) => `${a + i}: ${x}`).join('\n'); }
      return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n… (${text.length - MAX_READ} more characters; read a line range)` : text;
    }
    if (name === 'search') {
      const q = String(args.query || '').trim(); if (!q) return 'Empty query';
      const hits = await env.src.search(q);
      return hits.filter(h => h.line).slice(0, 60).map(h => `${h.path}:${h.line}: ${h.text.trim()}`).join('\n') || 'No matches';
    }
    if (name === 'write_file') {
      const p = String(args.path || ''); const why = writeRefusal(p); if (why) return `Refused: ${why}`;
      const content = String(args.content ?? '');
      if (/\.json$/i.test(p)) { try { JSON.parse(content); } catch (e) { return `Refused: not valid JSON (${e.message})`; } }
      overlay.set(p, content);
      return `Saved ${p} for review (${content.split('\n').length} lines).`;
    }
    if (name === 'run_slide_macro' || name === 'run_doc_macro') {
      if (!env.office || (name === 'run_slide_macro') !== (env.office.format === 'pptx')) return 'Refused: this tool works on the open presentation or document only';
      officeTouched = true;
      const out = await env.office.macro(String(args.code || ''));
      return JSON.stringify(out ?? null).slice(0, MAX_READ);
    }
    return `Unknown tool ${name}`;
  };
  const describe = (name, a = {}) => name === 'write_file' ? `write ${a.path}` : name === 'read_file' ? `read ${a.path}${a.from_line ? `:${a.from_line}-${a.to_line || ''}` : ''}` : name === 'search' ? `search “${a.query}”` : name === 'list_files' ? `list ${a.dir || 'files'}` : name.replace(/_/g, ' ');

  let mode = env.forceJson ? 'json' : 'tools'; let text = ''; const usage = { total_tokens: 0 };
  if (mode === 'json') msgs[0].content += `\n\nTools: ${JSON.stringify(tools.map(t => ({ name: t.function.name, description: t.function.description, args: t.function.parameters.properties })))}\n${JSON_PROTOCOL}`;
  try {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      if (i >= maxSteps) { text = `Stopped after ${maxSteps} steps.${text ? ` ${text}` : ''}`; break; }
      if (mode === 'tools') {
        let r;
        try { r = await env.llm.chatTools(msgs, { tools, signal, model: env.model }); }
        catch (e) {
          if (e.name === 'AbortError' || !(e.status >= 400 && e.status < 500) || e.status === 401 || e.status === 403 || e.status === 429) throw e;
          mode = 'json'; msgs[0].content += `\n\nTools: ${JSON.stringify(tools.map(t => ({ name: t.function.name, description: t.function.description, args: t.function.parameters.properties })))}\n${JSON_PROTOCOL}`;
          step('tools not supported: using JSON actions'); i--; continue;
        }
        usage.total_tokens += r.usage?.total_tokens || 0; log(r);
        const m = r.message; const calls = m.tool_calls || [];
        if (!calls.length) { text = (m.content || '').trim(); break; }
        msgs.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
        for (const c of calls) {
          let args = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* bad args → the tool says so */ }
          step(describe(c.function?.name, args));
          let out; try { out = await exec(c.function?.name, args); } catch (e) { out = `Error: ${e.message}`; }
          msgs.push({ role: 'tool', tool_call_id: c.id, content: String(out) });
        }
      } else {
        const r = await env.llm.chat(msgs, { json: true, signal, model: env.model });
        usage.total_tokens += r.usage?.total_tokens || 0; log(r);
        let j; try { j = extractJson(r.text, 'object'); } catch { j = null; }
        if (!j || (!j.tool && j.final === undefined)) { if (r.text.trim() && !/^\s*[{[]/.test(r.text)) { text = r.text.trim(); break; } msgs.push({ role: 'assistant', content: r.text }, { role: 'user', content: `Not understood. ${JSON_PROTOCOL}` }); continue; }
        if (j.final !== undefined) { text = String(j.final).trim(); break; }
        step(describe(j.tool, j.args));
        let out; try { out = await exec(j.tool, j.args || {}); } catch (e) { out = `Error: ${e.message}`; }
        msgs.push({ role: 'assistant', content: JSON.stringify(j) }, { role: 'user', content: `Result of ${j.tool}:\n${out}` });
      }
    }
  } finally {
    // macros edited the open document: take the result for review, and put the editor back as it was
    if (officeTouched) {
      try { const { file } = await env.office.save(); overlay.set(env.office.path, file); } catch (e) { step(`could not read the edited document: ${e.message}`); }
      try { await env.office.reopen(); } catch { /* the tab reloads from disk on its own */ }
    }
  }
  return { text, overlay, steps, usage };
}
