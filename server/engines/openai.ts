import { EngineError, type Engine, type TranscribeInput, type TranscribeOutput } from './types.js';

export interface OpenAiEngineOptions {
  apiKey: string | null;
  model: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** OpenAI audio transcription (`whisper-1`, `gpt-4o-transcribe`, ...). The key never leaves the server. */
export function createOpenAiEngine(options: OpenAiEngineOptions): Engine {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    id: 'openai',
    description: `OpenAI ${options.model}`,
    available: () => Boolean(options.apiKey),
    async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
      if (!options.apiKey) throw new EngineError('OPENAI_API_KEY is not configured on the server', 503, 'engine_unavailable');
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(input.wav)], { type: 'audio/wav' }), 'dictation.wav');
      form.append('model', options.model);
      form.append('response_format', 'json');
      if (input.language && input.language !== 'auto') form.append('language', input.language.split('-')[0]);
      let res: Response;
      try {
        res = await fetchImpl(`${options.baseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new EngineError(`Could not reach OpenAI: ${(err as Error).message}`, 502, 'engine_unreachable');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let detail = body.slice(0, 300);
        try {
          const parsed = JSON.parse(body) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          /* plain-text error body */
        }
        const status = res.status === 401 ? 503 : 502;
        throw new EngineError(`OpenAI transcription failed (${res.status}): ${detail}`, status, 'engine_error');
      }
      const json = (await res.json()) as { text?: string; language?: string };
      return { text: (json.text ?? '').trim(), language: json.language ?? input.language ?? 'auto' };
    },
  };
}
