/** Transcription engines the app knows about. */
export type EngineId = 'webspeech' | 'openai' | 'local' | 'mock';

export const ENGINE_LABELS: Record<EngineId, string> = {
  webspeech: 'Browser speech (Web Speech API)',
  openai: 'OpenAI Whisper (server)',
  local: 'Local Whisper (server, offline)',
  mock: 'Mock engine (testing)',
};

/** Short engine names for chips and metadata lines. */
export const ENGINE_SHORT_LABELS: Record<EngineId, string> = {
  webspeech: 'Browser speech',
  openai: 'OpenAI Whisper',
  local: 'Local Whisper',
  mock: 'Mock engine',
};

/** A saved dictation. `text` is what the user keeps; `rawText` is the engine output before cleanup. */
export interface Dictation {
  id: string;
  createdAt: string;
  updatedAt: string;
  text: string;
  rawText: string;
  engine: EngineId;
  language: string;
  durationMs: number;
  wordCount: number;
  polished: boolean;
}

export interface NewDictation {
  text: string;
  rawText: string;
  engine: EngineId;
  language: string;
  durationMs: number;
  polished?: boolean;
}

export interface DictationPatch {
  text?: string;
  polished?: boolean;
}

export interface DictationPage {
  items: Dictation[];
  total: number;
}

export interface Stats {
  count: number;
  words: number;
  totalDurationMs: number;
  averageWpm: number;
  timeSavedMs: number;
}

export interface HealthInfo {
  ok: true;
  version: string;
  engines: Record<Exclude<EngineId, 'webspeech'>, boolean>;
  localModel: string;
  polish: boolean;
  polishModel: string;
}

export interface TranscribeResult {
  text: string;
  engine: EngineId;
  language: string;
  audioDurationMs: number;
  processingMs: number;
}

export type PolishMode = 'clean' | 'formal' | 'casual' | 'concise';

export const POLISH_MODES: Record<PolishMode, { label: string; hint: string }> = {
  clean: { label: 'Clean up', hint: 'Fix punctuation and grammar, keep my words' },
  formal: { label: 'Formal', hint: 'Professional tone, full sentences' },
  casual: { label: 'Casual', hint: 'Relaxed, friendly tone' },
  concise: { label: 'Concise', hint: 'Tighten it up without losing meaning' },
};

export interface DictionaryEntry {
  from: string;
  to: string;
}

export interface PolishRequest {
  text: string;
  mode: PolishMode;
  dictionary?: DictionaryEntry[];
}

export interface PolishResult {
  text: string;
  mode: PolishMode;
  model: string;
}

export interface ApiError {
  error: string;
  code?: string;
}
