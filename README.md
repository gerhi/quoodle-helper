# Quoodle Helper

> Turn your lecture slides, handouts, and scripts into multiple-choice quizzes — locally, in the browser.

**Quoodle Helper** is a browser-based tool that converts existing teaching materials (PDF, DOCX, PPTX, TXT, MD) into multiple-choice questions with explanations, and exports the result as an Excel or CSV file. The output format is designed to drop straight into [Quoodle](https://github.com/gerhi/quoodle), the companion quiz-distribution app for formative assessment.

No server, no account, no tracking. Your files stay in your browser. The only thing that leaves your device is the extracted text, sent to the LLM endpoint *you* configure — nothing else.

---

## Why this exists

Writing good multiple-choice questions is tedious. Writing them from existing slides, handouts, and scripts that you have already produced for the same course is doubly so. This tool closes that loop:

1. You upload the material you already have.
2. A language model drafts questions with plausible distractors and short explanations.
3. You get an Excel file that Quoodle can consume directly to run the quiz with your students.

The prompt used to generate the questions is tuned for **university-level exam items** that test understanding rather than text recall — and you can edit it if your field needs a different style.

## Key properties

- **Fully client-side.** No backend. Deploys as a static folder on GitHub Pages, Netlify, a university webspace, or `python3 -m http.server`.
- **Bring-your-own-key.** Supports any OpenAI-compatible endpoint (RWTH HPC, OpenRouter, DeepSeek, Mistral, Groq, vLLM, LocalAI, Ollama), plus Anthropic Claude and OpenAI directly. Default: RWTH Aachen HPC with `openai/gpt-oss-120b`.
- **Privacy by design.** Files never leave the browser except as extracted text to your chosen LLM. No analytics, no cookies, no third-party calls. API keys are kept in memory unless you actively opt in to browser storage.
- **Quoodle-compatible export.** The `.xlsx` format matches what Quoodle expects: one row per question, with question, correct answer, three distractors, explanation, and source hint.
- **Customizable prompt.** An advanced panel exposes the full system prompt for editing — useful for adding domain-specific guidance or adjusting the question style for your field.
- **German and English UI.** Complete translations, switchable at runtime. A proper German Impressum and Datenschutzerklärung are included for self-hosting from Germany.

## Quick start

### Option A — Run locally

```bash
git clone https://github.com/<your-username>/quoodle-helper.git
cd quoodle-helper
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome, Edge, Firefox, or Safari. The JavaScript libraries needed for file extraction and Excel export are bundled in the repository under `vendor/` — no additional install step is required.

### Option B — Deploy to any static host

Upload the repository contents to:

- GitHub Pages
- Netlify, Vercel, Cloudflare Pages
- An nginx or Apache static site
- A university webspace

No build step. No server runtime. No environment variables.

## How to use

1. **Upload** — drop or select PDF, DOCX, PPTX, TXT, or MD files (up to 50 MB each). Text extraction runs in your browser; you can preview the extracted text before continuing.
2. **Configure** — pick a provider, paste your API key (stays local), choose a model, and set question count, difficulty, language, and style.
3. **Generate** — the app splits large sources into chunks if needed, calls the LLM, parses and validates the JSON response, and deduplicates near-duplicate questions.
4. **Review & export** — scroll through the generated questions, then download as `.xlsx` (for Quoodle) or `.csv`.

## Excel output format

One worksheet named `Questions`. First row is headers, each subsequent row is one question:

| Question | Correct Answer | Wrong 1 | Wrong 2 | Wrong 3 | Explanation | Source |
|---|---|---|---|---|---|---|
| What distinguishes passive from active transport across a cell membrane? | Active transport requires ATP; passive does not. | Both require ATP but at different rates. | Passive transport only moves ions, active only moves molecules. | Active transport only occurs during cell division. | Passive transport moves substances down their concentration gradient without energy input. Active transport moves substances against the gradient and consumes ATP. A common confusion is to associate "active" with speed rather than energy. | Slide 7 |

The columns and sheet name line up with [Quoodle's](https://github.com/gerhi/quoodle) upload expectations, so you can create a quiz, download the file, and import it into Quoodle without touching the data.

## Supported providers

The default is **Local / OpenAI-compatible**, pre-configured for the RWTH Aachen HPC LLM service.

| Provider | Default base URL | Default model | API key? |
|---|---|---|---|
| **Local / OpenAI-compatible** *(default)* | `https://llm.hpc.itc.rwth-aachen.de/v1/` | `openai/gpt-oss-120b` | yes |
| Anthropic Claude | `https://api.anthropic.com/v1/messages` | `claude-opus-4-5` | yes |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `gpt-4o` | yes |
| Ollama | `http://localhost:11434/v1/chat/completions` | `llama3.1:8b` | no |

URLs ending in `/v1` or `/v1/` automatically have `/chat/completions` appended, so you can paste either form.

## Customizing the prompt

Under **Configure → Advanced: Base URL & Prompt** you can view and edit the full system prompt that is sent to the model. The edited prompt is persisted in `localStorage` and restored on the next visit. A "Restore default" button reverts to the shipped template.

Available placeholders that are interpolated at request time:

| Placeholder | Replaced with |
|---|---|
| `{difficulty}` | `easy`, `medium`, `hard`, or `mixed` |
| `{difficulty_hint}` | One-sentence sub-instruction for that difficulty |
| `{style}` | `factual`, `conceptual`, `applied`, or `mixed` |
| `{style_hint}` | One-sentence sub-instruction for that style |
| `{output_language}` | `German`, `English`, or "the same language as the source material" |

The default template is deliberately tuned for university-level items: it forbids phrasing like "according to the text" or "laut Vorlesung", pushes the model toward questions about **relationships between concepts**, asks for distractors of comparable length, and requires explanations that address the most tempting wrong answer — not just restate the right one.

## Privacy

This app is designed around the principle that teaching material is sensitive.

- **No server-side component.** The repository ships as a static directory. Nothing is logged, stored, or tracked by the application.
- **No cookies, no analytics.** Only `localStorage` is used, and only for user-chosen preferences. The full list is documented in `datenschutz.html`.
- **Files stay local.** Extraction runs in the browser via `pdf.js`, `mammoth.js`, and `JSZip`. Only the extracted *text* is sent to your chosen LLM endpoint.
- **API keys.** Held in memory by default. Browser storage (`localStorage`) is opt-in per provider, with a visible warning on the Configure screen.
- **Full privacy route.** Point the app at a local Ollama server (or the HPC endpoint of an institution with suitable data-processing agreements) and your data never leaves your device or institution.

The repository ships with a German **Impressum** (`impressum.html`) and **Datenschutzerklärung** (`datenschutz.html`) that you can adapt to your situation — placeholders `[Name]`, `[Anschrift]`, `[E-Mail]` at the top of each file mark where to fill in your own details.

## Vendor libraries

The app depends on four JavaScript libraries that run entirely in the browser:

| Library | Version | Purpose |
|---|---|---|
| `pdf.js` | 4.7.76 | PDF text extraction |
| `mammoth.js` | 1.9.0 | DOCX text extraction |
| `JSZip` | 3.10.1 | Reading `.pptx` archives |
| `SheetJS (xlsx)` | 0.18.5 | Excel export |

These are **bundled in the repository** under `vendor/` — the app runs fully offline out of the box, with no CDN calls at runtime.

To refresh to newer versions, edit the pinned versions at the top of `download-vendor.sh` (or `download-vendor.ps1` on Windows) and run the script:

```bash
# macOS / Linux
bash download-vendor.sh

# Windows
powershell -ExecutionPolicy Bypass -File download-vendor.ps1
```

## Project structure

```
quoodle-helper/
├── index.html              App shell (4-step wizard)
├── impressum.html          German legal notice (§ 5 DDG)
├── datenschutz.html        German privacy policy (GDPR / DSGVO)
├── download-vendor.sh      One-time library installer (macOS / Linux)
├── download-vendor.ps1     One-time library installer (Windows)
├── css/
│   ├── styles.css          Main styles (light/dark/system themes)
│   └── legal.css           Reading-focused style for legal pages
├── js/
│   ├── app.js              State, step navigation, event handlers
│   ├── i18n.js             DE / EN translation loader
│   ├── extractors.js       PDF / DOCX / PPTX / TXT / MD → text
│   ├── providers.js        Unified LLM adapter
│   ├── generate.js         Prompt, chunking, JSON parse, dedupe
│   └── export.js           Excel (SheetJS) and CSV export
├── lang/
│   ├── de.json
│   └── en.json
├── vendor/                 Bundled JS libraries (pdf.js, mammoth, JSZip, SheetJS)
└── README.md
```

## Known limitations

- **No OCR.** Scanned image-only PDFs yield no text. OCR via Tesseract.js is planned; a full specification is in the requirements document.
- **PPTX images and SmartArt** are not extracted — only slide text and speaker notes.
- **No in-app editing** of generated questions. Edit in Excel after export if needed.
- **Legacy `.doc` / `.ppt`** are not supported. Save as `.docx` / `.pptx` first.

## Related project

Quoodle Helper is the *authoring* side; [**Quoodle**](https://github.com/gerhi/quoodle) is the *delivery* side. Together they form a small, self-hosted toolchain for formative assessment: create quiz items from your existing material here, then run the quiz with your students there. Both projects share the same philosophy — privacy by design, zero external runtime dependencies, and a single-directory deployment.

## License

MIT. Use it, fork it, adapt it for your course.

## Acknowledgements

This project is companion to [Quoodle](https://github.com/gerhi/quoodle) and was built as a small personal tool for my own teaching. Issues and pull requests are welcome if you find it useful.
