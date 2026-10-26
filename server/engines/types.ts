import { ENGINE_LABELS, type EngineId } from '../../src/shared/types.js';

/** Every engine id the API accepts, derived from the shared label table so there is a single list. */
export const ENGINE_IDS = Object.keys(ENGINE_LABELS) as EngineId[];

export interface TranscribeInput {
  /** Complete WAV file as uploaded by the browser. */
  wav: Buffer;
  /** BCP-47-ish language code, or 'auto' to let the engine detect. */
  language: string;
  /** Duration measured from the WAV header, handy for engines that want it. */
  durationMs: number;
}

export interface TranscribeOutput {
  text: string;
  language: string;
}

export interface Engine {
  readonly id: EngineId;
  /** Human-readable description for the health endpoint and logs. */
  readonly description: string;
  available(): boolean;
  transcribe(input: TranscribeInput): Promise<TranscribeOutput>;
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
    public readonly code = 'engine_error',
  ) {
    super(message);
    this.name = 'EngineError';
  }
}
