// export.js — downloads and the project ZIP bundle.
import { FOUNDATION, CHAPTER_STAGES, EXAMS } from './prompts.js';
import { deckOf, deckToPptx, resolveTheme } from './deck.js';
import { safeJson } from './pipeline.js';

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}
export const textBlob = (s, type = 'text/plain') => new Blob([s], { type: `${type};charset=utf-8` });

let zipLoading;
export async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  zipLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = res; s.onerror = () => rej(new Error('Could not load JSZip from cdnjs')); document.head.appendChild(s); });
  await zipLoading; return window.JSZip;
}

export const slug = s => String(s || 'untitled').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'untitled';

export function scriptMarkdown(chapter, script) {
  return `# Lecture script — ${chapter.title}\n\n` + script.map(s => `## Slide ${s.slide_id}: ${s.title}\n\n${s.narration}\n`).join('\n');
}

/** Bundle every deliverable, the prompts and the audit trail. media = {chapterId: {audios, video:{blob,mime}, vtt}} */
export async function buildZip(project, media = {}) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();
  const root = zip.folder(slug(project.course.name || 'course'));
  const course = root.folder('course');
  for (const f of FOUNDATION) {
    const st = project.foundation[f.id];
    if (st?.output) course.file(f.file, st.output);
    if (st?.transcript?.length) course.file(`transcripts/${f.id}.md`, transcriptMarkdown(f.name, st));
  }
  if (project.chapters.length) course.file('chapters.json', JSON.stringify(project.chapters.map(c => ({ title: c.title, description: c.description })), null, 2));
  for (const [i, ch] of project.chapters.entries()) {
    const dir = root.folder(`chapters/${String(i + 1).padStart(2, '0')}_${slug(ch.title)}`);
    const slides = deckOf(ch.stages.slides?.output).slides.length ? true : null;
    const script = safeJson(ch.stages.script?.output, []);
    for (const s of CHAPTER_STAGES) {
      const st = ch.stages[s.id]; if (!st?.output) continue;
      if (s.kind === 'md' || s.kind === 'json') dir.file(s.file, st.output);
      if (s.kind === 'quiz') { dir.file('quiz.json', st.output); dir.file('quiz.md', quizMarkdown(ch, safeJson(st.output, []))); }
      if (s.kind === 'slides') dir.file('slides.json', st.output);
      if (s.kind === 'script') { dir.file('script.json', st.output); dir.file('script.md', scriptMarkdown(ch, script)); }
      if (st.transcript?.length) dir.file(`transcripts/${s.id}.md`, transcriptMarkdown(s.name, st));
    }
    if (slides) {
      try { const deck = deckOf(ch.stages.slides.output); if (deck.slides.length) dir.file('slides.pptx', await deckToPptx(deck, resolveTheme(deck.theme, project.deck), { course: project.course.name, chapter: ch.title }, script)); }
      catch (e) { dir.file('slides_pptx_error.txt', String(e.message || e)); }
    }
    const m = media[ch.id];
    if (m?.vtt) dir.file('captions.vtt', m.vtt);
    if (m?.video?.blob) dir.file(`lecture.${m.video.mime.includes('mp4') ? 'mp4' : 'webm'}`, m.video.blob);
    if (m?.audios) m.audios.forEach((a, j) => { if (a?.buffer) dir.file(`narration/slide_${String(j + 1).padStart(2, '0')}.mp3`, a.buffer); });
  }
  for (const ex of EXAMS) { const st = project.exams?.[ex.id]; if (st?.output) course.file(ex.file, st.output); if (st?.transcript?.length) course.file(`transcripts/${ex.id}.md`, transcriptMarkdown(ex.name, st)); }
  root.file('audit_log.json', JSON.stringify(project.audit, null, 2));
  root.file('audit_log.md', auditMarkdown(project));
  root.file('project.json', JSON.stringify(project, null, 2));
  root.file('README.md', `# ${project.course.name}\n\nGenerated with Instructional Agents Studio (browser edition) on ${new Date().toISOString()}.\n\n- course/: ADDIE foundation deliverables and the full agent transcripts\n- chapters/: per-chapter outline, slides (json + pptx), script, homework, lab, quiz, captions, narration and video\n- audit_log.*: every model call, edit and export with hashes\n- project.json: re-importable project state\n`);
  return await zip.generateAsync({ type: 'blob' });
}

export function transcriptMarkdown(name, stage) {
  const lines = [`# ${name} — agent transcript`, '', `Run at: ${stage.ranAt || 'n/a'} · version ${stage.version} · ${stage.usage?.total_tokens ?? '?'} tokens · ${stage.durationMs} ms`, ''];
  for (const t of stage.transcript) {
    lines.push(`## ${t.role}`, '', '**System prompt**', '', '```', t.system, '```', '', '**User prompt**', '', '```', t.user, '```', '', '**Response**', '', t.text, '');
  }
  return lines.join('\n');
}

export function auditMarkdown(project) {
  const rows = project.audit.map(a => `| ${a.id} | ${a.ts} | ${a.type} | ${a.where || ''} | ${a.stage || ''} | ${a.agent || a.model || ''} | ${a.status || ''} | ${a.tokens ?? a.chars ?? ''} | ${a.ms ?? ''} | ${a.hash || a.responseHash || ''} |`);
  return `# Audit log — ${project.course.name}\n\n| # | time | type | where | stage | agent/model | status | tokens/chars | ms | hash |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`;
}

export function quizMarkdown(chapter, quiz) {
  const q = quiz.map((x, i) => `### ${i + 1}. ${x.question}\n\n${x.options.map(o => `- ${o}`).join('\n')}${x.options.length ? '\n' : ''}`).join('\n');
  const key = quiz.map((x, i) => `${i + 1}. **${x.answer}** — ${x.explanation}${x.objective ? ` _(objective: ${x.objective})_` : ''}`).join('\n');
  return `# Quiz — ${chapter.title}\n\n${q}\n\n---\n\n## Answer key (instructor only)\n\n${key}\n`;
}
