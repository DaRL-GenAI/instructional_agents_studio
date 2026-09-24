// views/assessments.js — homework, lab and quiz per chapter, plus course-level midterm and final exams.
import { el, button, dot, tabs, icon, toast } from '../ui.js';
import { EXAMS } from '../prompts.js';
import { chapterRail, chapterStages, noChapters, runAllChapters } from './chapters.js';
import { stageDetail, stageStatus } from './stage.js';
import { go } from '../router.js';
const IDS = ['homework', 'lab', 'quiz'];

export function render(ctx) {
  const { store, pipe } = ctx; const p = store.project;
  if (!p.chapters.length) return noChapters(ctx, 'Assessments');
  const isExams = ctx.route.a === 'exams';
  const chId = !isExams && store.chapter(ctx.route.a) ? ctx.route.a : (isExams ? null : p.chapters[0].id);
  const page = el('div', { class: 'page wide' });
  page.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Assessments'), el('p', {}, 'Per chapter: homework, a hands-on lab and a quiz, all aligned with the assessment plan. Course level: midterm and final exams with blueprints and answer keys.')), el('div', { class: 'btn-row' }, runAllChapters(ctx, 'assessments', IDS))));
  const examsTop = [el('div', { class: 'rail-head' }, 'Course level'), el('button', { class: 'rail-item', 'aria-current': String(isExams), onClick: () => go('p', p.id, 'assessments', 'exams') }, icon('file-text', 'sm'), el('span', { class: 't' }, 'Exams'), el('span', { class: 'dots' }, ...EXAMS.map(e => dot(stageStatus(pipe, p.exams[e.id], pipe.examInputs(e.id))))))];
  const main = el('div', { class: 'panel', style: 'padding:24px 28px;min-height:60vh' });
  main.append(isExams ? examsView(ctx) : chapterStages(ctx, 'assessments', IDS, chId));
  page.append(el('div', { class: 'two-pane' }, chapterRail(ctx, 'assessments', IDS, chId, examsTop), main));
  return page;
}

function examsView(ctx) {
  const { store, pipe } = ctx; const p = store.project;
  const kind = EXAMS.some(e => e.id === ctx.route.b) ? ctx.route.b : 'midterm';
  const ex = EXAMS.find(e => e.id === kind); const stage = store.examStage(kind); const inputs = pipe.examInputs(kind);
  const box = el('div', {});
  box.append(el('h2', { style: 'margin-bottom:12px' }, 'Exams'), tabs(EXAMS.map(e => [e.id, e.name]), kind, k => go('p', p.id, 'assessments', 'exams', k)));
  const chaptersInScope = pipe.examChapters(kind).length;
  box.append(el('div', { class: 'tab-body' }, stageDetail(ctx, { key: `exam:${kind}`, title: ex.name, subtitle: `Teaching Assistant · covers ${chaptersInScope} chapter${chaptersInScope === 1 ? '' : 's'} (${ex.scope})`, stage, inputs, kind: 'md', file: ex.file, label: ex.name, where: 'course', defaultPrompt: () => pipe.defaultExamPrompt(kind),
    run: ({ feedback } = {}) => ctx.guarded(`Writing ${ex.name}`, async () => { if (!ctx.requireKey()) return; await pipe.runExam(kind, { feedback }); toast(`${ex.name} ${feedback ? 'revised' : 'generated'}`, 'ok'); }),
    next: kind === 'midterm' ? () => go('p', p.id, 'assessments', 'exams', 'final') : null })));
  return box;
}
