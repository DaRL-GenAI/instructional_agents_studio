# Instructional Agents Studio

**Live:** <https://darl-genai.github.io/instructional_agents_studio/>

A browser-only edition of [Instructional Agents](https://github.com/DaRL-GenAI/instructional_agents)
(EACL 2026). Bring your own OpenAI-compatible API key and generate a complete course without installing
anything. The key is stored in your browser and sent only to the API endpoint you configure.

## How it is organised

Every **project** is one course. Its modules, in the order you normally work:

| Module | What lives there |
|---|---|
| **Course basics** | Course facts, learner profile, instructor requirements, optional textbook / notes for grounding, per-project model overrides |
| **Course design** | The six ADDIE deliberations (instructional goals, learner analysis, resources & constraints, syllabus, assessment plan, final project) and the chapter list extracted from the syllabus |
| **Slides** | Per chapter: outline → slides → lecture script. Decks are designed as PowerPoint: a layout engine renders each slide (title, bullets + callout, two columns, numbered rows, 2×2 grid, stat callouts, process flow, code, native charts, statement, summary) into a live preview, the `.pptx` download and the lecture video. Deck template per project: automatic palette, ten built-in palettes, or your own `.pptx`/`.potx` (theme colours, fonts and master background are read in the browser) |
| **Assessments** | Per chapter: homework, hands-on lab, quiz (structured editor); course level: midterm and final exams with blueprints and answer keys |
| **Lecture videos** | Per chapter, two options: (1) narrated slides — each PowerPoint slide shown while its script narration plays; (2) animated lesson (EduCast-style) — a Lesson Director agent plans 6–8 teaching scenes (title card, bullets, formula, compare, steps, stat counters, diagram, chart, illustration, recap) that animate on the EduCast teaching board in sync with the narration, with optional AI illustrations and character accents. Both are recorded in the browser with WebVTT captions |
| **Audit trail** | Every model call, TTS call, edit, prompt change, approval and export, with hashes |

**Account** (personal center): generation defaults (model, endpoint, deliberation mode, sizes, voice, theme),
API key & privacy (what leaves the browser), project management (rename, duplicate, import/export, delete),
data & storage (IndexedDB usage, persistent-storage request, delete everything).

Each foundation stage runs the same three-agent deliberation as the Python pipeline
(Teaching Faculty → Instructional Designer / Committee → Summarizer; prompts mirrored from
`src/ADDIE.py`), or a single call in "quick" mode.

## Transparent, editable, auditable

- **Prompt tab**: the exact system and user prompts, editable before every run; defaults are rebuilt from the current inputs.
- **Transcript tab**: every agent response streamed and kept, with model, tokens and latency.
- **Output tab**: every deliverable is editable (slide-by-slide deck editor with preview, script and quiz editors, Markdown/JSON editors with Source / Split / Preview layouts), with version history and restore.
- **Re-run with comments**: every stage can be revised from instructor comments; the request is logged and shown in the Prompt tab.
- **Provenance tab**: hashes of every input a stage consumed; stages whose inputs changed are flagged as stale.
- **Audit trail**: exportable as JSON/Markdown and bundled into the project ZIP.

## Storage

Projects, narration audio and recorded videos are saved in the browser's IndexedDB (with an in-memory
fallback). Coming back in the same browser restores everything; use *Account → Projects* to export a
project as JSON and import it elsewhere. *Account → Data & storage* can request persistent storage so the
browser does not evict the data.

## Video

Narration is synthesized per slide or per scene with the OpenAI speech API; frames are drawn on a canvas in sync
with the audio clock and recorded with the MediaRecorder API into WebM, with proportional WebVTT captions. The
animated option follows EduCast's EduHarness design (scene planning prompt, teaching-board layout, lecture lines
that light up, one visual beat per scene, takeaway strip, characters); illustrations use the OpenAI image API. For MP4 output from LaTeX-Beamer decks use
the Python pipeline's `--video` option ([docs](https://github.com/DaRL-GenAI/instructional_agents/blob/upgrade/docs/VIDEO_GENERATION.md)).

## Development

No build step. Serve the folder with any static server and open `index.html`:

```bash
python -m http.server 8000
# http://localhost:8000/
```

Layout: `index.html` (shell + SVG icon sprite), `css/tokens.css` (design tokens), `css/app.css`,
`js/app.js` (shell, routing), `js/router.js`, `js/ui.js` (components), `js/db.js` (IndexedDB),
`js/state.js` (account, projects, audit), `js/llm.js` (API client), `js/prompts.js` (agent prompts),
`js/pipeline.js` (stage runners, retrieval), `js/deck.js` (slide layout engine: HTML preview, pptxgenjs, canvas),
`js/template.js` (reads a user's .pptx/.potx theme), `js/video.js` (TTS + recording), `js/export.js` (ZIP),
`js/views/*` (one file per module, the deck editor and the account pages).
Third-party libraries are loaded on demand: JSZip, pdf.js and marked from cdnjs, PptxGenJS from jsDelivr.

## Citation

```bibtex
@misc{yao2025instructionalagentsllmagents,
  title={Instructional Agents: Reducing Teaching Faculty Workload through Multi-Agent Instructional Design},
  author={Yao, Huaiyuan and Xu, Wanpeng and Turnau, Justin and Kellam, Nadia and Wei, Hua},
  year={2025}, eprint={2508.19611}, archivePrefix={arXiv}, primaryClass={cs.AI},
  url={https://arxiv.org/abs/2508.19611},
}
```

License: MIT.
