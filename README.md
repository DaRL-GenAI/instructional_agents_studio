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
| **Slides** | Per chapter: outline → slides → lecture script; export as HTML deck, Beamer `.tex` or `.pptx` |
| **Assessments** | Per chapter: homework, hands-on lab, quiz (structured editor); course level: midterm and final exams with blueprints and answer keys |
| **Lecture videos** | Per chapter: narration (TTS) and an in-browser recording with WebVTT captions; audio and video are kept in the browser |
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
- **Output tab**: every deliverable is editable (structured editors for slides, script and quiz), with version history and restore.
- **Provenance tab**: hashes of every input a stage consumed; stages whose inputs changed are flagged as stale.
- **Audit trail**: exportable as JSON/Markdown and bundled into the project ZIP.

## Storage

Projects, narration audio and recorded videos are saved in the browser's IndexedDB (with an in-memory
fallback). Coming back in the same browser restores everything; use *Account → Projects* to export a
project as JSON and import it elsewhere. *Account → Data & storage* can request persistent storage so the
browser does not evict the data.

## Video

Narration is synthesized per slide with the OpenAI speech API; the deck is drawn on a canvas and recorded with
the MediaRecorder API into WebM, with proportional WebVTT captions. For MP4 output from LaTeX-Beamer decks use
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
`js/pipeline.js` (stage runners, retrieval), `js/slides.js` (HTML / Beamer / PPTX), `js/video.js`
(TTS + recording), `js/export.js` (ZIP), `js/views/*` (one file per module and the account pages).
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
