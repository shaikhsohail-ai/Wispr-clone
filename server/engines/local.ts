import { decodeWav, resample } from '../../src/shared/wav.js';
import { EngineError, type Engine, type TranscribeInput, type TranscribeOutput } from './types.js';

export interface LocalEngineOptions {
  model: string;
  cacheDir: string;
  dtype?: string | null;
  /** Injected for tests; defaults to a dynamic import of @huggingface/transformers. */
  loadTransformers?: () => Promise<TransformersModule>;
}

/** The slice of Transformers.js this engine relies on. */
export interface TransformersModule {
  env: { cacheDir?: string; allowLocalModels?: boolean };
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<AsrPipeline>;
}

export type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string } | Array<{ text: string }>>;

const TARGET_RATE = 16_000;

/**
 * Whisper running inside the Node process via Transformers.js (ONNX Runtime). The model is
 * downloaded from the Hugging Face Hub on first use and cached under `cacheDir`; nothing is
 * sent anywhere afterwards.
 */
export interface LocalEngine extends Engine {
  /** Settles once the optional dependency has been probed, i.e. once `available()` is accurate. */
  readonly ready: Promise<void>;
  warmup(): Promise<void>;
  status(): LocalStatus;
}

export function createLocalEngine(options: LocalEngineOptions): LocalEngine {
  let modulePromise: Promise<TransformersModule | null> | null = null;
  let pipelinePromise: Promise<AsrPipeline> | null = null;
  let status: LocalStatus = 'idle';
  let importable: boolean | null = null;

  const loadModule = () => {
    if (!modulePromise) {
      modulePromise = (options.loadTransformers ?? defaultLoader)()
        .then((m) => {
          importable = true;
          return m;
        })
        .catch((err: unknown) => {
          importable = false;
          console.warn(`[local] @huggingface/transformers unavailable: ${(err as Error).message}`);
          return null;
        });
    }
    return modulePromise;
  };

  const loadPipeline = async (): Promise<AsrPipeline> => {
    if (!pipelinePromise) {
      status = 'loading';
      pipelinePromise = (async () => {
        const mod = await loadModule();
        if (!mod)
          throw new EngineError(
            'Local Whisper is not installed (optional dependency @huggingface/transformers missing)',
            503,
            'engine_unavailable',
          );
        mod.env.cacheDir = options.cacheDir;
        const pipelineOptions: Record<string, unknown> = {};
        if (options.dtype) pipelineOptions.dtype = options.dtype;
        const started = Date.now();
        console.log(`[local] loading ${options.model} (first run downloads the model to ${options.cacheDir})`);
        const asr = await mod.pipeline('automatic-speech-recognition', options.model, pipelineOptions);
        console.log(`[local] model ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        status = 'ready';
        return asr;
      })().catch((err: unknown) => {
        pipelinePromise = null;
        status = 'error';
        if (err instanceof EngineError) throw err;
        throw new EngineError(`Could not load local Whisper model ${options.model}: ${(err as Error).message}`, 503, 'engine_unavailable');
      });
    }
    return pipelinePromise;
  };

  // Probe importability eagerly so the health endpoint is accurate without loading the model; the server
  // awaits `ready` before listening so neither the banner nor /api/health can observe the pending state.
  const ready = loadModule().then(() => undefined);

  return {
    id: 'local',
    description: `Local Whisper (${options.model})`,
    ready,
    available: () => importable !== false,
    status: () => status,
    warmup: async () => {
      await loadPipeline();
    },
    async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
      const asr = await loadPipeline();
      const decoded = decodeWav(input.wav);
      const audio = resample(decoded.samples, decoded.sampleRate, TARGET_RATE);
      const generate: Record<string, unknown> = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: false };
      const englishOnly = /\.en$/i.test(options.model);
      if (!englishOnly) {
        generate.task = 'transcribe';
        if (input.language && input.language !== 'auto') generate.language = input.language.split('-')[0];
      }
      let result: Awaited<ReturnType<AsrPipeline>>;
      try {
        result = await asr(audio, generate);
      } catch (err) {
        throw new EngineError(`Local transcription failed: ${(err as Error).message}`, 500, 'engine_error');
      }
      const text = Array.isArray(result) ? result.map((r) => r.text).join(' ') : result.text;
      return { text: (text ?? '').trim(), language: input.language || 'auto' };
    },
  };
}

export type LocalStatus = 'idle' | 'loading' | 'ready' | 'error';

async function defaultLoader(): Promise<TransformersModule> {
  const name = '@huggingface/transformers';
  const mod = (await import(name)) as unknown as TransformersModule;
  return mod;
}
