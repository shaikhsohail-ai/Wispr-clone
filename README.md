# Wispr Clone

A [Wispr Flow](https://wisprflow.ai)-style voice dictation app: **hold a key, talk, let go, and clean text appears**, ready to paste anywhere. Every dictation is kept in a searchable history with stats on how much you have dictated and how much typing time it saved.

Runs locally as a web app (`npm run dev`) with a small Node server. No account, no telemetry.

## Features

- **Push to talk** with a configurable hotkey (Space, Ctrl + Space, Alt + Space, backtick or F8), in hold-to-talk or press-to-toggle mode. Works with the big microphone button and on touch screens too.
- **Three transcription engines**, picked automatically or by hand:
  | Engine | Needs | Notes |
  | --- | --- | --- |
  | Browser speech (Web Speech API) | nothing | Live words as you speak. Chrome, Edge, Safari. Chrome sends audio to Google. |
  | OpenAI Whisper | `OPENAI_API_KEY` | Best accuracy. Audio is sent from the server to OpenAI (`whisper-1` by default). |
  | Local Whisper | nothing (CPU) | Fully offline after the first run downloads the model. Runs inside the Node server via Transformers.js. |
- **Automatic clean-up**: filler words (um, uh, hmm…) are removed, sentences capitalised, trailing punctuation added, and spoken commands expanded (“comma”, “new paragraph”, “question mark”, “scratch that”…).
- **Personal dictionary** so names and jargon always come out right.
- **AI polish** (optional, needs `ANTHROPIC_API_KEY`): rewrite the dictation with Claude in a clean, formal, casual or concise style, on demand or automatically.
- **History**: searchable, editable, exportable as `.txt`, `.md` or `.json`, stored in a single JSON file you own.
- **Stats**: dictations, words, average speaking speed and estimated time saved versus typing.
- **Clipboard**: every finished dictation is copied automatically (can be turned off).

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>, allow the microphone, hold **Space**, speak, release. In Chrome or Edge this works immediately with browser speech recognition.

To use OpenAI or AI polish, copy `.env.example` to `.env`, fill in the keys, and restart `npm run dev`. The server reads `.env` on start.

### Production build

```bash
npm run build   # web app to dist/, server to dist-server/
npm start       # serves the app and the API on http://127.0.0.1:8787
```

Browsers only allow microphone access on `localhost` or over HTTPS, so to use the app from another device put it behind an HTTPS reverse proxy or a tunnel, and set `HOST=0.0.0.0`.

## Using it

| Action | How |
| --- | --- |
| Dictate | Hold the hotkey (default **Space**) or the mic button, speak, release |
| Cancel a recording | **Esc** |
| Copy / edit / delete | Buttons under the transcript; edits are saved to history |
| Polish with AI | Pick a style and press **Polish** (needs `ANTHROPIC_API_KEY`) |
| Find an old dictation | Search box in the History tab; click one to open it |
| Export everything | `.txt` / `.md` / `.json` buttons in the History tab |

The hotkey is ignored while you are typing in a text field, so Space still types spaces.

### Spoken commands

| Say | Get |
| --- | --- |
| “period” / “full stop”, “comma”, “question mark”, “exclamation mark”, “colon”, “semicolon” | `.` `,` `?` `!` `:` `;` |
| “new line”, “new paragraph” | line break, blank line |
| “open quote” … “close quote”, “open paren” … “close paren” | `"…"`, `(…)` |
| “scratch that” / “delete that” | removes the sentence you were in the middle of |

By default spoken commands are only applied for browser speech recognition, which does not punctuate by itself; Whisper engines punctuate on their own. Change this under Settings → Clean-up.

## Configuration

All settings are optional environment variables (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | – | Enables the OpenAI engine |
| `OPENAI_TRANSCRIBE_MODEL` | `whisper-1` | Also `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | – | Enables AI polish |
| `WISPR_POLISH_MODEL` | `claude-opus-5-5` | Model used for polishing |
| `WISPR_LOCAL_MODEL` | `onnx-community/whisper-base` | Hugging Face model id for local Whisper (`…-tiny.en` is faster, `…-small` more accurate) |
| `WISPR_LOCAL_DTYPE` | library default | e.g. `q8` for a smaller, faster model |
| `WISPR_LOCAL_PRELOAD` | `0` | Load the local model at startup |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Server bind address |
| `WISPR_DATA_DIR` | `data` | Where `dictations.json` and downloaded models live |
| `WISPR_MAX_UPLOAD_MB` / `WISPR_MAX_AUDIO_SECONDS` | `50` / `600` | Upload limits |
| `WISPR_ENABLE_MOCK_ENGINE` | `0` | Test engine that returns fixed text |

Local Whisper needs the optional dependency `@huggingface/transformers`, which `npm install` adds automatically. If it fails to install on your platform the engine simply shows as unavailable. The first transcription downloads the model (about 150 MB for `whisper-base`) into `data/models`.

AI polish calls the Claude API with server-side fallbacks enabled, so a request the primary model declines for policy reasons is retried on Anthropic's default fallback model inside the same call. Set `WISPR_POLISH_MODEL` to change the model.

## How it works

```
browser                                  server (Express)
──────────────────────────────           ─────────────────────────────────────
mic → AudioWorklet → 16 kHz WAV ───────▶ POST /api/transcribe?engine=…
      (or Web Speech API, live)            ├─ openai: OpenAI audio API
                                           ├─ local:  Whisper via Transformers.js
clean-up (fillers, commands, dictionary)   └─ mock:   fixed text for tests
      ▼
optional AI polish ────────────────────▶ POST /api/polish (Claude)
      ▼
save + copy to clipboard ──────────────▶ POST /api/dictations  →  data/dictations.json
```

- `src/` – React front end (`hooks/useDictation.ts` is the state machine; `lib/recorder.ts` captures PCM; `lib/webspeech.ts` wraps the browser recogniser).
- `src/shared/` – code used by both sides: transcript clean-up (`text.ts`), WAV encode/decode, API types.
- `server/` – Express API, transcription engines, Claude polish, JSON history store.
- `e2e/` – Playwright tests that drive the built app with a synthetic microphone and the mock engine.

## Development

```bash
npm run check      # lint + typecheck + unit tests
npm test           # unit tests (Vitest)
npm run test:e2e   # builds the web app, then runs Playwright against the real server
npm run lint
npm run typecheck
npm run format
```

## Limitations

- This is a web app, so it cannot type into other applications the way the desktop Wispr Flow does. Dictations are copied to the clipboard instead; paste with Ctrl/Cmd + V.
- Browser speech recognition in Chrome needs an internet connection and is not available in Firefox.
- The OpenAI and Claude integrations cannot be exercised without API keys; they are covered by unit tests with mocked HTTP responses.
- Local Whisper runs on the CPU and takes a few seconds per dictation on a laptop; the larger models are noticeably slower.
