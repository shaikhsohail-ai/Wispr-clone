import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
  /** Extra host names (lower-cased, `.example.com` matches subdomains) the API answers to; localhost and IP literals are always allowed. */
  allowedHosts: string[];
  /** HTTP Basic auth user name; only used when `password` is set. */
  username: string;
  /** When set, every request except /api/health must carry these credentials. */
  password: string | null;
  dataDir: string;
  dataFile: string;
  /** Directory with the built web app, or null to run API-only (dev mode behind Vite). */
  staticDir: string | null;
  openaiApiKey: string | null;
  openaiModel: string;
  openaiBaseUrl: string;
  polishEnabled: boolean;
  polishModel: string;
  localModel: string;
  localDtype: string | null;
  localPreload: boolean;
  modelCacheDir: string;
  enableMockEngine: boolean;
  mockText: string;
  maxUploadBytes: number;
  maxAudioSeconds: number;
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(value: string | undefined, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const dataDir = resolve(cwd, env.WISPR_DATA_DIR || 'data');
  const requestedStatic = env.WISPR_STATIC_DIR ? resolve(cwd, env.WISPR_STATIC_DIR) : resolve(cwd, 'dist');
  const staticDir = existsSync(resolve(requestedStatic, 'index.html')) ? requestedStatic : null;
  return {
    port: intEnv(env.PORT, 8787),
    host: env.HOST || '127.0.0.1',
    allowedHosts: (env.WISPR_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    username: env.WISPR_USERNAME?.trim() || 'wispr',
    password: env.WISPR_PASSWORD?.trim() ? env.WISPR_PASSWORD : null,
    dataDir,
    dataFile: resolve(dataDir, 'dictations.json'),
    staticDir,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    openaiModel: env.OPENAI_TRANSCRIBE_MODEL?.trim() || 'whisper-1',
    openaiBaseUrl: (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    polishEnabled: Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()),
    polishModel: env.WISPR_POLISH_MODEL?.trim() || 'claude-opus-5-5',
    localModel: env.WISPR_LOCAL_MODEL?.trim() || 'onnx-community/whisper-base',
    localDtype: env.WISPR_LOCAL_DTYPE?.trim() || null,
    localPreload: boolEnv(env.WISPR_LOCAL_PRELOAD),
    modelCacheDir: resolve(cwd, env.WISPR_MODEL_CACHE_DIR || resolve(dataDir, 'models')),
    enableMockEngine: boolEnv(env.WISPR_ENABLE_MOCK_ENGINE),
    mockText: env.WISPR_MOCK_TEXT || 'um this is a mock transcription of your audio period it worked exclamation mark',
    maxUploadBytes: intEnv(env.WISPR_MAX_UPLOAD_MB, 50) * 1024 * 1024,
    maxAudioSeconds: intEnv(env.WISPR_MAX_AUDIO_SECONDS, 600),
  };
}

/** Parse a dotenv-style file: KEY=value lines, `#` comments, optional single or double quotes. */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2].replace(/\\n/g, '\n');
    else value = value.replace(/\s+#.*$/, '').trim();
    out[match[1]] = value;
  }
  return out;
}

/** Load `.env` from the working directory into process.env without overriding variables already set. */
export function loadDotEnv(file = resolve(process.cwd(), '.env'), env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(file, 'utf8')))) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
