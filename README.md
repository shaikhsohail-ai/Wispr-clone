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

Browsers only allow microphone access on `localhost` or over HTTPS, so to use the app from another device it has to run behind HTTPS with `HOST=0.0.0.0` and, because it is then reachable by others, with `WISPR_PASSWORD` set. See [Deploying](#deploying) for ready-made Docker, Fly.io, Render and Railway setups and the usual pitfalls.

### Security and privacy

- This is a single-user app. Without `WISPR_PASSWORD`, anything that can reach the port can read, export, edit and delete every dictation, and can use your configured `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` through `/api/transcribe` and `/api/polish` at your expense.
- Keep `HOST=127.0.0.1` (the default) unless you set `WISPR_PASSWORD` (HTTP Basic auth: the browser asks once and remembers it) or the proxy or tunnel in front of it authenticates (Cloudflare Access, Tailscale, WireGuard, basic auth on nginx/Caddy). A plain TLS proxy or a public tunnel only adds encryption.
- Without a password the API refuses requests whose `Host` is not `localhost`, an IP address or a name in `WISPR_ALLOWED_HOSTS` (DNS-rebinding protection). With a password that check is not needed and any host name works.
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
| `WISPR_PASSWORD`                                  | –                             | Password-protect the app (HTTP Basic auth). Required once the server is reachable by others                                                                                                                                    |
| `WISPR_USERNAME`                                  | `wispr`                       | User name that goes with `WISPR_PASSWORD`                                                                                                                                                                                      |
| `WISPR_ALLOWED_HOSTS`                             | –                             | Extra host names the API answers to behind a proxy or tunnel (comma-separated, no port; `.example.com` also matches its subdomains). `localhost` and IP addresses are always accepted; any other `Host` or `Origin` gets a 403 |
| `WISPR_DATA_DIR`                                  | `data`                        | Where `dictations.json` lives; models go under it unless `WISPR_MODEL_CACHE_DIR` is set                                                                                                                                        |
| `WISPR_MODEL_CACHE_DIR`                           | `<WISPR_DATA_DIR>/models`     | Where local Whisper models are downloaded                                                                                                                                                                                      |
| `WISPR_STATIC_DIR`                                | `dist`                        | Built web app to serve; API-only when it is missing (dev mode behind Vite)                                                                                                                                                     |
| `WISPR_MAX_UPLOAD_MB` / `WISPR_MAX_AUDIO_SECONDS` | `50` / `600`                  | Upload limits                                                                                                                                                                                                                  |
| `WISPR_ENABLE_MOCK_ENGINE`                        | `0`                           | Test engine that returns fixed text (`WISPR_MOCK_TEXT` overrides the text)                                                                                                                                                     |

Local Whisper needs the optional dependency `@huggingface/transformers`, which `npm install` adds automatically. If it fails to install on your platform the engine simply shows as unavailable. The first transcription downloads the model (about 150 MB for `whisper-base`) into `WISPR_MODEL_CACHE_DIR` (default `data/models`).

AI polish calls the Claude API with server-side fallbacks enabled, so a request the primary model declines for policy reasons is retried on Anthropic's default fallback model inside the same call. Set `WISPR_POLISH_MODEL` to change the model.

## Deploying

Wispr Clone is a Node server that serves the web app and keeps `dictations.json` on disk. It needs a host that runs a long-lived process with a persistent volume: a VPS or any machine with Docker, Fly.io, Render, Railway, or simply your own computer behind a tunnel. It cannot be deployed to a static host (GitHub Pages, Netlify or Vercel static hosting) because the API would not exist there, and serverless platforms lose the history file between invocations.

Every deployment needs the same four things. Most "it does not work" reports come down to one of them.

1. **`HOST=0.0.0.0`.** The server binds to localhost by default, so inside a container it is unreachable until this is set. The Dockerfile and the platform files below set it.
2. **A persistent volume for `WISPR_DATA_DIR`** (the Docker image uses `/data`), or the history and the downloaded Whisper model disappear on every redeploy.
3. **HTTPS.** Browsers only expose the microphone on `https://` or `localhost`. Every option below provides a certificate.
4. **`WISPR_PASSWORD`.** Once the URL is reachable by others, anyone could read your dictations and spend your API keys. The browser asks once and remembers it. (Without a password you must instead list your host name in `WISPR_ALLOWED_HOSTS`, or every API call answers 403.)

Local Whisper needs about 1 GB of RAM for `whisper-base` and adds about 800 MB to the Docker image (ONNX Runtime ships binaries for every platform). On a small instance either give it 1 to 2 GB, or build with `--build-arg LOCAL_WHISPER=0` for a 40 MB-of-dependencies image that offers browser speech and OpenAI only.

### Docker on a VPS (or any machine)

```bash
git clone https://github.com/shaikhsohail-ai/Wispr-clone.git && cd Wispr-clone
cp .env.example .env            # set WISPR_PASSWORD and any API keys
docker compose up -d --build    # http://localhost:8787 on that machine
```

For a public HTTPS address, point a DNS name at the machine, open ports 80 and 443, and start the bundled Caddy proxy, which fetches a Let's Encrypt certificate automatically:

```bash
DOMAIN=dictate.example.com docker compose --profile https up -d --build
```

Dictations live in the `wispr-data` Docker volume. Update with `git pull && docker compose up -d --build`.

### Fly.io

```bash
fly launch --copy-config --no-deploy --name <your-app-name>   # uses the fly.toml in the repo
fly volumes create wispr_data --size 1                        # persistent /data
fly secrets set WISPR_PASSWORD=<choose one> OPENAI_API_KEY=... ANTHROPIC_API_KEY=...
fly deploy
```

The app is then at `https://<your-app-name>.fly.dev`. `fly.toml` requests 1 GB of memory and stops the machine when idle; use `fly scale memory 2048` if you run local Whisper with a larger model.

### Render

New → Blueprint → select this repository; `render.yaml` defines a Docker web service with a 1 GB disk at `/data` and a health check. Fill in `WISPR_PASSWORD` (and the API keys you use) when prompted. A persistent disk requires a paid instance; on the free tier the history is wiped on each deploy and the service sleeps when idle.

### Railway

New project → Deploy from GitHub repo (the Dockerfile is detected). Then: add a **Volume** mounted at `/data`; set the variables `WISPR_DATA_DIR=/data`, `HOST=0.0.0.0` and `WISPR_PASSWORD`; generate a public domain under Settings → Networking. Railway supplies `PORT` itself.

### Your own computer, no server

For a personal tool this is often the best option: dictations never leave your machine and local Whisper uses your own CPU.

```bash
npm run build && WISPR_PASSWORD=<choose one> npm start
```

Then expose port 8787 with a tunnel that gives you HTTPS: `cloudflared tunnel --url http://localhost:8787` (Cloudflare Tunnel; a free `trycloudflare.com` URL, or a named tunnel for a stable address), or `tailscale serve 8787` to reach it from your other devices over Tailscale only. Keep the password even on Tailscale unless the network is yours alone.

### If it does not work

| Symptom                                                                     | Cause and fix                                                                                                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The platform says the service never became healthy, or the page never loads | The server is bound to localhost. Set `HOST=0.0.0.0`. Check the logs for the "listening on" line and make sure `/api/health` answers.               |
| `403` with "Requests for host … are not accepted"                           | No password and the host name is not allowed. Set `WISPR_PASSWORD`, or add the name to `WISPR_ALLOWED_HOSTS`.                                       |
| `401` or a login prompt                                                     | `WISPR_PASSWORD` is set; sign in with user `wispr` (or `WISPR_USERNAME`) and that password.                                                         |
| "Microphone access was blocked" or no microphone prompt                     | The page is not served over HTTPS (or `localhost`). Add TLS in front of it.                                                                         |
| History is empty after a redeploy                                           | `WISPR_DATA_DIR` is not on a persistent volume. Mount one and point the variable at it.                                                             |
| Container restarts or is killed on the first transcription                  | Out of memory loading local Whisper. Give it 1 to 2 GB, pick a smaller `WISPR_LOCAL_MODEL`, or build with `LOCAL_WHISPER=0` and use another engine. |
| "Server offline" in the top bar                                             | The browser cannot reach `/api/*` on the same origin. The app and API must be served from one host; do not split them across two services.          |
| Build fails on the host                                                     | Node 22.13 or newer is required (`engines` in `package.json`); the Docker image already uses Node 22.                                               |

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
