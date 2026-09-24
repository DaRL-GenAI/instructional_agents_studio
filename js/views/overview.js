// views/overview.js — project dashboard: where you are in each module and what to do next.
import { el, button, icon, badge, fmtRel, fmtInt } from '../ui.js';
import { moduleProgress, projectTotals, MODULES } from '../state.js';
import { FOUNDATION, CHAPTER_STAGES } from '../prompts.js';
import { href, go } from '../router.js';

export function render(ctx) {
  const p = ctx.store.project; const prog = moduleProgress(p); const totals = projectTotals(p);
  const page = el('div', { class: 'page' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, p.name), el('p', {}, `${p.course.subject || 'Subject not set'} · ${p.course.level} · ${p.course.weeks} weeks · ${p.course.language}`)), el('div', { class: 'btn-row' }, button({ label: 'Export everything', icon: 'download', onClick: () => ctx.exportAll() }))));

  const next = nextAction(ctx);
  if (next) page.append(el('div', { class: 'panel', style: 'padding:18px 22px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:28px' }, el('div', { style: 'flex:1;min-width:240px' }, el('h2', {}, next.title), el('p', { class: 'muted', style: 'font-size:var(--fs-2);margin-top:4px' }, next.body)), button({ label: next.cta, icon: 'arrow-right', variant: 'primary', onClick: next.go })));

  const steps = el('div', { class: 'steps panel', style: 'padding:4px 22px' });
  const rows = [
    ['basics', 'Course basics', 'Course facts, learners and grounding materials', prog.basics],
    ['design', 'Course design', 'Six ADDIE deliberations and the chapter list', prog.design],
    ['slides', 'Slides', 'Outline, slides and lecture script per chapter', prog.slides],
    ['assessments', 'Assessments', 'Homework, labs, quizzes and exams', prog.assessments],
    ['videos', 'Lecture videos', 'Narrated recordings with captions', prog.videos],
  ];
  rows.forEach(([id, t, d, pr], i) => {
    const state = pr.total && pr.done === pr.total ? 'done' : pr.done ? 'partial' : 'idle';
    steps.append(el('a', { class: `step ${state}`, href: href('p', p.id, id) }, el('span', { class: 'mark' }, state === 'done' ? icon('check', 'sm') : String(i + 1)), el('div', {}, el('div', { class: 't' }, t), el('div', { class: 'd' }, d)), el('span', { class: 'meta', style: 'align-self:center' }, pr.total ? `${pr.done} / ${pr.total}` : '—')));
  });
  page.append(el('section', { class: 'section', style: 'margin-top:0' }, el('h2', {}, 'Modules'), steps));

  const recent = [...p.audit].reverse().filter(a => ['stage_done', 'edit', 'approve', 'export', 'video', 'tts_call'].includes(a.type)).slice(0, 8);
  page.append(el('section', { class: 'section' }, el('h2', {}, 'Activity'), el('div', { class: 'summary-line', style: 'margin-bottom:12px' }, el('span', {}, el('b', {}, fmtInt(totals.calls)), ' model calls'), el('span', {}, el('b', {}, fmtInt(totals.tokens)), ' tokens'), el('span', {}, el('b', {}, fmtInt(totals.ttsChars)), ' narration characters'), el('span', {}, el('b', {}, fmtInt(totals.edits)), ' edits by you'), el('a', { href: href('p', p.id, 'audit'), style: 'margin-left:auto' }, 'Open audit trail')),
    recent.length ? el('div', { class: 'panel' }, ...recent.map(a => el('div', { class: 'list-row' }, el('div', {}, el('div', { class: 'title', style: 'font-weight:500' }, describe(a)), el('div', { class: 'sub' }, `${a.where || 'course'} · ${fmtRel(a.ts)}`)), el('div', { class: 'aside' }, a.tokens ? el('span', { class: 'meta' }, `${fmtInt(a.tokens)} tok`) : null)))) : el('p', { class: 'muted', style: 'font-size:var(--fs-2)' }, 'No activity yet.')));
  return page;
}

function describe(a) {
  return { stage_done: `Generated ${a.stage}`, edit: `Edited ${a.stage}`, approve: `Marked ${a.stage} reviewed`, export: `Exported ${a.file || a.stage || ''}`, video: `Recorded video (${Math.round(a.seconds || 0)} s)`, tts_call: `Narration synthesized for slide ${a.slide}` }[a.type] || a.type;
}

export function nextAction(ctx) {
  const p = ctx.store.project; const id = p.id;
  if (!p.course.audience) return { title: 'Describe your learners', body: 'Learner profile and constraints shape every deliberable the agents produce.', cta: 'Open Course basics', go: () => go('p', id, 'basics') };
  const f = FOUNDATION.find(f => p.foundation[f.id]?.status !== 'done');
  if (f) return { title: `Run “${f.name}”`, body: 'Course design proceeds through six deliberations; each builds on the previous ones.', cta: 'Open Course design', go: () => go('p', id, 'design', f.id) };
  if (!p.chapters.length) return { title: 'Extract the chapters', body: 'The Syllabus Processor splits your syllabus into chapters that drive slides, assessments and videos.', cta: 'Extract chapters', go: () => go('p', id, 'design', 'chapters') };
  const ch = p.chapters.find(c => ['outline', 'slides', 'script'].some(s => c.stages[s]?.status !== 'done'));
  if (ch) return { title: `Build slides for “${ch.title}”`, body: 'Outline → slides → lecture script. Each is editable before the next step reads it.', cta: 'Open Slides', go: () => go('p', id, 'slides', ch.id) };
  const ca = p.chapters.find(c => ['homework', 'lab', 'quiz'].some(s => c.stages[s]?.status !== 'done'));
  if (ca) return { title: `Write assessments for “${ca.title}”`, body: 'Homework, lab and quiz draw on the slides and the assessment plan.', cta: 'Open Assessments', go: () => go('p', id, 'assessments', ca.id) };
  if (p.exams.final?.status !== 'done') return { title: 'Write the exams', body: 'Midterm and final draw on all chapters and the assessment plan.', cta: 'Open exams', go: () => go('p', id, 'assessments', 'exams') };
  const cv = p.chapters.find(c => c.stages.video?.status !== 'done');
  if (cv) return { title: `Record the lecture for “${cv.title}”`, body: 'Narration is synthesized per slide; the video is recorded in this tab.', cta: 'Open Lecture videos', go: () => go('p', id, 'videos', cv.id) };
  return { title: 'Everything is generated', body: 'Review, edit and export the course bundle with its audit trail.', cta: 'Export ZIP', go: () => ctx.exportAll() };
}
