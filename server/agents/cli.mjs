// agents/cli.mjs — Claude Code and Codex as command lines, and their JSON event streams as progress lines.
// (Ported from the old bridge/studio-bridge.mjs; the agent now runs in the project folder instead of a bwrap jail.)
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const HOME = os.homedir();
// Started from a desktop launcher, PATH can be bare; the agent CLIs usually install into ~/.local/bin.
export const searchPath = () => [...new Set([...(process.env.PATH || '').split(path.delimiter), path.join(HOME, '.local', 'bin'), path.join(HOME, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(path.delimiter);
export function which(bin) {
  for (const d of searchPath().split(path.delimiter)) { const f = path.join(d, bin); try { fs.accessSync(f, fs.constants.X_OK); return fs.realpathSync(f); } catch { /* next */ } }
  return null;
}
export function version(bin) { const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 }); return r.status === 0 ? r.stdout.trim().split('\n')[0] : null; }
export const available = () => ({ claude: which('claude'), codex: which('codex') });

/** The instruction for one slide revision. `rel`: the deck copy, relative to the project folder (the agent's cwd). */
export function revisePrompt({ slides, instruction, chapter }, rel) {
  return `You are editing a lecture slide deck: ${rel}${chapter ? ` (chapter: ${chapter})` : ''}.
Task: ${instruction}
Slides in scope (1-based, current order): ${slides.join(', ')}.
- Change only the slides in scope. You may add, delete or reorder slides when the task calls for it; leave every other slide untouched.
- Keep the deck's design: reuse its layouts, fonts, colors and positions; keep text inside its boxes; update the speaker notes of slides whose content changes.
- The working directory is the course project. Read its other files (design/, chapters/, exams/) for context if useful, but do not modify anything except ${rel} and the summary file below.
- A .pptx is a zip of XML parts: edit ppt/slides/slideN.xml (the order is in ppt/presentation.xml and its _rels) with any tool you have, e.g. python-pptx if installed, or unzip / edit / zip. Save the result over ${rel}.
- Finally write one sentence describing what you changed to ${path.posix.dirname(rel)}/summary.txt.
- No network access is needed.`;
}

/** argv for the agent; cwd is the project folder. Write access stays inside it (acceptEdits / workspace-write). */
export function agentCommand(agent, bin, prompt, cwd) {
  if (agent === 'claude') return [bin, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash', '--disallowedTools', 'WebFetch,WebSearch'];
  return [bin, 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', cwd, prompt];
}

/** One line of agent output → a short progress line (string), a final { result, error }, or null. */
export function progressOf(agent, line) {
  let j; try { j = JSON.parse(line); } catch { return null; }
  const clip = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (agent === 'claude') {
    if (j.type === 'assistant') for (const c of j.message?.content || []) {
      if (c.type === 'tool_use') return c.name === 'Bash' ? `$ ${clip(c.input?.description || c.input?.command)}` : `${c.name} ${clip(c.input?.file_path || c.input?.pattern || '')}`;
      if (c.type === 'text' && c.text.trim()) return clip(c.text);
    }
    if (j.type === 'result') return { result: j.result || '', error: j.is_error ? (j.result || j.subtype) : null };
    return null;
  }
  const item = j.item || j.msg || {};
  if (/item\.(started|completed)/.test(j.type || '')) {
    if (item.type === 'command_execution' && j.type === 'item.started') return `$ ${clip(item.command)}`;
    if (item.type === 'agent_message' && j.type === 'item.completed') return clip(item.text);
  }
  if (j.type === 'turn.failed' || j.type === 'error') return { error: clip(j.error?.message || j.message || 'Codex failed') };
  return null;
}

// ---------------------------------------------------------------- the agent panel (a chat over a copy of the project)
/** argv for one panel turn in `cwd` (the job copy); `resume`: the CLI's session id from the previous turn. */
export function panelCommand(agent, bin, prompt, cwd, resume = null) {
  if (agent === 'claude') return [bin, '-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash', '--disallowedTools', 'WebFetch,WebSearch', ...(resume ? ['--resume', resume] : [])];
  // `exec resume` takes no -C/--sandbox: the cwd comes from the process, the sandbox from a config override
  if (resume) return [bin, 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', resume, prompt];
  return [bin, 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', cwd, prompt];
}

/** One event line → { step?, text?, session?, error?, final? } (null when nothing to show). */
export function eventOf(agent, line) {
  let j; try { j = JSON.parse(line); } catch { return null; }
  const out = {};
  if (agent === 'claude') {
    if (j.session_id && (j.type === 'system' || j.type === 'result')) out.session = j.session_id;
    if (j.type === 'result') { out.final = true; if (j.is_error) out.error = String(j.result || j.subtype || 'Claude Code failed').slice(0, 600); else out.text = j.result || ''; }
  } else {
    if (j.type === 'thread.started' && j.thread_id) out.session = j.thread_id;
    const item = j.item || {};
    if (j.type === 'item.completed' && item.type === 'agent_message') out.text = item.text || '';
    if (j.type === 'turn.failed' || j.type === 'error') out.error = String(j.error?.message || j.message || 'Codex failed').slice(0, 600);
  }
  const p = progressOf(agent, line);
  if (typeof p === 'string' && !(agent === 'codex' && out.text)) out.step = p;
  return Object.keys(out).length ? out : null;
}

const clipText = (s, n) => String(s ?? '').slice(0, n);
/** The instruction for one panel turn. context: [{ path, label, slides?, lines?, text? }] from the editor. */
export function panelPrompt({ message, context = [], resumed = false }) {
  const ctx = context.slice(0, 20).map(c => {
    const where = c.slides?.length ? ` (slide${c.slides.length > 1 ? 's' : ''} ${c.slides.join(', ')})` : c.lines ? ` (lines ${c.lines[0]}-${c.lines[1]})` : c.paragraphs?.length ? ` (paragraph${c.paragraphs.length > 1 ? 's' : ''} ${c.paragraphs.join(', ')})` : '';
    return `- ${clipText(c.path, 400)}${where}${c.text ? `:\n\`\`\`\n${clipText(c.text, 6000)}\n\`\`\`` : ''}`;
  });
  return `${clipText(message, 20000)}
${ctx.length ? `\nIn scope (the instructor's current file and selection):\n${ctx.join('\n')}\n` : ''}${resumed ? '' : `
You are working in a copy of the course project (read AGENTS.md for its layout and rules). Edit the files here in
place: the instructor reviews every change before it is applied to the real project. sources/ and .studio/ are
read-only. Put scratch files in .scratch/ (discarded). Finish with a short summary of what you changed.`}`;
}
