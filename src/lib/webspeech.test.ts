import { describe, expect, it } from 'vitest';
import { WebSpeechSession, type SpeechRecognitionLike } from './webspeech';

class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    queueMicrotask(() => this.onend?.());
  }
  emit(results: Array<{ text: string; final: boolean }>) {
    const list = results.map((r) => ({ isFinal: r.final, length: 1, 0: { transcript: r.text } }));
    this.onresult?.({ resultIndex: 0, results: Object.assign(list, { length: list.length }) });
  }
}

describe('WebSpeechSession', () => {
  it('reports interim text and resolves with the final transcript', async () => {
    FakeRecognition.instances = [];
    const interims: string[] = [];
    const session = new WebSpeechSession({ language: 'en-US', onInterim: (t) => interims.push(t), ctor: FakeRecognition });
    session.start();
    const rec = FakeRecognition.instances[0];
    expect(rec.started).toBe(true);
    expect(rec.lang).toBe('en-US');
    expect(rec.continuous).toBe(true);
    rec.emit([{ text: 'hello ', final: false }]);
    rec.emit([
      { text: 'hello world', final: true },
      { text: ' how are', final: false },
    ]);
    expect(interims).toEqual(['hello', 'hello world how are']);
    const text = await session.stop();
    expect(text).toBe('hello world how are');
  });

  it('keeps earlier finals when the browser restarts recognition mid-session', async () => {
    FakeRecognition.instances = [];
    const session = new WebSpeechSession({ language: 'en-US', onInterim: () => undefined, ctor: FakeRecognition });
    session.start();
    const first = FakeRecognition.instances[0];
    first.emit([{ text: 'first part', final: true }]);
    first.onend?.(); // Chrome ended on its own; the session should spawn a new recognizer
    expect(FakeRecognition.instances).toHaveLength(2);
    const second = FakeRecognition.instances[1];
    second.emit([{ text: 'second part', final: true }]);
    expect(session.text).toBe('first part second part');
    await expect(session.stop()).resolves.toBe('first part second part');
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it('surfaces fatal errors and clears on abort', () => {
    FakeRecognition.instances = [];
    const errors: string[] = [];
    const session = new WebSpeechSession({
      language: 'en-US',
      onInterim: () => undefined,
      onError: (m) => errors.push(m),
      ctor: FakeRecognition,
    });
    session.start();
    const rec = FakeRecognition.instances[0];
    rec.onerror?.({ error: 'no-speech' });
    expect(errors).toEqual([]);
    rec.onerror?.({ error: 'not-allowed' });
    expect(errors[0]).toMatch(/blocked/);
    rec.emit([{ text: 'x', final: true }]);
    session.abort();
    expect(session.text).toBe('');
  });
});
