import { afterEach, describe, expect, it, vi } from 'vitest';
import { PcmRecorder, RecorderError } from './recorder';

/* Minimal stand-ins for the Web Audio and media APIs so the recorder's life cycle can run under Node. */

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeWorkletNode extends FakeNode {
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: (message: unknown) => {
      if (message === 'flush') this.port.onmessage?.({ data: 'flushed' });
    },
  };
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static addModule: () => Promise<void> = async () => undefined;
  state = 'running';
  sampleRate = 16_000;
  destination = {};
  audioWorklet = { addModule: () => FakeAudioContext.addModule() };
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource() {
    return new FakeNode();
  }
  createAnalyser() {
    return Object.assign(new FakeNode(), { fftSize: 0, smoothingTimeConstant: 0, getFloatTimeDomainData() {} });
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: { value: 1 } });
  }
  async resume() {
    this.state = 'running';
  }
  async close() {
    this.state = 'closed';
  }
}

function install(getUserMedia: () => Promise<FakeStream>) {
  FakeAudioContext.instances = [];
  FakeAudioContext.addModule = async () => undefined;
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PcmRecorder', () => {
  it('records and returns a 16 kHz WAV', async () => {
    const stream = new FakeStream();
    install(async () => stream);
    const recorder = new PcmRecorder('/pcm-worklet.js');
    await recorder.start();
    expect(recorder.state).toBe('recording');
    // Feed one 100 ms chunk through the worklet port, as the browser would.
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.state).toBe('running');
    const node = (recorder as unknown as { captureNode: FakeWorkletNode }).captureNode;
    node.port.onmessage?.({ data: new Float32Array(1600).fill(0.5) });
    const result = await recorder.stop();
    expect(recorder.state).toBe('idle');
    expect(result.durationMs).toBe(100);
    expect(result.peak).toBeCloseTo(0.5, 2);
    expect(result.wav.type).toBe('audio/wav');
    expect(stream.tracks[0].stopped).toBe(true);
    expect(ctx.state).toBe('closed');
  });

  it('releases the microphone when cancelled while getUserMedia is still pending', async () => {
    let resolveMic!: (stream: FakeStream) => void;
    const stream = new FakeStream();
    install(() => new Promise<FakeStream>((resolve) => (resolveMic = resolve)));
    const recorder = new PcmRecorder('/pcm-worklet.js');
    const started = recorder.start();
    expect(recorder.state).toBe('starting');

    await recorder.cancel(); // e.g. Escape while the permission prompt is up
    expect(recorder.state).toBe('idle');

    resolveMic(stream);
    await expect(started).rejects.toBeInstanceOf(RecorderError);
    expect(recorder.state).toBe('idle');
    expect(stream.tracks[0].stopped).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('tears everything down when cancelled while the audio graph is being built', async () => {
    let resolveModule!: () => void;
    const stream = new FakeStream();
    install(async () => stream);
    FakeAudioContext.addModule = () => new Promise<void>((resolve) => (resolveModule = resolve));
    const recorder = new PcmRecorder('/pcm-worklet.js');
    const started = recorder.start();
    await tick();
    await tick();
    expect(FakeAudioContext.instances).toHaveLength(1);

    await recorder.cancel();
    resolveModule();
    await expect(started).rejects.toBeInstanceOf(RecorderError);
    expect(recorder.state).toBe('idle');
    expect(stream.tracks[0].stopped).toBe(true);
    expect(FakeAudioContext.instances.every((ctx) => ctx.state === 'closed')).toBe(true);
  });

  it('maps a denied permission to a clear error', async () => {
    install(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    const recorder = new PcmRecorder('/pcm-worklet.js');
    await expect(recorder.start()).rejects.toMatchObject({ code: 'denied', message: /Microphone access was blocked/ });
    expect(recorder.state).toBe('idle');
  });
});
