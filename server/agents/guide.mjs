// agents/guide.mjs — AGENTS.md (read by Codex and most agents) and CLAUDE.md (Claude Code; imports AGENTS.md) at the
// project root: the folder layout, which file backs which stage, and the editing rules. Both are managed files:
// regenerated whenever the layout changes, never overwritten when the user put their own file there.
import { FOUNDATION, CHAPTER_STAGES, EXAMS } from '../../js/prompts.js';

export const MARK = '<!-- Managed by Instructional Agents: regenerated when the course layout changes. Do not edit. -->';
export const GUIDE_FILES = ['AGENTS.md', 'CLAUDE.md'];
export const isManagedGuide = text => typeof text === 'string' && text.startsWith(MARK);

const name = (list, id) => list.find(x => x.id === id)?.name || id;

/** Stage key → a readable label. */
export function stageLabel(project, key) {
  const [a, b, c] = key.split('.');
  if (a === 'foundation') return `Course design: ${name(FOUNDATION, b)}`;
  if (a === 'chaptersStage') return 'Course design: chapter list';
  if (a === 'exams') return name(EXAMS, b);
  if (a === 'chapters') { const i = (project.chapters || []).findIndex(ch => ch.id === b); const ch = project.chapters?.[i]; return `Chapter ${i + 1}${ch?.title ? ` (${ch.title})` : ''}: ${name(CHAPTER_STAGES, c)}`; }
  return key;
}

/** { 'AGENTS.md': text, 'CLAUDE.md': text } for a project and its serialized meta. */
export function guideFiles(project, meta) {
  const rows = Object.entries(meta.stages || {}).map(([key, m]) => [m.$file || m.$deck, key]).filter(([f]) => f).sort((x, y) => x[0].localeCompare(y[0]));
  const kept = Array.isArray(meta.sources) ? meta.sources : [];
  const inPlace = kept.length ? `\n- Source materials kept where they were (read-only, like \`sources/\`): ${kept.slice(0, 40).map(f => `\`${f}\``).join(', ')}${kept.length > 40 ? ` and ${kept.length - 40} more (listed in .studio/meta.json "sources")` : ''}` : '';
  const chapters = (meta.chapters || []).map((c, i) => `  - \`${c.$dir}/\`: chapter ${i + 1}, ${c.title || 'untitled'}`);
  const agents = `${MARK}
# ${project.course?.name || project.name || 'Course'}: course project

This folder is an Instructional Agents course (a git repository). The Studio app (\`npx instructional-agents\`) edits it and
commits every change; the files below are what the app reads back, so keep their names and formats.

## Layout
- \`design/\`: course design (learning objectives, learner analysis, syllabus, assessment plan, final project, chapter list)
- \`chapters/NN-slug/\`: one folder per chapter: \`outline.json\`, \`slides.pptx\`, \`script.md\` or \`.json\`, \`homework.md\` or \`.docx\`, \`lab\`, \`quiz.json\`, \`storyboard.json\`
${chapters.join('\n') || '  - (no chapters yet)'}
- \`exams/\`: midterm and final exams
- \`sources/\`: original materials the instructor imported (read-only)${inPlace}
- \`build/\`: exported PDFs, audio and video (not in git)
- \`course.json\`: course facts (managed by the app)
- \`.studio/\`: the app's own state (versions, history, audit trail)

## Files that back stages
| File | Stage |
|---|---|
${rows.map(([f, key]) => `| \`${f}\` | ${stageLabel(project, key)} |`).join('\n') || '| (none yet) | |'}

## Editing rules
- Edit files in place and keep their format: Markdown stays Markdown, JSON stays valid JSON with the same structure.
- Slides (\`.pptx\`): change only the slides you were asked about. Keep the deck's design (layouts, theme, fonts,
  colors, positions); keep text inside its boxes; update the speaker notes of every slide whose content changes.
- Word files (\`.docx\`): change only the paragraphs in scope and keep their styles.
- \`sources/\`${kept.length ? ' and the source materials kept in place are' : ' is'} read-only: read them for context, never change them.
- Do not modify \`.studio/\` (the app's scratch space \`.studio/jobs/\` excepted), \`course.json\`, \`AGENTS.md\` or \`CLAUDE.md\`.
- Do not run git commands that change the repository; the app commits after the instructor reviews your changes.
- No network access is needed.
`;
  const claude = `${MARK}
@AGENTS.md
`;
  return { 'AGENTS.md': agents, 'CLAUDE.md': claude };
}
