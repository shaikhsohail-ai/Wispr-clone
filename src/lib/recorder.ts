import { encodeWav, mergeChunks, resample } from '../shared/wav';

export const TARGET_SAMPLE_RATE = 16_000;

export interface RecordingResult {
  wav: Blob;
  durationMs: number;
  sampleRate: number;
  sampleCount: number;
  /** Loudest absolute sample, used to warn when the microphone captured silence. */
  peak: number;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

export class RecorderError extends Error {
  constructor(
    message: string,
    public readonly code: 'denied' | 'no-device' | 'unsupported' | 'failed',
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

/**
 * Captures the microphone as raw PCM through an AudioWorklet (ScriptProcessor fallback)
 * and turns it into a 16 kHz mono WAV, which every transcription engine accepts.
 */
export class PcmRecorder {
  state: RecorderState = 'idle';
  analyser: AnalyserNode | null = null;

  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private levelBuffer: Float32Array<ArrayBuffer> | null = null;
  private flushed: (() => void) | null = null;
  /** Set by cancel(); a start() that is still waiting for the microphone then releases it instead of recording. */
  private cancelled = false;

  constructor(private readonly workletUrl = `${import.meta.env.BASE_URL}pcm-worklet.js`) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== 'undefined';
  }

  async start(deviceId?: string): Promise<void> {
    if (this.state !== 'idle') throw new RecorderError('Recorder is busy', 'failed');
    if (!PcmRecorder.isSupported()) throw new RecorderError('This browser cannot record audio', 'unsupported');
    this.state = 'starting';
    this.cancelled = false;
    this.chunks = [];
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.state = 'idle';
      throw toRecorderError(err);
    }
    if (this.cancelled) {
      // cancel() ran while the permission prompt or device was still opening: let the microphone go again.
      stream.getTracks().forEach((t) => t.stop());
      this.state = 'idle';
      throw new RecorderError('Recording was cancelled', 'failed');
    }
    this.stream = stream;
    try {
      await this.buildGraph();
      if (this.cancelled) throw new RecorderError('Recording was cancelled', 'failed');
      this.state = 'recording';
    } catch (err) {
      await this.teardown();
      this.state = 'idle';
      throw err instanceof RecorderError ? err : new RecorderError(`Could not start audio capture: ${(err as Error).message}`, 'failed');
    }
  }

  /** Stop and return the recording. Resolves to an empty result when nothing was captured. */
  async stop(): Promise<RecordingResult> {
    if (this.state !== 'recording') throw new RecorderError('Recorder is not recording', 'failed');
    this.state = 'stopping';
    await this.flushWorklet();
    const sampleRate = this.audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
    await this.teardown();
    this.state = 'idle';
    const raw = mergeChunks(this.chunks);
    this.chunks = [];
    const samples = resample(raw, sampleRate, TARGET_SAMPLE_RATE);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    const durationMs = Math.round((samples.length / TARGET_SAMPLE_RATE) * 1000);
    return {
      wav: new Blob([encodeWav(samples, TARGET_SAMPLE_RATE)], { type: 'audio/wav' }),
      durationMs,
      sampleRate: TARGET_SAMPLE_RATE,
      sampleCount: samples.length,
      peak,
    };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.chunks = [];
    await this.teardown();
    this.state = 'idle';
  }

  /** Instantaneous RMS level in [0, 1] for meters and waveforms. */
  getLevel(): number {
    if (!this.analyser) return 0;
    if (!this.levelBuffer || this.levelBuffer.length !== this.analyser.fftSize) this.levelBuffer = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (let i = 0; i < this.levelBuffer.length; i++) sum += this.levelBuffer[i] * this.levelBuffer[i];
    return Math.min(1, Math.sqrt(sum / this.levelBuffer.length) * 4);
  }

  private async buildGraph(): Promise<void> {
    const stream = this.stream!;
    // Ask for 16 kHz so no resampling is needed; some browsers refuse a rate that differs from the device.
    this.audioContext = await this.createContext(stream);
    const ctx = this.audioContext;
    if (ctx.state === 'suspended') await ctx.resume();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source!.connect(this.analyser);

    try {
      if (!ctx.audioWorklet) throw new Error('AudioWorklet unsupported');
      await ctx.audioWorklet.addModule(this.workletUrl);
      const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
        if (event.data === 'flushed') {
          this.flushed?.();
          this.flushed = null;
        } else if (event.data instanceof Float32Array) {
          this.chunks.push(event.data);
        }
      };
      this.captureNode = node;
    } catch {
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        if (this.state === 'recording' || this.state === 'starting')
          this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      this.captureNode = processor;
    }
    this.source!.connect(this.captureNode);
    this.captureNode.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  private async createContext(stream: MediaStream): Promise<AudioContext> {
    for (const options of [{ sampleRate: TARGET_SAMPLE_RATE }, undefined]) {
      let ctx: AudioContext | null = null;
      try {
        ctx = options ? new AudioContext(options) : new AudioContext();
        this.source = ctx.createMediaStreamSource(stream);
        return ctx;
      } catch (err) {
        if (ctx) await ctx.close().catch(() => undefined);
        this.source = null;
        if (!options) throw err;
      }
    }
    throw new RecorderError('Could not create an audio context', 'failed');
  }

  private flushWorklet(): Promise<void> {
    const node = this.captureNode;
    if (!(node instanceof AudioWorkletNode)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.flushed = null;
        resolve();
      }, 300);
      this.flushed = () => {
        clearTimeout(timer);
        resolve();
      };
      node.port.postMessage('flush');
    });
  }

  private async teardown(): Promise<void> {
    try {
      this.captureNode?.disconnect();
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.captureNode instanceof AudioWorkletNode) this.captureNode.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    const ctx = this.audioContext;
    this.captureNode = null;
    this.source = null;
    this.analyser = null;
    this.sink = null;
    this.stream = null;
    this.audioContext = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined);
  }
}

function toRecorderError(err: unknown): RecorderError {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecorderError('Microphone access was blocked. Allow the microphone for this site and try again.', 'denied');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecorderError('No microphone was found. Plug one in or pick another device in Settings.', 'no-device');
  }
  if (name === 'NotReadableError') {
    return new RecorderError('The microphone is in use by another application.', 'failed');
  }
  return new RecorderError(`Could not access the microphone: ${(err as Error)?.message ?? String(err)}`, 'failed');
}
