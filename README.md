# Instructional Agents Studio

**Live:** <https://darl-genai.github.io/instructional_agents_studio/>

A browser-only edition of [Instructional Agents](https://github.com/DaRL-GenAI/instructional_agents)
(EACL 2026). Bring your own OpenAI-compatible API key and generate a complete course without installing
anything. The key is stored in your browser and sent only to the API endpoint you configure.

## What it generates

| Course level (ADDIE deliberations) | Per chapter |
|---|---|
| Instructional goals · Learner analysis · Resource & constraints · Syllabus · Assessment plan · Final project | Slides outline · Slides (HTML deck, Beamer `.tex`, `.pptx`) · Lecture script · Homework · Hands-on lab · Narrated lecture video (WebM + `.vtt` captions) |

Each foundation stage runs the same three-agent deliberation as the Python pipeline
(Teaching Faculty → Instructional Designer / Committee → Summarizer; prompts mirrored from
`src/ADDIE.py`), or a single call in "quick" mode.

## Transparent, editable, auditable

- **Prompt tab**: the exact system and user prompts, editable before every run; defaults are rebuilt from the current inputs.
- **Transcript tab**: every agent response streamed and kept, with model, tokens and latency.
- **Output tab**: every deliverable is editable (structured editors for slides and script), with version history and restore.
- **Provenance tab**: hashes of every input a stage consumed; stages whose inputs changed are flagged as stale.
- **Audit trail**: every model call, TTS call, edit, prompt change, approval and export, exportable as JSON/Markdown and bundled into the project ZIP.
- **Textbook grounding (optional)**: upload a PDF/text; excerpts are retrieved per chapter and shown in Provenance.

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

Layout: `index.html`, `studio.css`, `js/llm.js` (API client), `js/prompts.js` (agent prompts),
`js/pipeline.js` (stage runners, retrieval), `js/slides.js` (HTML / Beamer / PPTX), `js/video.js`
(TTS + recording), `js/export.js` (ZIP), `js/state.js` (persistence + audit), `js/app.js` (UI).
Third-party libraries are loaded on demand from cdnjs: JSZip, PptxGenJS, pdf.js, marked.

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
