import express, { type NextFunction, type Request, type Response } from 'express';
import { resolve } from 'node:path';
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
import { decodeWav } from '../src/shared/wav.js';
import type { ServerConfig } from './config.js';
import { EngineError, type EngineRegistry } from './engines/index.js';
import { PolishError, type Polisher } from './polish.js';
import type { DictationStore } from './store.js';

export interface AppDeps {
  config: ServerConfig;
  store: DictationStore;
  engines: EngineRegistry;
  polisher: Polisher;
  version: string;
}

const ENGINE_IDS: EngineId[] = ['webspeech', 'openai', 'local', 'mock'];
const POLISH_MODES: PolishMode[] = ['clean', 'formal', 'casual', 'concise'];
const LANGUAGE_RE = /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/;
const MAX_TEXT_CHARS = 200_000;

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
  const durationMs = typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) ? body.durationMs : 0;
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

function parsePolishRequest(body: unknown): PolishRequest {
  if (!isRecord(body)) throw new HttpError(400, 'Expected a JSON object');
  if (typeof body.text !== 'string') throw new HttpError(400, 'text is required');
  if (body.text.length > 20_000) throw new HttpError(413, 'text is too long to polish (max 20,000 characters)');
  const mode = (typeof body.mode === 'string' ? body.mode : 'clean') as PolishMode;
  if (!POLISH_MODES.includes(mode)) throw new HttpError(400, 'mode must be one of ' + POLISH_MODES.join(', '));
  const dictionary = Array.isArray(body.dictionary)
    ? body.dictionary
        .filter(isRecord)
        .map((e) => ({ from: String(e.from ?? ''), to: String(e.to ?? '') }))
        .filter((e) => e.from.trim())
        .slice(0, 200)
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

export function createApp(deps: AppDeps): express.Express {
  const { config, store, engines, polisher } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  api.get('/health', (_req, res) => {
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
      let durationMs: number;
      try {
        durationMs = decodeWav(req.body).durationMs;
      } catch (err) {
        throw new HttpError(400, `Could not read the audio: ${(err as Error).message}`);
      }
      if (durationMs < 150) throw new HttpError(400, 'The recording is too short, nothing was captured', 'empty_audio');
      if (durationMs > config.maxAudioSeconds * 1000)
        throw new HttpError(413, `Recordings are limited to ${config.maxAudioSeconds} seconds`);
      const started = Date.now();
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
    app.use(express.static(config.staticDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^(?!\/api(\/|$)).*/, (req, res, next) => {
      if (req.method !== 'GET' || !(req.headers.accept ?? '').includes('text/html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const payload: ApiError = { error: 'Internal server error', code: 'internal' };
    let status = 500;
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
    } else {
      console.error('[api] unhandled error:', err);
    }
    if (status >= 500) console.error(`[api] ${status} ${payload.error}`);
    res.status(status).json(payload);
  });

  return app;
}
