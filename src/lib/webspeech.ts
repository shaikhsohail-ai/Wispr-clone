/* Thin wrapper over the browser's SpeechRecognition (Chrome, Edge, Safari). Chrome streams audio to Google. */

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isWebSpeechSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export interface WebSpeechOptions {
  language: string;
  onInterim: (text: string) => void;
  onError?: (message: string) => void;
  /** Injected for tests. */
  ctor?: SpeechRecognitionCtor;
}

const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access was blocked for speech recognition.',
  'service-not-allowed': 'Speech recognition is not allowed in this browser.',
  network: 'Browser speech recognition needs an internet connection (Chrome sends audio to Google). Try the server engines instead.',
  'audio-capture': 'No microphone was found for speech recognition.',
  'language-not-supported': 'That language is not supported by browser speech recognition.',
};

/** One push-to-talk session. Keeps going across Chrome's automatic restarts until `stop()` is called. */
export class WebSpeechSession {
  private recognition: SpeechRecognitionLike | null = null;
  private committed: string[] = [];
  private currentFinals: string[] = [];
  private interim = '';
  private active = false;
  private stopping = false;
  private endResolvers: Array<() => void> = [];

  constructor(private readonly options: WebSpeechOptions) {}

  start(): void {
    const Ctor = this.options.ctor ?? getSpeechRecognitionCtor();
    if (!Ctor) throw new Error('Browser speech recognition is not supported here. Use Chrome, Edge or Safari, or pick a server engine.');
    this.active = true;
    this.stopping = false;
    this.committed = [];
    this.spawn(Ctor);
  }

  /** Current best text: everything final so far plus the interim hypothesis. */
  get text(): string {
    return [...this.committed, ...this.currentFinals, this.interim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  /** Stop listening and resolve with the final transcript. */
  stop(): Promise<string> {
    if (!this.active) return Promise.resolve(this.text);
    this.active = false;
    this.stopping = true;
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => finish(), 2500);
      const finish = () => {
        clearTimeout(timer);
        resolve(this.text);
      };
      this.endResolvers.push(finish);
      try {
        this.recognition?.stop();
      } catch {
        finish();
      }
    });
  }

  abort(): void {
    this.active = false;
    this.stopping = true;
    try {
      this.recognition?.abort();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
    this.committed = [];
    this.currentFinals = [];
    this.interim = '';
    this.resolveEnd();
  }

  private spawn(Ctor: SpeechRecognitionCtor): void {
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = this.options.language === 'auto' ? navigator.language || 'en-US' : this.options.language;
    this.currentFinals = [];
    this.interim = '';

    rec.onresult = (event) => {
      const finals: string[] = [];
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) finals.push(transcript.trim());
        else interim += transcript;
      }
      this.currentFinals = finals.filter(Boolean);
      this.interim = interim.trim();
      this.options.onInterim(this.text);
    };
    rec.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      const message = ERROR_MESSAGES[event.error] ?? `Speech recognition error: ${event.error}`;
      this.active = false;
      this.options.onError?.(message);
    };
    rec.onend = () => {
      this.committed.push(...this.currentFinals);
      if (this.interim && !this.active) this.committed.push(this.interim);
      this.currentFinals = [];
      this.interim = '';
      if (this.active && !this.stopping) {
        // Chrome ends sessions on its own after a while; restart transparently while the key is still held.
        try {
          this.spawn(Ctor);
          return;
        } catch {
          this.active = false;
        }
      }
      this.recognition = null;
      this.resolveEnd();
    };
    this.recognition = rec;
    rec.start();
  }

  private resolveEnd() {
    const resolvers = this.endResolvers;
    this.endResolvers = [];
    resolvers.forEach((r) => r());
  }
}
