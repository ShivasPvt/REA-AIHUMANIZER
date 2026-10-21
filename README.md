# REA AI Humanizer

A web app with four writing tools, all powered by Claude:

| Tool | What it does |
|---|---|
| **Humanizer** | Rewrites a draft (30–3,000 words) in three distinct versions, scores each with a judge prompt, and shows the best first. Modes: Normal, Clear & Structured. |
| **Paraphraser** | Rewords text (10–3,000 words) by style, strength and length, with frozen terms and optional extra instructions. |
| **Grammar checker** | Makes minimal corrections and lists each edit, which you can accept or reject. |
| **AI writer** | Writes an article, blog post or opinion piece from a title, description, word count and language. |

Facts are protected throughout. Every rewrite prompt forbids changing numbers, names, quotes, URLs and citations. The judge flags meaning changes, and the humanizer drops flagged versions when a clean one exists. Paraphraser output goes through the same fidelity check.

## Run it

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env   # then add your ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

`npm run dev` restarts on file changes. `npm test` runs the test suite with the model stubbed out, so it needs no API key.

## How it works

```
POST /rewrite  ──► validate + charge daily allowance ──► queue job ──► { queued, job_id }
                                                              │
                                                     worker: prompt → Claude
                                                     (humanizer: + judge)
                                                              │
GET /humanize-jobs/{id}  ◄── poll every 2 s ── { status, data | error }
```

- `prompts/` holds the five system prompts (humanizer, judge, paraphraser, grammar, writer). `{{placeholders}}` are filled per request in `src/prompts.js`.
- `src/tools.js` validates each tool's options and runs its pipeline.
- `src/llm.js` calls Claude with streaming, which avoids timeouts on long texts. It handles refusals and enables server-side fallbacks.
- `src/jobs.js` is an in-memory job queue, and `src/allowance.js` tracks a per-visitor daily word allowance. Words are refunded if a job fails.
- `POST /parse-document` extracts text from `.txt`, `.md` and `.docx` uploads.

### API

`POST /rewrite` (or `/{lang}/rewrite`), JSON body:

| Field | Tools | Values |
|---|---|---|
| `type_generation` | all | `humanize`, `paraphraser`, `grammar`, `generation` |
| `text` | humanize, paraphraser, grammar | the draft |
| `html` | same | optional; built from `text` if omitted |
| `language` | same | optional: `en`, `es`, `pt`, `fr`, `de`, `it`, `nl` (auto-detected otherwise) |
| `style` | humanize | `casual` (default), `structured` |
| `frozen_terms` | humanize | comma-separated or array, ≤ 50 |
| `style` | paraphraser | `standard` (default), `fluent`, `formal`, `academic`, `simple`, `creative` |
| `paraphrase_strength` | paraphraser | `low`, `medium` (default), `high` |
| `paraphrase_length` | paraphraser | `shorter`, `same` (default), `longer` |
| `paraphrase_freeze` | paraphraser | comma-separated or array, ≤ 50 |
| `paraphrase_instructions` | paraphraser | free text, ≤ 500 chars |
| `grammar_goal` | grammar | `general` (default), `academic`, `business`, `casual` |
| `generation_type` | generation | `article`, `blog_post`, `essay` |
| `generation_title` | generation | must contain letters |
| `generation_description` | generation | ≤ 100 chars |
| `generation_words` | generation | 100–3,000 |
| `generation_language` | generation | language code, default `en` |

The endpoint returns the following responses:

- `422` with `{ error }` when validation fails.
- `429` with `{ admission: "limit" }` when the daily allowance is used up.
- On success, `{ queued: true, job_id }`.

Poll `GET /humanize-jobs/{job_id}` until `status` is `completed` or `failed`. The humanizer's completed `data` looks like this:

```json
{ "text": "...", "html": "...", "detected_lang": "en",
  "variants": [{ "text": "...", "html": "...", "score": 87, "fidelity_issues": [] }] }
```

When the draft's language is unsupported, `data` is `{ "unsupported_language": true }`.

## Production notes

Jobs and allowances live in memory, so they reset on restart and aren't shared across instances. For more than one server, move both to Redis or a database. Add bot protection (for example Cloudflare Turnstile) before exposing it publicly.
