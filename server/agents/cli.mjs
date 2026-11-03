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
