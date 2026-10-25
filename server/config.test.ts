import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadDotEnv, parseDotEnv } from './config.js';

describe('loadConfig', () => {
  it('uses sensible defaults', () => {
    const c = loadConfig({}, '/repo');
    expect(c.port).toBe(8787);
    expect(c.host).toBe('127.0.0.1');
    expect(c.dataFile).toBe('/repo/data/dictations.json');
    expect(c.modelCacheDir).toBe('/repo/data/models');
    expect(c.openaiApiKey).toBeNull();
    expect(c.polishEnabled).toBe(false);
    expect(c.enableMockEngine).toBe(false);
    expect(c.maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(c.staticDir).toBeNull();
  });

  it('reads overrides and treats falsy strings as off', () => {
    const c = loadConfig(
      {
        PORT: '9000',
        HOST: '0.0.0.0',
        WISPR_DATA_DIR: '/var/wispr',
        OPENAI_API_KEY: ' sk ',
        OPENAI_BASE_URL: 'https://proxy.local/v1///',
        ANTHROPIC_AUTH_TOKEN: 'tok',
        WISPR_ENABLE_MOCK_ENGINE: 'false',
        WISPR_LOCAL_PRELOAD: 'yes',
        WISPR_MAX_UPLOAD_MB: 'abc',
      },
      '/repo',
    );
    expect(c.port).toBe(9000);
    expect(c.host).toBe('0.0.0.0');
    expect(c.dataFile).toBe('/var/wispr/dictations.json');
    expect(c.modelCacheDir).toBe('/var/wispr/models');
    expect(c.openaiApiKey).toBe('sk');
    expect(c.openaiBaseUrl).toBe('https://proxy.local/v1');
    expect(c.polishEnabled).toBe(true);
    expect(c.enableMockEngine).toBe(false);
    expect(c.localPreload).toBe(true);
    expect(c.maxUploadBytes).toBe(50 * 1024 * 1024);
  });
});

describe('dotenv support', () => {
  it('parses comments, quotes and export prefixes', () => {
    const parsed = parseDotEnv(`
# comment
OPENAI_API_KEY=sk-123
export HOST="0.0.0.0"
MOCK='um hello # not a comment'
PORT=9000 # trailing comment
EMPTY=
BROKEN LINE
`);
    expect(parsed).toEqual({ OPENAI_API_KEY: 'sk-123', HOST: '0.0.0.0', MOCK: 'um hello # not a comment', PORT: '9000', EMPTY: '' });
  });

  it('fills only unset variables from the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wispr-env-'));
    const file = join(dir, '.env');
    await writeFile(file, 'PORT=1234\nHOST=example\n');
    const env: NodeJS.ProcessEnv = { HOST: 'keep-me' };
    expect(loadDotEnv(file, env)).toEqual(['PORT']);
    expect(env).toEqual({ HOST: 'keep-me', PORT: '1234' });
    expect(loadDotEnv(join(dir, 'missing.env'), env)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
