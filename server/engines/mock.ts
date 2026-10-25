import type { Engine, TranscribeInput, TranscribeOutput } from './types.js';

/** Deterministic engine for end-to-end tests and demos without any speech backend. */
export function createMockEngine(text: string): Engine {
  return {
    id: 'mock',
    description: 'Mock engine (fixed text)',
    available: () => true,
    async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
      const seconds = (input.durationMs / 1000).toFixed(1);
      return { text: `${text} ${seconds} seconds of audio received`, language: input.language || 'auto' };
    },
  };
}
