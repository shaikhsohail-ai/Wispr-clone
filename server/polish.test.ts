import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, createPolisher } from './polish.js';

type CreateParams = Record<string, unknown>;

function fakeClient(respond: (params: CreateParams) => unknown) {
  const calls: CreateParams[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: CreateParams) => {
          calls.push(params);
          return respond(params);
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const textResponse = (text: string, extra: Record<string, unknown> = {}) => ({
  model: 'claude-test',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  ...extra,
});

describe('polisher', () => {
  it('is disabled without credentials', async () => {
    const polisher = createPolisher({ enabled: false, model: 'm' });
    expect(polisher.enabled).toBe(false);
    await expect(polisher.polish({ text: 'hi', mode: 'clean' })).rejects.toMatchObject({ status: 503, code: 'polish_unavailable' });
  });

  it('sends the transcript with a mode-specific system prompt and returns the text', async () => {
    const { client, calls } = fakeClient(() => textResponse('"Hello, world."'));
    const polisher = createPolisher({ enabled: true, model: 'claude-opus-5-5', client });
    const result = await polisher.polish({ text: 'um hello world', mode: 'formal', dictionary: [{ from: 'wispr', to: 'Wispr' }] });
    expect(result).toEqual({ text: 'Hello, world.', mode: 'formal', model: 'claude-test' });
    expect(calls).toHaveLength(1);
    const params = calls[0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.messages).toEqual([{ role: 'user', content: 'um hello world' }]);
    expect(String(params.system)).toContain('professional');
    expect(String(params.system)).toContain('"wispr" -> "Wispr"');
  });

  it('short-circuits empty input without calling the API', async () => {
    const { client, calls } = fakeClient(() => textResponse('x'));
    const polisher = createPolisher({ enabled: true, model: 'm', client });
    expect(await polisher.polish({ text: '   ', mode: 'clean' })).toEqual({ text: '', mode: 'clean', model: 'm' });
    expect(calls).toHaveLength(0);
  });

  it('maps refusals and empty replies to errors', async () => {
    const refused = createPolisher({
      enabled: true,
      model: 'm',
      client: fakeClient(() => textResponse('', { stop_reason: 'refusal' })).client,
    });
    await expect(refused.polish({ text: 'hi', mode: 'clean' })).rejects.toMatchObject({ status: 422, code: 'polish_refused' });
    const empty = createPolisher({ enabled: true, model: 'm', client: fakeClient(() => textResponse('   ')).client });
    await expect(empty.polish({ text: 'hi', mode: 'clean' })).rejects.toMatchObject({ status: 502, code: 'polish_empty' });
    const broken = createPolisher({
      enabled: true,
      model: 'm',
      client: fakeClient(() => {
        throw new Error('socket hang up');
      }).client,
    });
    await expect(broken.polish({ text: 'hi', mode: 'clean' })).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('socket hang up'),
    });
  });

  it('keeps quotes that are part of the text', async () => {
    const polisher = createPolisher({ enabled: true, model: 'm', client: fakeClient(() => textResponse('"Yes," she said. "Go."')).client });
    expect((await polisher.polish({ text: 'x', mode: 'clean' })).text).toBe('"Yes," she said. "Go."');
  });

  it('builds prompts for every mode', () => {
    for (const mode of ['clean', 'formal', 'casual', 'concise'] as const) {
      const prompt = buildSystemPrompt(mode);
      expect(prompt).toContain('Return only the cleaned text');
      expect(prompt).toContain('Style for this request');
    }
  });
});
