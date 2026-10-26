import express, { type NextFunction, type Request, type Response } from 'express';
import { isIP } from 'node:net';
import { resolve, sep } from 'node:path';
import type {
  ApiError,
  DictationPatch,
  EngineId,
  HealthInfo,
  NewDictation,
  PolishMode,
  PolishRequest,
  TranscribeResult,
} from '../src/shared/types.js';
import { decodeWav, type DecodedWav } from '../src/shared/wav.js';
import { createBasicAuth } from './auth.js';
import type { ServerConfig } from './config.js';
import { ENGINE_IDS, EngineError, type EngineRegistry } from './engines/index.js';
import { PolishError, type Polisher } from './polish.js';
import { clampDuration, type DictationStore } from './store.js';

export interface AppDeps {
  config: ServerConfig;
  store: DictationStore;
  engines: EngineRegistry;
  polisher: Polisher;
  version: string;
}

const POLISH_MODES: PolishMode[] = ['clean', 'formal', 'casual', 'concise'];
const LANGUAGE_RE = /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/;
const MAX_TEXT_CHARS = 200_000;
const MAX_POLISH_CHARS = 20_000;
const MAX_DICTIONARY_ENTRIES = 200;
/** Dictionary entries are spellings of names and jargon; anything longer is not one and would only pad the prompt. */
const MAX_DICTIONARY_ENTRY_CHARS = 120;
/** Sample rates outside this range are not speech recordings; a forged rate would also defeat the duration limit. */
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'bad_request',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseLanguage(value: unknown): string {
  const lang = typeof value === 'string' && value.trim() ? value.trim() : 'auto';
  if (!LANGUAGE_RE.test(lang)) throw new HttpError(400, `Invalid language "${lang}"`);
  return lang;
}

function parseNewDictation(body: unknown): NewDictation {
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new HttpError(400, 'text is required');
  if (text.length > MAX_TEXT_CHARS) throw new HttpError(413, 'text is too long');
  const rawText = typeof body.rawText === 'string' ? body.rawText : text;
  const engine = body.engine as EngineId;
  if (!ENGINE_IDS.includes(engine)) throw new HttpError(400, 'engine must be one of ' + ENGINE_IDS.join(', '));
  // Clamp rather than reject: losing a transcript over a metadata field would be worse than capping the metadata.
  const durationMs = clampDuration(body.durationMs);
  return {
    text,
    rawText: rawText.slice(0, MAX_TEXT_CHARS),
    engine,
    language: parseLanguage(body.language),
    durationMs,
    polished: body.polished === true,
  };
}

function parsePatch(body: unknown): DictationPatch {
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');
  const patch: DictationPatch = {};
  if ('text' in body) {
    if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'text must be a non-empty string');
    if (body.text.length > MAX_TEXT_CHARS) throw new HttpError(413, 'text is too long');
    patch.text = body.text;
  }
  if ('polished' in body) {
    if (typeof body.polished !== 'boolean') throw new HttpError(400, 'polished must be a boolean');
    patch.polished = body.polished;
  }
  if (!('text' in patch) && !('polished' in patch)) throw new HttpError(400, 'Nothing to update');
  return patch;
}

/** One line of plain text: control characters (including newlines) become spaces so an entry cannot break out of its prompt line. */
function dictionaryField(value: unknown): string {
  return String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .trim();
}

function parsePolishRequest(body: unknown): PolishRequest {
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');
  if (typeof body.text !== 'string') throw new HttpError(400, 'text is required');
  if (body.text.length > MAX_POLISH_CHARS)
    throw new HttpError(413, `text is too long to polish (max ${MAX_POLISH_CHARS.toLocaleString('en-GB')} characters)`);
  const mode = (typeof body.mode === 'string' ? body.mode : 'clean') as PolishMode;
  if (!POLISH_MODES.includes(mode)) throw new HttpError(400, 'mode must be one of ' + POLISH_MODES.join(', '));
  const dictionary = Array.isArray(body.dictionary)
    ? body.dictionary
        .filter(isRecord)
        .map((e) => ({ from: dictionaryField(e.from), to: dictionaryField(e.to) }))
        .filter((e) => e.from && e.from.length <= MAX_DICTIONARY_ENTRY_CHARS && e.to.length <= MAX_DICTIONARY_ENTRY_CHARS)
        .slice(0, MAX_DICTIONARY_ENTRIES)
    : [];
  return { text: body.text, mode, dictionary };
}

function exportDictations(items: ReturnType<DictationStore['all']>, format: string): { body: string; type: string; ext: string } {
  if (format === 'json') return { body: JSON.stringify(items, null, 2), type: 'application/json', ext: 'json' };
  if (format === 'md') {
    const body = items.map((d) => `## ${new Date(d.createdAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC\n\n${d.text}\n`).join('\n');
    return { body: `# Dictations\n\n${body}`, type: 'text/markdown', ext: 'md' };
  }
  if (format === 'txt') {
    const body = items.map((d) => `[${d.createdAt}]\n${d.text}\n`).join('\n');
    return { body, type: 'text/plain', ext: 'txt' };
  }
  throw new HttpError(400, 'format must be txt, md or json');
}

/** Hostname of a `Host` header value or an origin URL, or null when it does not parse. */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Only answer requests addressed to this machine (localhost, any IP literal or a name from WISPR_ALLOWED_HOSTS),
 * and only from pages served under the same name. A page elsewhere whose DNS name is re-pointed at 127.0.0.1
 * (DNS rebinding) would otherwise read and wipe the history and spend the configured API keys; an attacker
 * has to use a DNS name, so IP literals stay open for LAN use with HOST=0.0.0.0.
 *
 * With a password configured the Host check is unnecessary (a rebinding page cannot present the credentials,
 * which the browser only attaches for the origin that supplied them), so any host name is accepted. The Origin
 * check stays: a cross-site page is refused even if it could somehow carry credentials. It compares the Origin
 * with the Host the server sees, so a reverse proxy must pass the original Host header through (the bundled
 * Caddy, cloudflared and the hosting platforms do); one that rewrites it to the upstream address needs the public
 * name in WISPR_ALLOWED_HOSTS instead. X-Forwarded-Host is deliberately not trusted: without a proxy it is
 * whatever the client sends.
 *
 * Rejections are logged once per message: the app polls every few seconds while it is refused, and a 403 is
 * otherwise invisible in platform logs when a deployment is misconfigured.
 */
function createHostGuard(allowedHosts: string[], passwordProtected: boolean, log: (line: string) => void = console.warn) {
  const allowed = (hostname: string | null): boolean => {
    if (!hostname) return false;
    const name = hostname.toLowerCase();
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (isIP(name.replace(/^\[|\]$/g, ''))) return true;
    return allowedHosts.some((entry) => (entry.startsWith('.') ? name === entry.slice(1) || name.endsWith(entry) : name === entry));
  };
  const reported = new Set<string>();
  const reject = (next: NextFunction, message: string, code: string) => {
    if (!reported.has(message)) {
      if (reported.size >= 100) reported.clear();
      reported.add(message);
      log(`[api] 403 ${message}`);
    }
    next(new HttpError(403, message, code));
  };
  return (req: Request, _res: Response, next: NextFunction) => {
    const host = req.headers.host ?? '';
    const hostName = hostnameOf(host);
    if (!passwordProtected && !allowed(hostName)) {
      return reject(
        next,
        `Requests for host "${host}" are not accepted; set WISPR_PASSWORD or add it to WISPR_ALLOWED_HOSTS`,
        'forbidden_host',
      );
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const originName = hostnameOf(origin);
      const sameSite = originName !== null && hostName !== null && originName.toLowerCase() === hostName.toLowerCase();
      if (!sameSite && !allowed(originName)) {
        return reject(
          next,
          `Requests from origin "${origin}" are not accepted for host "${host}"; make the proxy pass the original Host header through, or add the origin's host name to WISPR_ALLOWED_HOSTS`,
          'forbidden_origin',
        );
      }
    }
    next();
  };
}

export function createApp(deps: AppDeps): express.Express {
  const { config, store, engines, polisher } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  if (config.password) {
    app.use(
      createBasicAuth({
        username: config.username,
        password: config.password,
        open: ['/api/health', '/manifest.webmanifest', '/icon.svg'],
      }),
    );
  }

  const api = express.Router();
  api.use(createHostGuard(config.allowedHosts, Boolean(config.password)));
  api.use(express.json({ limit: '2mb' }));

  api.get('/health', (_req, res) => {
    // A platform probe only needs "ok". Which paid API keys are configured is worth knowing to someone deciding
    // whether to guess the password, so the details are kept for the signed-in app.
    if (config.password && !res.locals.authenticated) {
      const probe: HealthInfo = { ok: true };
      res.json(probe);
      return;
    }
    const health: HealthInfo = {
      ok: true,
      version: deps.version,
      engines: {
        openai: engines.get('openai')?.available() ?? false,
        local: engines.get('local')?.available() ?? false,
        mock: engines.get('mock')?.available() ?? false,
      },
      localModel: config.localModel,
      polish: polisher.enabled,
      polishModel: polisher.model,
    };
    res.json(health);
  });

  api.post(
    '/transcribe',
    express.raw({ type: ['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'], limit: config.maxUploadBytes }),
    async (req, res) => {
      const engineId = String(req.query.engine ?? '') as EngineId;
      const engine = engines.get(engineId);
      if (!engine) throw new HttpError(400, `Unknown engine "${engineId}"`);
      if (!engine.available()) throw new HttpError(503, `${engine.description} is not available on this server`, 'engine_unavailable');
      const language = parseLanguage(req.query.language);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new HttpError(400, 'Send the recording as the request body with Content-Type: audio/wav');
      const started = Date.now();
      let decoded: DecodedWav;
      try {
        decoded = decodeWav(req.body);
      } catch (err) {
        throw new HttpError(400, `Could not read the audio: ${(err as Error).message}`);
      }
      if (decoded.sampleRate < MIN_SAMPLE_RATE || decoded.sampleRate > MAX_SAMPLE_RATE)
        throw new HttpError(400, `Unsupported sample rate ${decoded.sampleRate} Hz`);
      if (decoded.channels > 2) throw new HttpError(400, `Unsupported channel count ${decoded.channels}`);
      const durationMs = decoded.durationMs;
      if (durationMs < 150) throw new HttpError(400, 'The recording is too short, nothing was captured', 'empty_audio');
      if (durationMs > config.maxAudioSeconds * 1000)
        throw new HttpError(413, `Recordings are limited to ${config.maxAudioSeconds} seconds`);
      const output = await engine.transcribe({ wav: req.body, language, durationMs });
      const result: TranscribeResult = {
        text: output.text,
        engine: engine.id,
        language: output.language || language,
        audioDurationMs: durationMs,
        processingMs: Date.now() - started,
      };
      res.json(result);
    },
  );

  api.post('/polish', async (req, res) => {
    const request = parsePolishRequest(req.body);
    const result = await polisher.polish(request);
    res.json(result);
  });

  api.get('/dictations', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10) || 50;
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10) || 0;
    res.json(store.list({ q, limit, offset }));
  });

  api.get('/dictations/export', (req, res) => {
    const format = typeof req.query.format === 'string' ? req.query.format : 'txt';
    const file = exportDictations(store.all(), format);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', `${file.type}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="dictations-${date}.${file.ext}"`);
    res.send(file.body);
  });

  api.get('/dictations/:id', (req, res) => {
    const item = store.get(req.params.id);
    if (!item) throw new HttpError(404, 'Dictation not found', 'not_found');
    res.json(item);
  });

  api.post('/dictations', (req, res) => {
    const created = store.create(parseNewDictation(req.body));
    res.status(201).json(created);
  });

  api.patch('/dictations/:id', (req, res) => {
    const updated = store.update(req.params.id, parsePatch(req.body));
    if (!updated) throw new HttpError(404, 'Dictation not found', 'not_found');
    res.json(updated);
  });

  api.delete('/dictations/:id', (req, res) => {
    if (!store.delete(req.params.id)) throw new HttpError(404, 'Dictation not found', 'not_found');
    res.status(204).end();
  });

  api.delete('/dictations', (_req, res) => {
    res.json({ removed: store.clear() });
  });

  api.get('/stats', (_req, res) => {
    res.json(store.stats());
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'No such API route', 'not_found')));

  app.use('/api', api);

  if (config.staticDir) {
    const indexHtml = resolve(config.staticDir, 'index.html');
    const assetsDir = resolve(config.staticDir, 'assets') + sep;
    app.use(
      express.static(config.staticDir, {
        index: 'index.html',
        // Vite content-hashes everything under assets/, so those files can be cached for good. The entry page
        // and the unhashed public files (worklet, manifest, icon) must be revalidated on every load, or a
        // browser keeps an old index.html that points at bundles a rebuild has deleted.
        setHeaders: (res, filePath) => {
          res.setHeader('Cache-Control', filePath.startsWith(assetsDir) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      }),
    );
    app.get(/^(?!\/api(\/|$)).*/, (req, res, next) => {
      if (req.method !== 'GET' || !(req.headers.accept ?? '').includes('text/html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const payload: ApiError = { error: 'Internal server error', code: 'internal' };
    let status = 500;
    const clientStatus = isRecord(err) ? (typeof err.status === 'number' ? err.status : err.statusCode) : undefined;
    if (err instanceof HttpError || err instanceof EngineError || err instanceof PolishError) {
      status = err.status;
      payload.error = err.message;
      payload.code = err.code;
    } else if (isRecord(err) && err.type === 'entity.too.large') {
      status = 413;
      payload.error = 'The upload is too large';
      payload.code = 'too_large';
    } else if (isRecord(err) && err.type === 'entity.parse.failed') {
      status = 400;
      payload.error = 'Malformed JSON body';
      payload.code = 'bad_json';
    } else if (isRecord(err) && typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
      // body-parser (bad Content-Encoding or charset) and the router (undecodable %-escapes in a path) attach a
      // 4xx status; `expose` marks the messages http-errors considers safe to return.
      status = clientStatus;
      payload.error = err.expose === true && typeof err.message === 'string' ? err.message : 'Bad request';
      payload.code = status === 415 ? 'unsupported_media_type' : 'bad_request';
    } else {
      console.error('[api] unhandled error:', err);
    }
    if (status >= 500) console.error(`[api] ${status} ${payload.error}`);
    res.status(status).json(payload);
  });

  return app;
}
