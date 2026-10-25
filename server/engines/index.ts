import type { EngineId } from '../../src/shared/types.js';
import type { ServerConfig } from '../config.js';
import { createLocalEngine } from './local.js';
import { createMockEngine } from './mock.js';
import { createOpenAiEngine } from './openai.js';
import type { Engine } from './types.js';

export type EngineRegistry = Map<EngineId, Engine>;

export function createEngines(config: ServerConfig): EngineRegistry {
  const engines: EngineRegistry = new Map();
  engines.set('openai', createOpenAiEngine({ apiKey: config.openaiApiKey, model: config.openaiModel, baseUrl: config.openaiBaseUrl }));
  engines.set('local', createLocalEngine({ model: config.localModel, cacheDir: config.modelCacheDir, dtype: config.localDtype }));
  if (config.enableMockEngine) engines.set('mock', createMockEngine(config.mockText));
  return engines;
}

export { EngineError } from './types.js';
export type { Engine, TranscribeInput, TranscribeOutput } from './types.js';
