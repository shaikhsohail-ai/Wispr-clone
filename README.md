# Wispr Clone

A [Wispr Flow](https://wisprflow.ai)-style voice dictation app: **hold a key, talk, let go, and clean text appears**, ready to paste anywhere. Every dictation is kept in a searchable history with stats on how much you have dictated and how much typing time it saved.

Runs locally as a web app (`npm run dev`) with a small Node server. No account, no telemetry.

## Features

- **Push to talk** with a configurable hotkey (Space, Ctrl + Space, Alt + Space, backtick or F8), in hold-to-talk or press-to-toggle mode. Works with the big microphone button and on touch screens too.
- **Three transcription engines**, picked automatically or by hand:
  | Engine                          | Needs            | Notes                                                                                                   |
  | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
  | Browser speech (Web Speech API) | nothing          | Live words as you speak. Chrome, Edge, Safari. Chrome sends audio to Google.                            |
  | OpenAI Whisper                  | `OPENAI_API_KEY` | Best accuracy. Audio is sent from the server to OpenAI (`whisper-1` by default).                        |
  | Local Whisper                   | nothing (CPU)    | Fully offline after the first run downloads the model. Runs inside the Node server via Transformers.js. |
- **Automatic clean-up**: filler words (um, uh, hmm…) are removed, sentences capitalised, trailing punctuation added, and spoken commands expanded (“comma”, “new paragraph”, “question mark”, “scratch that”…).
- **Personal dictionary** so names and jargon always come out right.
- **AI polish** (optional, needs `ANTHROPIC_API_KEY`): rewrite the dictation with Claude in a clean, formal, casual or concise style, on demand or automatically.
- **History**: searchable, editable, exportable as `.txt`, `.md` or `.json`, stored in a single JSON file you own.
- **Stats**: dictations, words, average speaking speed and estimated time saved versus typing.
- **Clipboard**: every finished dictation is copied automatically (can be turned off).

## Quick start

Requires Node.js 22.13 or newer (Node 22 LTS or 24 LTS; Node 20 is end-of-life).

```bash
npm install
npm run dev
```

Open <http://localhost:5173>, allow the microphone, hold **Space**, speak, release. In Chrome or Edge this works immediately with browser speech recognition.

To use OpenAI or AI polish, copy `.env.example` to `.env`, fill in the keys, and restart `npm run dev`. The server reads `.env` on start (so does the Vite dev proxy, so a custom `PORT` works in both).

### Production build

```bash
npm run build   # web app to dist/, server to dist-server/
npm start       # serves the app and the API on http://127.0.0.1:8787
```

Browsers only allow microphone access on `localhost` or over HTTPS, so to use the app from another device it has to sit behind an HTTPS reverse proxy or a tunnel with `HOST=0.0.0.0`, and the name you serve it under (for example `dictate.example.com`, or `.example.com` for every subdomain) must be listed in `WISPR_ALLOWED_HOSTS`: the API only answers requests addressed to `localhost`, an IP address or a listed name and refuses any other `Host` or `Origin` with a 403, which keeps DNS-rebinding pages out of your history and keys. Before doing that, read [Security and privacy](#security-and-privacy): the API has no login, so the proxy or tunnel itself must require one.

### Security and privacy

- This is a single-user app with **no authentication**. Anything that can reach the port can read, export, edit and delete every dictation, and can use your configured `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` through `/api/transcribe` and `/api/polish` at your expense.
- Keep `HOST=127.0.0.1` (the default) unless the proxy or tunnel in front of it authenticates: HTTP basic auth on nginx/Caddy, a private network such as Tailscale or WireGuard, Cloudflare Access, or similar. A plain TLS proxy or a public tunnel only adds encryption.
- `dictations.json` under `WISPR_DATA_DIR` is plain JSON; back it up and protect it like any other personal file.
- What leaves your machine: Chrome's browser speech sends audio to Google, the OpenAI engine sends audio to OpenAI, AI polish sends text to Anthropic, and local Whisper downloads its model from the Hugging Face Hub once. No telemetry.

## Using it

| Action                | How                                                                   |
| --------------------- | --------------------------------------------------------------------- |
| Dictate               | Hold the hotkey (default **Space**) or the mic button, speak, release |
| Cancel                | **Esc** (or the Cancel button) while listening or transcribing        |
| Copy / edit / delete  | Buttons under the transcript; edits are saved to history              |
| Polish with AI        | Pick a style and press **Polish** (needs `ANTHROPIC_API_KEY`)         |
| Find an old dictation | Search box in the History tab; click one to open it                   |
| Export everything     | `.txt` / `.md` / `.json` buttons in the History tab                   |

The hotkey is ignored while you are typing in a text field, so Space still types spaces. On a focused button or checkbox a Space-based hotkey still starts dictation; pick F8 or the backtick if you want Space free for those controls.

If a transcription request fails (server restarting, engine error, network blip) the audio is kept and the error panel offers **Try again**, so nothing has to be re-dictated.

### Spoken commands

| Say                                                                                        | Get                                                                                                            |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| “period” / “full stop”, “comma”, “question mark”, “exclamation mark”, “colon”, “semicolon” | `.` `,` `?` `!` `:` `;`                                                                                        |
| “new line”, “new paragraph”                                                                | line break, blank line                                                                                         |
| “open quote” … “close quote”, “open paren” … “close paren”                                 | `"…"`, `(…)`                                                                                                   |
| “scratch that” / “delete that”                                                             | removes the sentence you were in the middle of; said after a pause (". Scratch that."), the sentence before it |

By default spoken commands are only applied for browser speech recognition, which does not punctuate by itself; Whisper engines punctuate on their own. Change this under Settings → Clean-up. While commands are on, the words “period”, “comma” and “colon” are always treated as commands (as in other dictation tools), so turn them off to dictate prose that contains those words, or let AI polish, which understands context, handle punctuation.

## Configuration

All settings are optional environment variables (see `.env.example`):

| Variable                                          | Default                       | Purpose                                                                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`                                  | –                             | Enables the OpenAI engine                                                                                                                                                                                                      |
| `OPENAI_TRANSCRIBE_MODEL`                         | `whisper-1`                   | Also `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`                                                                                                                                                                             |
| `OPENAI_BASE_URL`                                 | `https://api.openai.com/v1`   | Any OpenAI-compatible endpoint                                                                                                                                                                                                 |
| `ANTHROPIC_API_KEY`                               | –                             | Enables AI polish (`ANTHROPIC_AUTH_TOKEN` works too, e.g. for a gateway)                                                                                                                                                       |
| `WISPR_POLISH_MODEL`                              | `claude-opus-5-5`             | Model used for polishing                                                                                                                                                                                                       |
| `WISPR_LOCAL_MODEL`                               | `onnx-community/whisper-base` | Hugging Face model id for local Whisper (`…-tiny.en` is faster, `…-small` more accurate)                                                                                                                                       |
| `WISPR_LOCAL_DTYPE`                               | library default               | e.g. `q8` for a smaller, faster model                                                                                                                                                                                          |
| `WISPR_LOCAL_PRELOAD`                             | `0`                           | Load the local model at startup                                                                                                                                                                                                |
| `PORT` / `HOST`                                   | `8787` / `127.0.0.1`          | Server bind address (`PORT` also steers the Vite dev proxy). Keep `127.0.0.1` unless an authenticating proxy sits in front: the API has no login                                                                               |
| `WISPR_ALLOWED_HOSTS`                             | –                             | Extra host names the API answers to behind a proxy or tunnel (comma-separated, no port; `.example.com` also matches its subdomains). `localhost` and IP addresses are always accepted; any other `Host` or `Origin` gets a 403 |
| `WISPR_DATA_DIR`                                  | `data`                        | Where `dictations.json` lives; models go under it unless `WISPR_MODEL_CACHE_DIR` is set                                                                                                                                        |
| `WISPR_MODEL_CACHE_DIR`                           | `<WISPR_DATA_DIR>/models`     | Where local Whisper models are downloaded                                                                                                                                                                                      |
| `WISPR_STATIC_DIR`                                | `dist`                        | Built web app to serve; API-only when it is missing (dev mode behind Vite)                                                                                                                                                     |
| `WISPR_MAX_UPLOAD_MB` / `WISPR_MAX_AUDIO_SECONDS` | `50` / `600`                  | Upload limits                                                                                                                                                                                                                  |
| `WISPR_ENABLE_MOCK_ENGINE`                        | `0`                           | Test engine that returns fixed text (`WISPR_MOCK_TEXT` overrides the text)                                                                                                                                                     |

Local Whisper needs the optional dependency `@huggingface/transformers`, which `npm install` adds automatically. If it fails to install on your platform the engine simply shows as unavailable. The first transcription downloads the model (about 150 MB for `whisper-base`) into `WISPR_MODEL_CACHE_DIR` (default `data/models`).

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
- Firefox and Safari only allow clipboard writes right after a key press or click. When a transcription takes longer than that window, the automatic copy is refused and the message at the bottom offers a Copy button instead.
- The API has no authentication; see [Security and privacy](#security-and-privacy) before exposing it beyond `localhost`.
- Browser speech recognition in Chrome needs an internet connection and is not available in Firefox.
- The OpenAI and Claude integrations cannot be exercised without API keys; they are covered by unit tests with mocked HTTP responses.
- Local Whisper runs on the CPU and takes a few seconds per dictation on a laptop; the larger models are noticeably slower.
