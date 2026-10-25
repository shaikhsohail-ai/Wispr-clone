import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { PcmRecorder } from '../lib/recorder';
import type { Settings } from '../lib/settings';
import { WebSpeechSession, isWebSpeechSupported } from '../lib/webspeech';
import { cleanTranscript } from '../shared/text';
import type { Dictation, EngineId, HealthInfo, PolishMode } from '../shared/types';

export type Phase = 'idle' | 'listening' | 'transcribing' | 'polishing' | 'saving' | 'done' | 'error';

/** A dictation shown in the editor; `unsaved` is set when the server could not store it. */
export type EditorDictation = Dictation & { unsaved?: boolean };

export type Notify = (message: string, kind?: 'info' | 'success' | 'error') => void;

export interface UseDictationOptions {
  settings: Settings;
  health: HealthInfo | null;
  notify: Notify;
  onSaved?: (dictation: Dictation) => void;
  onChanged?: () => void;
}

class DictationError extends Error {}

const ENGINE_PRIORITY: EngineId[] = ['openai', 'webspeech', 'local', 'mock'];

export function isEngineAvailable(id: EngineId, health: HealthInfo | null): boolean {
  if (id === 'webspeech') return isWebSpeechSupported();
  return Boolean(health?.engines[id]);
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

  const releaseAudio = useCallback(async () => {
    speechRef.current?.abort();
    speechRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    await recorder?.cancel().catch(() => undefined);
  }, []);

  const cancel = useCallback(async () => {
    sessionRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    await releaseAudio();
    setInterimText('');
    setPhase(result ? 'done' : 'idle');
  }, [releaseAudio, result, setPhase]);

  const start = useCallback(async () => {
    const current = phaseRef.current;
    if (current === 'listening' || current === 'transcribing' || current === 'polishing' || current === 'saving') return;
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
      startPromiseRef.current = recorder.start(s.micDeviceId || undefined).catch(() => {
        if (recorderRef.current === recorder) recorderRef.current = null;
      });
      return;
    }

    startPromiseRef.current = recorder.start(s.micDeviceId || undefined).then(
      async () => {
        if (sessionRef.current !== session) await recorder.cancel();
      },
      (err: unknown) => {
        if (sessionRef.current !== session) return;
        recorderRef.current = null;
        fail(errorMessage(err));
      },
    );
  }, [fail, releaseAudio, setPhase]);

  const stop = useCallback(async () => {
    if (phaseRef.current !== 'listening') return;
    const session = sessionRef.current;
    const s = settingsRef.current;
    const engine = engineRef.current;
    if (!engine) return;
    setPhase('transcribing');
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
        const recording = await recorder.stop();
        durationMs = recording.durationMs;
        if (recording.durationMs < 300) throw new DictationError('That was too short. Hold the key while you speak, then release.');
        if (recording.peak < 0.003)
          throw new DictationError('Nothing was picked up. Check the microphone input level or choose another device in Settings.');
        const controller = new AbortController();
        abortRef.current = controller;
        const response = await api.transcribe(recording.wav, engine, s.language, controller.signal);
        abortRef.current = null;
        raw = response.text;
      }
      if (sessionRef.current !== session) return;
      if (!raw.trim()) throw new DictationError("Didn't catch any words. Try again a little closer to the microphone.");

      const spoken = s.spokenPunctuation === 'auto' ? engine === 'webspeech' : s.spokenPunctuation === 'on';
      let text = cleanTranscript(raw, {
        removeFillers: s.removeFillers,
        spokenPunctuation: spoken,
        capitalize: s.capitalize,
        dictionary: s.dictionary,
      });
      if (!text) throw new DictationError('Only filler words were heard, so there is nothing to keep.');

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
          wordCount: text.split(/\s+/).filter(Boolean).length,
          polished,
          unsaved: true,
        };
        notifyRef.current(`Transcribed, but could not save to history: ${errorMessage(err)}`, 'error');
      }
      if (sessionRef.current !== session) return;
      setResult(saved);
      setInterimText('');
      setPhase('done');
      if (!saved.unsaved) onSavedRef.current?.(saved);
      if (s.autoCopy) {
        const ok = await copyText(text);
        notifyRef.current(ok ? 'Copied to clipboard' : 'Saved. Clipboard is unavailable in this context.', ok ? 'success' : 'info');
      }
    } catch (err) {
      if (sessionRef.current !== session) return;
      await releaseAudio();
      fail(errorMessage(err));
    }
  }, [fail, releaseAudio, setPhase]);

  const toggle = useCallback(() => {
    if (phaseRef.current === 'listening') void stop();
    else void start();
  }, [start, stop]);

  const polishCurrent = useCallback(
    async (mode: PolishMode) => {
      const current = result;
      if (!current || phaseRef.current !== 'done') return;
      setPhase('polishing');
      try {
        const p = await api.polish({ text: current.text, mode, dictionary: settingsRef.current.dictionary });
        const text = p.text.trim() || current.text;
        let updated: EditorDictation = { ...current, text, polished: true, updatedAt: new Date().toISOString() };
        if (!current.unsaved) {
          updated = await api.updateDictation(current.id, { text, polished: true });
          onChangedRef.current?.();
        }
        setResult(updated);
        notifyRef.current(`Polished (${mode})`, 'success');
        if (settingsRef.current.autoCopy) void copyText(text);
      } catch (err) {
        notifyRef.current(`Polish failed: ${errorMessage(err)}`, 'error');
      } finally {
        setPhase('done');
      }
    },
    [result, setPhase],
  );

  const saveEdit = useCallback(
    async (text: string) => {
      const current = result;
      if (!current) return;
      const trimmed = text.trim();
      if (!trimmed || trimmed === current.text) return;
      try {
        if (current.unsaved) {
          setResult({ ...current, text: trimmed, wordCount: trimmed.split(/\s+/).length });
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

  const deleteCurrent = useCallback(async () => {
    const current = result;
    if (!current) return;
    try {
      if (!current.unsaved) await api.deleteDictation(current.id);
      setResult(null);
      setPhase('idle');
      onChangedRef.current?.();
    } catch (err) {
      notifyRef.current(`Could not delete: ${errorMessage(err)}`, 'error');
    }
  }, [result, setPhase]);

  const select = useCallback(
    (dictation: Dictation | null) => {
      if (phaseRef.current === 'listening' || phaseRef.current === 'transcribing') return;
      setResult(dictation);
      setError(null);
      setPhase(dictation ? 'done' : 'idle');
    },
    [setPhase],
  );

  const dismissError = useCallback(() => {
    setError(null);
    setPhase(result ? 'done' : 'idle');
  }, [result, setPhase]);

  useEffect(() => {
    if (phase !== 'listening') return;
    const timer = window.setInterval(() => setElapsedMs(Math.round(performance.now() - startedAtRef.current)), 100);
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
    elapsedMs,
    activeEngine,
    start,
    stop,
    toggle,
    cancel,
    polishCurrent,
    saveEdit,
    deleteCurrent,
    select,
    dismissError,
    getLevel,
  };
}
