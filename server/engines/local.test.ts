import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/shared/wav.js';
import { createLocalEngine, type TransformersModule } from './local.js';

function fakeModule(
  record: { calls: Array<{ model: string; options: unknown; audioLength: number; generate: unknown }> },
  text = 'local words',
): TransformersModule {
  return {
    env: {},
    pipeline: async (_task, model, options) => {
      return async (audio: Float32Array, generate?: Record<string, unknown>) => {
        record.calls.push({ model, options, audioLength: audio.length, generate });
        return { text };
      };
    },
  };
}

const wavBuffer = (seconds: number, rate: number) => Buffer.from(encodeWav(new Float32Array(Math.round(seconds * rate)).fill(0.1), rate));

describe('local engine', () => {
  it('loads the pipeline once, resamples to 16 kHz and forwards the language', async () => {
    const record = { calls: [] as Array<{ model: string; options: unknown; audioLength: number; generate: unknown }> };
    const engine = createLocalEngine({
      model: 'onnx-community/whisper-base',
      cacheDir: '/tmp/cache',
      dtype: 'q8',
      loadTransformers: async () => fakeModule(record),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.available()).toBe(true);
    expect(engine.status()).toBe('idle');
    const out = await engine.transcribe({ wav: wavBuffer(1, 48_000), language: 'fr-FR', durationMs: 1000 });
    expect(out).toEqual({ text: 'local words', language: 'fr-FR' });
    expect(engine.status()).toBe('ready');
    await engine.transcribe({ wav: wavBuffer(0.5, 16_000), language: 'auto', durationMs: 500 });
    expect(record.calls).toHaveLength(2);
    expect(record.calls[0].audioLength).toBe(16_000);
    expect(record.calls[0].options).toEqual({ dtype: 'q8' });
    expect(record.calls[0].generate).toMatchObject({ task: 'transcribe', language: 'fr', chunk_length_s: 30 });
    expect(record.calls[1].generate).not.toHaveProperty('language');
  });

  it('never passes language to English-only models', async () => {
    const record = { calls: [] as Array<{ model: string; options: unknown; audioLength: number; generate: unknown }> };
    const engine = createLocalEngine({
      model: 'onnx-community/whisper-tiny.en',
      cacheDir: '/tmp/cache',
      loadTransformers: async () => fakeModule(record),
    });
    await engine.transcribe({ wav: wavBuffer(1, 16_000), language: 'en-US', durationMs: 1000 });
    expect(record.calls[0].generate).not.toHaveProperty('language');
    expect(record.calls[0].generate).not.toHaveProperty('task');
  });

  it('reports unavailability when the optional dependency is missing', async () => {
    const engine = createLocalEngine({
      model: 'm',
      cacheDir: '/tmp/cache',
      loadTransformers: async () => {
        throw new Error("Cannot find package '@huggingface/transformers'");
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.available()).toBe(false);
    await expect(engine.transcribe({ wav: wavBuffer(1, 16_000), language: 'auto', durationMs: 1000 })).rejects.toMatchObject({
      status: 503,
      code: 'engine_unavailable',
    });
  });

  it('wraps model load failures and allows a retry', async () => {
    let attempts = 0;
    const engine = createLocalEngine({
      model: 'm',
      cacheDir: '/tmp/cache',
      loadTransformers: async () => ({
        env: {},
        pipeline: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('download failed');
          return async () => ({ text: 'second time lucky' });
        },
      }),
    });
    await expect(engine.transcribe({ wav: wavBuffer(1, 16_000), language: 'auto', durationMs: 1000 })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('download failed'),
    });
    expect(engine.status()).toBe('error');
    const out = await engine.transcribe({ wav: wavBuffer(1, 16_000), language: 'auto', durationMs: 1000 });
    expect(out.text).toBe('second time lucky');
  });
});
