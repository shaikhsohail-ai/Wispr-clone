import { describe, expect, it } from 'vitest';
import { createOpenAiEngine } from './openai.js';
import { EngineError } from './types.js';

const input = { wav: Buffer.from('RIFF....'), language: 'en-US', durationMs: 1000 };

describe('openai engine', () => {
  it('is unavailable without a key', async () => {
    const engine = createOpenAiEngine({ apiKey: null, model: 'whisper-1', baseUrl: 'https://api.openai.com/v1' });
    expect(engine.available()).toBe(false);
    await expect(engine.transcribe(input)).rejects.toMatchObject({ status: 503 });
  });

  it('posts multipart form data with the key and returns the text', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ text: '  Hello there.  ' }), { status: 200 });
    }) as typeof fetch;
    const engine = createOpenAiEngine({ apiKey: 'sk-test', model: 'whisper-1', baseUrl: 'https://example.test/v1', fetchImpl });
    expect(engine.available()).toBe(true);
    const out = await engine.transcribe(input);
    expect(out).toEqual({ text: 'Hello there.', language: 'en-US' });
    const { url, init } = captured!;
    expect(url).toBe('https://example.test/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('language')).toBe('en');
    expect(form.get('response_format')).toBe('json');
    const file = form.get('file') as File;
    expect(file.name).toBe('dictation.wav');
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(input.wav.length);
  });

  it('omits language on auto-detect', async () => {
    let form: FormData | null = null;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      form = init?.body as FormData;
      return new Response(JSON.stringify({ text: 'x' }), { status: 200 });
    }) as typeof fetch;
    const engine = createOpenAiEngine({ apiKey: 'k', model: 'm', baseUrl: 'https://x', fetchImpl });
    await engine.transcribe({ ...input, language: 'auto' });
    expect(form!.has('language')).toBe(false);
  });

  it('maps API and network failures to EngineError', async () => {
    const make = (fetchImpl: typeof fetch) => createOpenAiEngine({ apiKey: 'k', model: 'm', baseUrl: 'https://x', fetchImpl });
    const unauthorized = make(
      (async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 })) as typeof fetch,
    );
    await expect(unauthorized.transcribe(input)).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('Incorrect API key'),
    });
    const serverError = make((async () => new Response('upstream exploded', { status: 500 })) as typeof fetch);
    await expect(serverError.transcribe(input)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('upstream exploded'),
    });
    const network = make((async () => {
      throw new Error('ECONNRESET');
    }) as typeof fetch);
    const err = await network.transcribe(input).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.code).toBe('engine_unreachable');
  });
});
