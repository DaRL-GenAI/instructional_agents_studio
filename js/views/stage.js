// views/stage.js — the shared stage detail: header, actions, Output / Prompt / Transcript / Provenance / History tabs.
import { el, button, badge, tabs, field, textarea, input, notice, empty, renderMarkdown, fmtDate, fmtMs, toast, icon, confirmDialog, segmented } from '../ui.js';
import { safeJson } from '../pipeline.js';
import { sha1Short as hashOf } from '../llm.js';
import { deckEditor, downloadPptx } from './deckeditor.js';
import { download, textBlob, slug, scriptMarkdown, quizMarkdown } from '../export.js';

export function stageStatus(pipe, stage, inputs) {
  if (!stage) return 'idle';
  if (stage.status === 'running') return 'running';
  if (stage.status === 'error') return 'error';
  if (stage.status === 'done' && inputs && pipe.isStale(stage, inputs)) return 'stale';
  if (stage.status === 'done' && stage.edited) return 'edited';
  return stage.status;
}

/**
 * o: { title, subtitle, stage, inputs, kind, file, label, where, chapter?, defaultPrompt(), run(), runAll?, runAllLabel?, next?, key }
 */
export function stageDetail(ctx, o) {
  const { store, pipe } = ctx; const { stage, inputs } = o;
  const ui = ctx.ui[o.key] ||= { tab: 'output' };
  const status = stageStatus(pipe, stage, inputs);
  const wrap = el('section', { class: 'stage', 'aria-labelledby': 'stage-title' });

  wrap.append(el('div', { class: 'stage-head' },
    el('div', {}, el('h2', { id: 'stage-title' }, o.title), o.subtitle ? el('p', { class: 'muted', style: 'margin-top:4px;font-size:var(--fs-2)' }, o.subtitle) : null),
    el('div', { class: 'meta-col' }, badge(status), stage.ranAt ? el('small', {}, `v${stage.version} · ${fmtDate(stage.ranAt)} · ${stage.usage?.total_tokens ?? '—'} tokens${stage.usage?.estimated ? ' (est.)' : ''} · ${fmtMs(stage.durationMs || 0)}`) : null, stage.reviewed ? badge('reviewed', 'Reviewed') : null)));

  if (status === 'stale') wrap.append(el('div', { style: 'margin-top:12px' }, notice('warn', 'Inputs changed after this was generated. Re-run it, or keep the current text deliberately (see Provenance for what changed).')));
  if (stage.error) wrap.append(el('div', { style: 'margin-top:12px' }, notice('error', `Last run failed: ${stage.error}`)));

  const running = stage.status === 'running';
  const actions = el('div', { class: 'stage-actions' },
    button({ label: stage.status === 'done' ? 'Re-run' : 'Generate', icon: stage.status === 'done' ? 'refresh' : 'play', variant: 'primary', disabled: !!ctx.busy, onClick: () => o.run({}) }),
    stage.output ? button({ label: 'Re-run with comments', icon: 'message', variant: ui.feedbackOpen ? 'ghost' : '', disabled: !!ctx.busy, onClick: () => { ui.feedbackOpen = !ui.feedbackOpen; ctx.render(); } }) : null,
    o.runAll ? button({ label: o.runAllLabel || 'Generate remaining', icon: 'fast-forward', disabled: !!ctx.busy, onClick: o.runAll }) : null,
    running ? button({ label: 'Cancel', variant: 'danger', onClick: () => pipe.cancel() }) : null,
    stage.output ? button({ label: stage.reviewed ? 'Reviewed' : 'Mark reviewed', icon: 'check', variant: stage.reviewed ? 'ghost' : '', onClick: () => { stage.reviewed = !stage.reviewed; store.log({ type: stage.reviewed ? 'approve' : 'unapprove', stage: o.label, where: o.where, version: stage.version }); store.save(); ctx.render(); } }) : null,
    stage.output && o.kind === 'slides' ? button({ label: 'Download .pptx', icon: 'download', onClick: () => downloadStage(ctx, o, 'pptx') }) : null,
    stage.output && o.kind === 'slides' ? button({ label: 'JSON', variant: 'ghost', size: 'sm', onClick: () => downloadStage(ctx, o, 'json') }) : null,
    stage.output && o.kind !== 'slides' ? button({ label: 'Download', icon: 'download', onClick: () => downloadStage(ctx, o) }) : null,
    stage.output && o.kind !== 'json' ? button({ label: 'Program Chair review', icon: 'search', disabled: !!ctx.busy, onClick: () => ctx.guarded('Reviewing', async () => { if (!ctx.requireKey()) return; stage.review = await pipe.review(o.title, stageText(o), o.where); store.save(); ui.tab = 'review'; }) }) : null,
    stage.output && o.next ? button({ label: 'Next', icon: 'arrow-right', variant: 'ghost', onClick: o.next }) : null);
  wrap.append(actions);
  if (ui.feedbackOpen && stage.output) wrap.append(feedbackPanel(ctx, o, ui));

  const items = [['output', 'Output'], ['prompt', 'Prompt'], ['transcript', 'Transcript', stage.transcript?.length || 0], ['provenance', 'Provenance'], ['history', 'History', stage.history?.length || 0]];
  if (stage.review) items.push(['review', `Review · ${stage.review.score}/10`]);
  wrap.append(tabs(items.map(([k, l, c]) => [k, l, c]), ui.tab, k => { ui.tab = k; ctx.render(); }));
  const body = el('div', { class: 'tab-body' });
  try {
    if (ui.tab === 'output') body.append(outputEditor(ctx, o));
    if (ui.tab === 'prompt') body.append(promptEditor(ctx, o));
    if (ui.tab === 'transcript') body.append(transcriptView(stage));
    if (ui.tab === 'provenance') body.append(provenanceView(stage, inputs));
    if (ui.tab === 'history') body.append(historyView(ctx, o));
    if (ui.tab === 'review') body.append(reviewView(stage));
  } catch (e) {
    console.error(e);
    body.append(notice('error', `This tab could not be displayed (${e.message}). `, button({ label: 'Show raw output', size: 'sm', onClick: () => { ui.tab = 'output'; ui.forceRaw = true; ctx.render(); } })));
  }
  wrap.append(body);
  return wrap;
}

function feedbackPanel(ctx, o, ui) {
  const ta = textarea({ rows: 4, placeholder: 'What should change? e.g. “Make objective 3 measurable”, “Add a slide on pruning with a worked example”, “Shorter, and no jargon in the intro”.', 'aria-label': 'Comments for the re-run' }, ui.feedbackDraft || '');
  ta.oninput = () => { ui.feedbackDraft = ta.value; };
  const last = (o.stage.feedbackLog || []).at(-1);
  return el('div', { class: 'feedback-panel' },
    el('div', { class: 'label' }, 'Comments for the agents'),
    el('p', { class: 'hint' }, 'Your comments and the current version are appended to the prompt as a revision request; the agents revise rather than start over. Comments are recorded in the audit trail and the Prompt tab.'),
    ta,
    el('div', { class: 'btn-row' },
      button({ label: 'Re-run with these comments', icon: 'refresh', variant: 'primary', disabled: !!ctx.busy, onClick: () => { const fb = (ui.feedbackDraft || '').trim(); if (!fb) { toast('Write a comment first', 'error'); ta.focus(); return; } ui.feedbackOpen = false; ui.feedbackDraft = ''; o.run({ feedback: fb }); } }),
      button({ label: 'Cancel', variant: 'ghost', onClick: () => { ui.feedbackOpen = false; ctx.render(); } }),
      last ? el('span', { class: 'meta' }, `Last comments (v${last.version + 1}): “${last.feedback.slice(0, 80)}${last.feedback.length > 80 ? '…' : ''}”`) : null));
}

function editorMode(ctx) { return ctx.ui.editorMode || (window.innerWidth > 1100 ? 'split' : 'preview'); }
function modeControl(ctx) {
  return segmented([['source', 'Source'], ['split', 'Split'], ['preview', 'Preview']], editorMode(ctx), v => { ctx.ui.editorMode = v; ctx.render(); });
}

export function stageText(o) {
  const st = o.stage;
  if (o.kind === 'script') return scriptMarkdown(o.chapter, safeJson(st.output, []));
  if (o.kind === 'quiz') return quizMarkdown(o.chapter, safeJson(st.output, []));
  return st.output;
}

async function downloadStage(ctx, o, forced) {
  const st = o.stage;
  if (o.kind === 'slides') {
    if (forced === 'json') { download(textBlob(st.output, 'application/json'), `${slug(o.chapter.title)}_slides.json`); return; }
    await downloadPptx(ctx, o); return;
  }
  const name = o.chapter ? `${slug(o.chapter.title)}_${o.file.replace('.json', o.kind === 'quiz' ? '.md' : '.json')}` : o.file;
  download(textBlob(stageText(o), o.kind === 'json' ? 'application/json' : 'text/markdown'), name);
  ctx.store.log({ type: 'export', stage: o.label, file: name });
}
// ---------------------------------------------------------------- editors
function outputEditor(ctx, o) {
  const st = o.stage;
  if (!st.output) {
    if (st.status === 'running') return el('div', {}, el('p', { class: 'muted', style: 'margin-bottom:12px' }, 'Generating. The live response streams in the panel at the bottom right.'), el('div', { class: 'skeleton' }, el('i', { style: 'width:70%' }), el('i', { style: 'width:90%' }), el('i', { style: 'width:60%' }), el('i', { style: 'width:80%' })));
    return empty({ icon: 'file', title: 'Nothing generated yet', body: 'Review the Prompt tab if you want to adjust what the agents are asked, then press Generate.', actions: [button({ label: 'Generate', icon: 'play', variant: 'primary', disabled: !!ctx.busy, onClick: () => o.run({}) }), button({ label: 'View prompt', variant: 'ghost', onClick: () => { ctx.ui[o.key].tab = 'prompt'; ctx.render(); } })] });
  }
  if (!ctx.ui[o.key]?.forceRaw) {
    if (o.kind === 'slides') return deckEditor(ctx, o) || invalidOutput(ctx, o, 'slide deck');
    if (o.kind === 'script') return scriptEditor(ctx, o);
    if (o.kind === 'quiz') return quizEditor(ctx, o);
  }
  const mode = editorMode(ctx);
  const box = el('div', { class: `editor-split mode-${mode}` });
  const ta = textarea({ class: 'textarea editor', spellcheck: 'false', 'aria-label': 'Editable source' }, st.output);
  const preview = el('div', { class: 'preview md' });
  const refresh = async () => { preview.innerHTML = o.kind === 'json' ? `<pre>${ta.value.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` : await renderMarkdown(ta.value); };
  refresh(); let t; ta.oninput = () => { clearTimeout(t); t = setTimeout(refresh, 350); };
  const save = () => { if (o.kind === 'json') { try { JSON.parse(ta.value); } catch (e) { return toast(`Invalid JSON: ${e.message}`, 'error'); } } if (ctx.store.userEdit(st, o.label, ta.value, o.where)) { toast('Edit saved and logged', 'ok'); ctx.render(); } else toast('No changes'); };
  const bar = el('div', { class: 'editor-bar', style: 'grid-column:1/-1' }, modeControl(ctx), el('span', {}), button({ label: 'Save edits', size: 'sm', variant: 'primary', onClick: save }), button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => { ta.value = st.output; refresh(); } }));
  box.append(bar, el('div', { class: 'editor-col source' }, ta), el('div', { class: 'editor-col preview-col' }, preview));
  return box;
}

function scriptEditor(ctx, o) {
  const st = o.stage; const raw = safeJson(st.output, null);
  const script = Array.isArray(raw) ? raw.filter(x => x && typeof x === 'object').map((x, i) => ({ slide_id: x.slide_id || i + 1, title: String(x.title || `Slide ${i + 1}`), narration: String(x.narration || '') })) : [];
  if (!script.length) return invalidOutput(ctx, o, 'lecture script');
  const words = script.reduce((a, s) => a + (s.narration || '').split(/\s+/).filter(Boolean).length, 0);
  const box = el('div', {}, el('div', { class: 'editor-bar' }, el('span', {}, `${script.length} narration blocks · ~${words} words · about ${Math.max(1, Math.round(words / 150))} min spoken`), button({ label: 'Save edits', size: 'sm', variant: 'primary', onClick: () => { if (ctx.store.userEdit(st, o.label, JSON.stringify(script, null, 2), o.where)) { toast('Script saved and logged', 'ok'); ctx.render(); } else toast('No changes'); } }), button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => ctx.render() })));
  script.forEach((s, i) => { const ta = textarea({ rows: 4, 'aria-label': `Narration for slide ${i + 1}` }, s.narration); ta.oninput = () => { s.narration = ta.value; }; box.append(el('div', { class: 'script-row' }, el('div', { class: 'script-label' }, el('b', {}, `Slide ${i + 1}`), s.title), ta)); });
  return box;
}

function quizEditor(ctx, o) {
  const st = o.stage; const raw = safeJson(st.output, null);
  const quiz = Array.isArray(raw) ? raw.filter(x => x && typeof x === 'object').map((x, i) => ({ id: i + 1, type: x.type || (Array.isArray(x.options) && x.options.length ? 'multiple_choice' : 'short_answer'), question: String(x.question || ''), options: Array.isArray(x.options) ? x.options.map(String) : [], answer: String(x.answer ?? ''), explanation: String(x.explanation || ''), objective: String(x.objective || ''), difficulty: String(x.difficulty || 'medium') })) : [];
  if (!quiz.length) return invalidOutput(ctx, o, 'quiz');
  const box = el('div', {});
  const save = () => { if (ctx.store.userEdit(st, o.label, JSON.stringify(quiz, null, 2), o.where)) { toast('Quiz saved and logged', 'ok'); ctx.render(); } else toast('No changes'); };
  box.append(el('div', { class: 'editor-bar' }, el('span', {}, `${quiz.length} questions · ${quiz.filter(q => q.type === 'multiple_choice').length} multiple choice`), button({ label: 'Save edits', size: 'sm', variant: 'primary', onClick: save }), button({ label: 'Discard', size: 'sm', variant: 'ghost', onClick: () => ctx.render() })));
  const render = () => {
    box.querySelectorAll('.quiz-q').forEach(n => n.remove());
    quiz.forEach((q, i) => {
      const qEl = el('div', { class: 'quiz-q' });
      const qt = textarea({ rows: 2, 'aria-label': `Question ${i + 1}` }, q.question); qt.oninput = () => { q.question = qt.value; };
      qEl.append(el('div', { class: 'editor-bar' }, el('span', {}, el('b', {}, `Q${i + 1}`), ` · ${q.type.replace('_', ' ')} · ${q.difficulty}`), button({ label: 'Remove', size: 'sm', variant: 'ghost', icon: 'trash', onClick: () => { quiz.splice(i, 1); quiz.forEach((x, k) => x.id = k + 1); render(); } })), qt);
      if (q.options.length) q.options.forEach((opt, k) => {
        const letter = opt.match(/^([A-D])\)/)?.[1] || (q.type === 'true_false' ? opt : String.fromCharCode(65 + k));
        const r = el('input', { type: 'radio', name: `q${i}`, checked: q.answer === letter || q.answer === opt, 'aria-label': `Correct answer ${letter}` }); r.onchange = () => { q.answer = letter; };
        const t = input({ value: opt }); t.oninput = () => { q.options[k] = t.value; };
        qEl.append(el('div', { class: 'opt' }, r, t));
      });
      const ans = q.options.length ? null : input({ value: q.answer, placeholder: 'Model answer' }); if (ans) { ans.oninput = () => { q.answer = ans.value; }; qEl.append(field('Model answer', ans)); }
      const ex = textarea({ rows: 2 }, q.explanation); ex.oninput = () => { q.explanation = ex.value; }; qEl.append(field('Explanation / grading notes', ex));
      box.append(qEl);
    });
    box.append(el('div', { class: 'btn-row quiz-q', style: 'border-style:dashed;background:transparent' }, button({ label: 'Add multiple-choice question', icon: 'plus', size: 'sm', onClick: () => { quiz.push({ id: quiz.length + 1, type: 'multiple_choice', question: '', options: ['A) ', 'B) ', 'C) ', 'D) '], answer: 'A', explanation: '', objective: '', difficulty: 'medium' }); render(); } }), button({ label: 'Add short answer', icon: 'plus', size: 'sm', onClick: () => { quiz.push({ id: quiz.length + 1, type: 'short_answer', question: '', options: [], answer: '', explanation: '', objective: '', difficulty: 'medium' }); render(); } })));
  };
  render(); return box;
}

// ---------------------------------------------------------------- prompt / transcript / provenance / history / review
function promptEditor(ctx, o) {
  const st = o.stage; const isCustom = !!st.prompt?.custom;
  const prompt = isCustom ? st.prompt : (st.status === 'done' && st.prompt ? st.prompt : o.defaultPrompt());
  const box = el('div', { style: 'display:flex;flex-direction:column;gap:16px;max-width:900px' });
  box.append(notice('info', isCustom ? 'This stage uses a custom prompt you saved; it is sent as-is on the next run.' : st.status === 'done' ? 'The exact prompt behind the current output. Defaults are rebuilt from the latest inputs on every run; save a custom version to pin it.' : 'The prompt that will be sent. Edit and save to customize.'));
  if (prompt.feedback) box.append(notice('ok', `This version was produced from a revision request: “${prompt.feedback}”. The request and the previous version are at the end of the user prompt below.`));
  const agentTAs = prompt.agents.map(a => { const ta = textarea({ rows: 4 }, a.system); return { a, ta }; });
  const sumTa = prompt.summarizer ? textarea({ rows: 3 }, prompt.summarizer.system) : null;
  const userTa = textarea({ rows: 16, class: 'textarea mono' }, prompt.user);
  const modeSel = prompt.mode ? el('select', { class: 'select' }, el('option', { value: 'full', selected: prompt.mode === 'full' }, 'Full deliberation (3 calls)'), el('option', { value: 'quick', selected: prompt.mode === 'quick' }, 'Quick (1 call)')) : null;
  agentTAs.forEach(({ a, ta }) => box.append(field(`System prompt · ${a.name} (${a.role})`, ta)));
  if (sumTa) box.append(field('System prompt · Summarizer', sumTa));
  if (modeSel) box.append(field('Mode', modeSel));
  box.append(field('User prompt (task and context)', userTa));
  box.append(el('div', { class: 'btn-row' },
    button({ label: 'Save custom prompt', variant: 'primary', size: 'sm', onClick: () => { st.prompt = { ...prompt, custom: true, agents: agentTAs.map(x => ({ ...x.a, system: x.ta.value })), summarizer: sumTa ? { ...prompt.summarizer, system: sumTa.value } : undefined, user: userTa.value, mode: modeSel ? modeSel.value : undefined }; ctx.store.log({ type: 'prompt_edit', stage: o.label, where: o.where }); ctx.store.save(); toast('Custom prompt saved', 'ok'); ctx.render(); } }),
    isCustom ? button({ label: 'Reset to default', size: 'sm', onClick: () => { st.prompt = null; ctx.store.log({ type: 'prompt_reset', stage: o.label, where: o.where }); ctx.store.save(); ctx.render(); } }) : null,
    button({ label: 'Copy', icon: 'copy', size: 'sm', variant: 'ghost', onClick: () => navigator.clipboard.writeText(`SYSTEM:\n${agentTAs.map(x => x.ta.value).join('\n---\n')}\n\nUSER:\n${userTa.value}`).then(() => toast('Copied')) })));
  return box;
}

export function transcriptView(stage) {
  const box = el('div', {});
  if (!stage.transcript?.length) return empty({ icon: 'message', title: 'No model calls yet', body: 'Each agent turn appears here with its system prompt, user prompt, response, tokens and latency.' });
  stage.transcript.forEach((t, i) => box.append(el('details', { class: 'turn', open: i === stage.transcript.length - 1 },
    el('summary', {}, icon('chevron-right', 'sm chev'), el('b', {}, `${i + 1}. ${t.role}`), el('span', { class: 'meta' }, `${t.model || ''}${t.usage ? ` · ${t.usage.prompt_tokens}→${t.usage.completion_tokens} tokens` : ''}${t.ms ? ` · ${fmtMs(t.ms)}` : ''}`)),
    el('div', { class: 'turn-body' }, el('details', {}, el('summary', {}, 'System prompt'), el('pre', {}, t.system)), el('details', {}, el('summary', {}, 'User prompt'), el('pre', {}, t.user)), el('div', {}, el('div', { class: 'meta', style: 'margin-bottom:4px' }, 'Response'), el('pre', {}, t.text || '(streaming…)'))))));
  return box;
}

function provenanceView(stage, inputs) {
  const box = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  box.append(el('p', { class: 'muted', style: 'font-size:var(--fs-2);max-width:68ch' }, 'Inputs this stage reads. The hashes let you verify that a stored output was produced from exactly these inputs; a changed row explains an "Inputs changed" status.'));
  const tb = el('tbody', {});
  for (const i of inputs) { const used = stage.provenance?.find(p => p.label === i.label); const h = hashOf(i.text); tb.append(el('tr', { class: used && used.hash !== h ? 'changed' : '' }, el('td', {}, i.label), el('td', { class: 'mono' }, h), el('td', { class: 'mono' }, used?.hash || '—'), el('td', { class: 'num' }, i.text.length.toLocaleString()))); }
  box.append(el('div', { class: 'panel', style: 'overflow:hidden' }, el('table', { class: 'table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Input'), el('th', {}, 'Current hash'), el('th', {}, 'Hash at last run'), el('th', { class: 'num' }, 'Chars'))), tb)));
  const chunks = inputs.find(i => i.chunks)?.chunks;
  if (chunks?.length) box.append(el('div', {}, el('h3', { style: 'margin-bottom:8px' }, 'Retrieved textbook excerpts'), ...chunks.map((c, i) => el('details', { class: 'turn' }, el('summary', {}, icon('chevron-right', 'sm chev'), `Excerpt ${i + 1}${c.page ? ` · page ${c.page}` : ''} · score ${c.score}`), el('div', { class: 'turn-body' }, el('pre', {}, c.text))))));
  if (stage.outputHash) box.append(el('p', { class: 'meta mono' }, `Output hash ${stage.outputHash} · version ${stage.version} · ${stage.edited ? 'contains user edits' : 'model output'}`));
  return box;
}

function historyView(ctx, o) {
  const st = o.stage;
  if (!st.history?.length) return empty({ icon: 'history', title: 'No earlier versions', body: 'Every re-run and every saved edit keeps the previous version here, so you can compare or restore.' });
  return el('div', {}, ...[...st.history].reverse().map(h => el('details', { class: 'turn' }, el('summary', {}, icon('chevron-right', 'sm chev'), el('b', {}, `Version ${h.version}`), el('span', { class: 'meta' }, `${h.reason} · ${fmtDate(h.at)} · ${(h.output || '').length.toLocaleString()} chars`)), el('div', { class: 'turn-body' }, el('pre', {}, h.output), el('div', {}, button({ label: 'Restore this version', size: 'sm', onClick: async () => { if (await confirmDialog({ title: `Restore version ${h.version}?`, body: 'The current text is kept in history.', confirmLabel: 'Restore' })) { if (ctx.store.userEdit(st, o.label, h.output, o.where)) { toast(`Restored version ${h.version}`, 'ok'); ctx.render(); } } } }))))));
}

function reviewView(stage) {
  const r = stage.review;
  return el('div', { style: 'max-width:72ch' }, el('p', {}, el('b', {}, `Program Chair score: ${r.score}/10`)), el('h3', { style: 'margin:16px 0 6px' }, 'Issues'), el('ul', {}, ...(r.issues || []).map(x => el('li', {}, x))), el('h3', { style: 'margin:16px 0 6px' }, 'Strengths'), el('ul', {}, ...(r.strengths || []).map(x => el('li', {}, x))));
}
