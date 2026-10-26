import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastAction } from '../components/Toasts';
import { ApiRequestError, api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { PcmRecorder, type RecordingResult } from '../lib/recorder';
import type { Settings } from '../lib/settings';
import { WebSpeechSession, isWebSpeechSupported } from '../lib/webspeech';
import { cleanTranscript, countWords } from '../shared/text';
import type { Dictation, EngineId, HealthInfo, PolishMode } from '../shared/types';

export type Phase = 'idle' | 'listening' | 'transcribing' | 'polishing' | 'saving' | 'done' | 'error';

/** Phases in which a run is in flight: nothing new can start and the editor must not be replaced. */
export const BUSY_PHASES: readonly Phase[] = ['transcribing', 'polishing', 'saving'];

export function isBusyPhase(phase: Phase): boolean {
  return BUSY_PHASES.includes(phase);
}

/** A dictation shown in the editor; `unsaved` is set when the server could not store it. */
export type EditorDictation = Dictation & { unsaved?: boolean };

export type Notify = (message: string, kind?: 'info' | 'success' | 'error', action?: ToastAction) => void;

export interface UseDictationOptions {
  settings: Settings;
  health: HealthInfo | null;
  notify: Notify;
  onSaved?: (dictation: Dictation) => void;
  onChanged?: () => void;
}

class DictationError extends Error {}

/** A recording whose transcription request failed; kept so the user can resend it instead of re-dictating. */
interface PendingRecording {
  recording: RecordingResult;
  engine: EngineId;
  language: string;
  durationMs: number;
}

const ENGINE_PRIORITY: EngineId[] = ['openai', 'webspeech', 'local', 'mock'];

export function isEngineAvailable(id: EngineId, health: HealthInfo | null): boolean {
  if (id === 'webspeech') return isWebSpeechSupported();
  return Boolean(health?.engines?.[id]);
}

/** The engine a dictation will use: the user's pick, or the best available one on 'auto'. */
export function resolveEngine(settings: Settings, health: HealthInfo | null): EngineId | null {
  if (settings.engine !== 'auto') return settings.engine;
  return ENGINE_PRIORITY.find((id) => isEngineAvailable(id, health)) ?? null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useDictation({ settings, health, notify, onSaved, onChanged }: UseDictationOptions) {
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [interimText, setInterimText] = useState('');
  const [result, setResult] = useState<EditorDictation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [activeEngine, setActiveEngine] = useState<EngineId | null>(null);

  const phaseRef = useRef<Phase>('idle');
  const settingsRef = useRef(settings);
  const healthRef = useRef(health);
  const notifyRef = useRef(notify);
  const onSavedRef = useRef(onSaved);
  const onChangedRef = useRef(onChanged);
  const recorderRef = useRef<PcmRecorder | null>(null);
  const speechRef = useRef<WebSpeechSession | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const startedAtRef = useRef(0);
  const sessionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<EngineId | null>(null);
  const retryRef = useRef<PendingRecording | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    settingsRef.current = settings;
    healthRef.current = health;
    notifyRef.current = notify;
    onSavedRef.current = onSaved;
    onChangedRef.current = onChanged;
  }, [settings, health, notify, onSaved, onChanged]);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const fail = useCallback(
    (message: string) => {
      setError(message);
      setPhase('error');
    },
    [setPhase],
  );

  const clearRetry = useCallback(() => {
    retryRef.current = null;
    setCanRetry(false);
  }, []);

  /** Fail a run; the captured audio is kept for a retry only when the transcription request itself failed. */
  const failRun = useCallback(
    (err: unknown) => {
      const retryable = err instanceof ApiRequestError && retryRef.current !== null;
      if (!retryable) retryRef.current = null;
      setCanRetry(retryable);
      fail(errorMessage(err));
    },
    [fail],
  );

  const releaseAudio = useCallback(async () => {
    speechRef.current?.abort();
    speechRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    await recorder?.cancel().catch(() => undefined);
  }, []);

  /**
   * Copy and tell the user. Firefox and Safari only allow clipboard writes right after a key press or click, so when
   * the deferred copy at the end of a run is refused the toast carries a Copy button whose click supplies the gesture.
   */
  const copyWithFallback = useCallback(async (text: string, prefix: string) => {
    if (await copyText(text)) {
      notifyRef.current('Copied to clipboard', 'success');
      return;
    }
    notifyRef.current(`${prefix} Press Copy to put it on the clipboard.`, 'info', {
      label: 'Copy',
      onClick: () => {
        void copyText(text).then((ok) =>
          notifyRef.current(ok ? 'Copied to clipboard' : 'Clipboard is unavailable here', ok ? 'success' : 'error'),
        );
      },
    });
  }, []);

  const cancel = useCallback(async () => {
    sessionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    clearRetry();
    await releaseAudio();
    setInterimText('');
    setPhase(result ? 'done' : 'idle');
  }, [clearRetry, releaseAudio, result, setPhase]);

  const start = useCallback(async () => {
    const current = phaseRef.current;
    if (current === 'listening' || isBusyPhase(current)) return;
    const s = settingsRef.current;
    const engine = resolveEngine(s, healthRef.current);
    if (!engine) {
      fail(
        'No transcription engine is available. Use Chrome or Edge for browser speech, or configure OpenAI or local Whisper on the server.',
      );
      return;
    }
    if (!isEngineAvailable(engine, healthRef.current)) {
      const why =
        engine === 'webspeech'
          ? 'This browser has no speech recognition. Use Chrome, Edge or Safari, or choose a server engine in Settings.'
          : engine === 'openai'
            ? 'The OpenAI engine is not configured. Set OPENAI_API_KEY on the server or choose another engine in Settings.'
            : engine === 'local'
              ? 'Local Whisper is not installed on the server (optional dependency @huggingface/transformers).'
              : 'That engine is not available on this server.';
      fail(why);
      return;
    }

    const session = ++sessionRef.current;
    engineRef.current = engine;
    clearRetry();
    setActiveEngine(engine);
    setError(null);
    setInterimText('');
    setElapsedMs(0);
    startedAtRef.current = performance.now();
    setPhase('listening');

    const recorder = new PcmRecorder();
    recorderRef.current = recorder;

    if (engine === 'webspeech') {
      try {
        const speech = new WebSpeechSession({
          language: s.language,
          onInterim: (text) => {
            if (sessionRef.current === session) setInterimText(text);
          },
          onError: (message) => {
            if (sessionRef.current !== session) return;
            // End the session so a stop() that is already waiting bails out and this message survives.
            sessionRef.current += 1;
            void releaseAudio();
            fail(message);
          },
        });
        speechRef.current = speech;
        speech.start();
      } catch (err) {
        recorderRef.current = null;
        fail(errorMessage(err));
        return;
      }
      // The recorder only feeds the level meter here; speech recognition owns the audio.
      startPromiseRef.current = recorder.start(s.micDeviceId || undefined).then(
        async () => {
          if (sessionRef.current !== session) await recorder.cancel();
        },
        () => {
          if (recorderRef.current === recorder) recorderRef.current = null;
        },
      );
      return;
    }

    startPromiseRef.current = recorder.start(s.micDeviceId || undefined).then(
      async () => {
        if (sessionRef.current !== session) await recorder.cancel();
      },
      (err: unknown) => {
        if (sessionRef.current !== session) return;
        // End the session so a stop() that is already waiting bails out and this specific message survives.
        sessionRef.current += 1;
        recorderRef.current = null;
        fail(errorMessage(err));
      },
    );
  }, [clearRetry, fail, releaseAudio, setPhase]);

  /** Send a recording to the server; Escape aborts the request through abortRef. */
  const transcribe = useCallback(async (recording: RecordingResult, engine: EngineId, language: string): Promise<string> => {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await api.transcribe(recording.wav, engine, language, controller.signal);
      return response.text;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  /** Clean, optionally polish, save and copy a raw transcript. Shared by a normal run and a retry. */
  const finish = useCallback(
    async (raw: string, engine: EngineId, durationMs: number, session: number) => {
      const s = settingsRef.current;
      if (!raw.trim()) throw new DictationError("Didn't catch any words. Try again a little closer to the microphone.");

      const spoken = s.spokenPunctuation === 'auto' ? engine === 'webspeech' : s.spokenPunctuation === 'on';
      let text = cleanTranscript(raw, {
        removeFillers: s.removeFillers,
        spokenPunctuation: spoken,
        capitalize: s.capitalize,
        dictionary: s.dictionary,
      });
      if (!text) throw new DictationError('Nothing but filler words or punctuation was heard, so there is nothing to keep.');

      let polished = false;
      if (s.autoPolish && healthRef.current?.polish) {
        setPhase('polishing');
        try {
          const p = await api.polish({ text, mode: s.polishMode, dictionary: s.dictionary });
          if (p.text.trim()) {
            text = p.text.trim();
            polished = true;
          }
        } catch (err) {
          notifyRef.current(`AI polish skipped: ${errorMessage(err)}`, 'error');
        }
        if (sessionRef.current !== session) return;
      }

      setPhase('saving');
      let saved: EditorDictation;
      try {
        saved = await api.createDictation({ text, rawText: raw, engine, language: s.language, durationMs, polished });
      } catch (err) {
        const now = new Date().toISOString();
        saved = {
          id: `unsaved-${Date.now()}`,
          createdAt: now,
          updatedAt: now,
          text,
          rawText: raw,
          engine,
          language: s.language,
          durationMs,
          wordCount: countWords(text),
          polished,
          unsaved: true,
        };
        notifyRef.current(`Transcribed, but could not save to history: ${errorMessage(err)}`, 'error');
      }
      if (sessionRef.current !== session) return;
      clearRetry();
      setResult(saved);
      setInterimText('');
      setPhase('done');
      if (!saved.unsaved) onSavedRef.current?.(saved);
      if (s.autoCopy) await copyWithFallback(text, 'Saved.');
    },
    [clearRetry, copyWithFallback, setPhase],
  );

  const stop = useCallback(async () => {
    if (phaseRef.current !== 'listening') return;
    const session = sessionRef.current;
    const s = settingsRef.current;
    const engine = engineRef.current;
    if (!engine) return;
    // Let go before the microphone finished opening (permission prompt, slow device): nothing has been captured yet.
    const releasedWhileStarting = recorderRef.current?.state === 'starting';
    setPhase('transcribing');
    setElapsedMs(0);
    await startPromiseRef.current?.catch(() => undefined);
    if (sessionRef.current !== session) return;

    const wallMs = Math.round(performance.now() - startedAtRef.current);
    let raw: string;
    let durationMs = wallMs;
    try {
      if (engine === 'webspeech') {
        const speech = speechRef.current;
        speechRef.current = null;
        raw = speech ? await speech.stop() : '';
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (recorder?.state === 'recording') await recorder.stop().catch(() => undefined);
        else await recorder?.cancel();
      } else {
        const recorder = recorderRef.current;
        recorderRef.current = null;
        if (!recorder || recorder.state !== 'recording')
          throw new DictationError('The microphone never started. Check permissions and try again.');
        if (releasedWhileStarting) {
          await recorder.cancel();
          throw new DictationError(
            'The microphone was still starting (or waiting for permission) when you let go. Hold again, speak, then let go.',
          );
        }
        const recording = await recorder.stop();
        if (sessionRef.current !== session) return;
        durationMs = recording.durationMs;
        if (recording.durationMs < 300) throw new DictationError('That was too short. Keep holding while you speak, then let go.');
        if (recording.peak < 0.003)
          throw new DictationError('Nothing was picked up. Check the microphone input level or choose another device in Settings.');
        retryRef.current = { recording, engine, language: s.language, durationMs };
        raw = await transcribe(recording, engine, s.language);
      }
      if (sessionRef.current !== session) return;
      await finish(raw, engine, durationMs, session);
    } catch (err) {
      if (sessionRef.current !== session) return;
      await releaseAudio();
      failRun(err);
    }
  }, [failRun, finish, releaseAudio, setPhase, transcribe]);

  /** Resend the audio of a run whose transcription request failed. */
  const retry = useCallback(async () => {
    const pending = retryRef.current;
    if (phaseRef.current !== 'error' || !pending) return;
    const session = ++sessionRef.current;
    engineRef.current = pending.engine;
    setActiveEngine(pending.engine);
    setError(null);
    setCanRetry(false);
    setElapsedMs(0);
    setPhase('transcribing');
    try {
      const raw = await transcribe(pending.recording, pending.engine, pending.language);
      if (sessionRef.current !== session) return;
      await finish(raw, pending.engine, pending.durationMs, session);
    } catch (err) {
      if (sessionRef.current !== session) return;
      failRun(err);
    }
  }, [failRun, finish, setPhase, transcribe]);

  const toggle = useCallback(() => {
    if (phaseRef.current === 'listening') void stop();
    else void start();
  }, [start, stop]);

  /** Polish the text the user sees (their draft, when given) and store the result. */
  const polishCurrent = useCallback(
    async (mode: PolishMode, text?: string) => {
      const current = result;
      if (!current || phaseRef.current !== 'done') return;
      const source = text?.trim() || current.text;
      setPhase('polishing');
      try {
        const p = await api.polish({ text: source, mode, dictionary: settingsRef.current.dictionary });
        const polishedText = p.text.trim() || source;
        let updated: EditorDictation = {
          ...current,
          text: polishedText,
          wordCount: countWords(polishedText),
          polished: true,
          updatedAt: new Date().toISOString(),
        };
        if (!current.unsaved) {
          updated = await api.updateDictation(current.id, { text: polishedText, polished: true });
          onChangedRef.current?.();
        }
        setResult(updated);
        notifyRef.current(`Polished (${mode})`, 'success');
        if (settingsRef.current.autoCopy) void copyWithFallback(polishedText, 'Polished.');
      } catch (err) {
        notifyRef.current(`Polish failed: ${errorMessage(err)}`, 'error');
      } finally {
        setPhase('done');
      }
    },
    [copyWithFallback, result, setPhase],
  );

  const saveEdit = useCallback(
    async (text: string) => {
      const current = result;
      if (!current) return;
      const trimmed = text.trim();
      if (!trimmed || trimmed === current.text) return;
      try {
        if (current.unsaved) {
          setResult({ ...current, text: trimmed, wordCount: countWords(trimmed) });
          notifyRef.current('Kept here. Press "Retry save" to store it in history.', 'info');
          return;
        }
        const updated = await api.updateDictation(current.id, { text: trimmed });
        setResult(updated);
        onChangedRef.current?.();
        notifyRef.current('Saved', 'success');
      } catch (err) {
        notifyRef.current(`Could not save: ${errorMessage(err)}`, 'error');
      }
    },
    [result],
  );

  /** Store a dictation the server could not save at the time. */
  const retrySave = useCallback(async () => {
    const current = result;
    if (!current?.unsaved || phaseRef.current !== 'done' || savingRef.current) return;
    savingRef.current = true;
    setPhase('saving');
    try {
      const saved = await api.createDictation({
        text: current.text,
        rawText: current.rawText,
        engine: current.engine,
        language: current.language,
        durationMs: current.durationMs,
        polished: current.polished,
      });
      setResult(saved);
      onSavedRef.current?.(saved);
      notifyRef.current('Saved to history', 'success');
    } catch (err) {
      notifyRef.current(`Could not save: ${errorMessage(err)}`, 'error');
    } finally {
      savingRef.current = false;
      setPhase('done');
    }
  }, [result, setPhase]);

  const deleteCurrent = useCallback(async () => {
    const current = result;
    if (!current) return;
    try {
      if (!current.unsaved) await api.deleteDictation(current.id);
    } catch (err) {
      // Already gone (removed from the list, or by another tab): nothing left to delete.
      if (!(err instanceof ApiRequestError && err.status === 404)) {
        notifyRef.current(`Could not delete: ${errorMessage(err)}`, 'error');
        return;
      }
    }
    setResult(null);
    setPhase('idle');
    onChangedRef.current?.();
  }, [result, setPhase]);

  /** The open dictation (or any, when no id is given) was deleted from the history list: clear the editor. */
  const discard = useCallback(
    (id?: string) => {
      if (!result || result.unsaved || (id !== undefined && result.id !== id)) return;
      setResult(null);
      if (phaseRef.current === 'done') setPhase('idle');
    },
    [result, setPhase],
  );

  const select = useCallback(
    (dictation: Dictation | null) => {
      if (phaseRef.current === 'listening' || isBusyPhase(phaseRef.current)) return;
      clearRetry();
      setResult(dictation);
      setError(null);
      setPhase(dictation ? 'done' : 'idle');
    },
    [clearRetry, setPhase],
  );

  const dismissError = useCallback(() => {
    clearRetry();
    setError(null);
    setPhase(result ? 'done' : 'idle');
  }, [clearRetry, result, setPhase]);

  // The clock runs while listening and, from zero again, while waiting for the transcription.
  useEffect(() => {
    if (phase !== 'listening' && phase !== 'transcribing') return;
    const origin = phase === 'listening' ? startedAtRef.current : performance.now();
    const timer = window.setInterval(() => setElapsedMs(Math.round(performance.now() - origin)), 100);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      void releaseAudio();
    };
  }, [releaseAudio]);

  const getLevel = useCallback(() => recorderRef.current?.getLevel() ?? 0, []);

  return {
    phase,
    interimText,
    result,
    error,
    canRetry,
    elapsedMs,
    activeEngine,
    start,
    stop,
    toggle,
    cancel,
    retry,
    polishCurrent,
    saveEdit,
    retrySave,
    deleteCurrent,
    discard,
    select,
    dismissError,
    getLevel,
  };
}
