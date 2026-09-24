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

## Slides on your own PowerPoint template

Upload a `.pptx`/`.potx` under **Slides → Deck template**. Studio reads it in the browser (nothing is uploaded):
slide size, every slide layout with its placeholders, the master background and text styles, theme fonts and
colours. Generated slides are then built on the template's own layouts (Title Slide, Title and Content, Two
Content, Comparison, Section Header, Title Only…); each slide's layout can be changed in the deck editor. The
downloaded `.pptx` is your template file with the new slides written as real placeholders, so it opens and edits
exactly like the original. Slides that use Studio-only visuals (stat callouts, process flows, grids, charts, code)
keep the template background and title placeholder and draw their content into the layout's content area.

## Video

Two options per chapter, both produced entirely in the browser:

1. **Narrated slides** — each slide is held while its lecture-script narration plays.
2. **Animated lesson (EduCast)** — a Lesson Director agent plans 6–8 teaching scenes (lecture lines that light
   up as they are spoken, one visual beat per scene: bullets, formula, compare, steps, stat counters, diagram,
   chart, illustration, recap) plus **one interactive practice scene** chosen from EduCast's trusted templates
   (multiple choice, fill in the blank, drag to sort, number line, lever simulator). Every scene is editable.

An independent **visual reviewer** (EduCast's VLM auditor, ported) renders sample frames of every scene, checks
them against the scene's key elements together with deterministic guards (clipped text, blank frames, practice
panel overflow), and either applies the structured edits it proposes or asks the Lesson Director to re-plan the
scene, then re-reviews — up to the number of rounds set under Account → Generation defaults. Verdicts, frames and
every repair are shown in the storyboard editor and recorded in the audit trail.

Videos are encoded frame by frame with WebCodecs and muxed to **MP4** (H.264/AAC on desktop Chrome and Edge;
VP9/Opus where no H.264 encoder exists; real-time WebM recording as the last fallback). Narration uses the OpenAI
speech API; captions are WebVTT. The **Lesson player** tab wraps the video with the practice checks (the player
pauses at each check until it is solved), captions, chapter rail, resume and an event log, and exports it as a ZIP
bundle or a single standalone HTML file — both work offline. The project ZIP contains all of it.

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
`js/template.js` (reads a user's .pptx/.potx: layouts, placeholders, master, theme), `js/decktemplate.js` (slides on template layouts),
`js/pptxtemplate.js` (writes slides into the template package), `js/scenes.js` (EduCast teaching-board renderer), `js/practice.js`
(interactive practice templates + validators), `js/review.js` (VLM reviewer, repair ops), `js/encode.js` (WebCodecs → MP4),
`js/player.js` (lesson player bundle), `js/vendor/interactive-runtime.js` (EduCast's practice runtime), `js/video.js` (TTS, rendering), `js/export.js` (ZIP),
`js/views/*` (one file per module, the deck editor and the account pages).
Third-party libraries are loaded on demand: JSZip, pdf.js and marked from cdnjs, PptxGenJS and mp4-muxer from jsDelivr.

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
