import type { DictionaryEntry, EngineId, PolishMode } from '../shared/types';

export type HotkeyId = 'space' | 'ctrl-space' | 'alt-space' | 'backquote' | 'f8';
export type TalkMode = 'hold' | 'toggle';
export type SpokenPunctuationSetting = 'auto' | 'on' | 'off';

export interface Settings {
  /** 'auto' picks the best engine the server reports. */
  engine: EngineId | 'auto';
  language: string;
  hotkey: HotkeyId;
  talkMode: TalkMode;
  autoCopy: boolean;
  removeFillers: boolean;
  /** 'auto' turns spoken commands on only for browser speech, which does not punctuate by itself. */
  spokenPunctuation: SpokenPunctuationSetting;
  capitalize: boolean;
  dictionary: DictionaryEntry[];
  polishMode: PolishMode;
  autoPolish: boolean;
  micDeviceId: string;
}

export const DEFAULT_SETTINGS: Settings = {
  engine: 'auto',
  language: 'auto',
  hotkey: 'space',
  talkMode: 'hold',
  autoCopy: true,
  removeFillers: true,
  spokenPunctuation: 'auto',
  capitalize: true,
  dictionary: [],
  polishMode: 'clean',
  autoPolish: false,
  micDeviceId: '',
};

export const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-IN', label: 'English (India)' },
  { value: 'es-ES', label: 'Spanish' },
  { value: 'fr-FR', label: 'French' },
  { value: 'de-DE', label: 'German' },
  { value: 'it-IT', label: 'Italian' },
  { value: 'pt-BR', label: 'Portuguese (Brazil)' },
  { value: 'hi-IN', label: 'Hindi' },
  { value: 'ar-SA', label: 'Arabic' },
  { value: 'ja-JP', label: 'Japanese' },
  { value: 'zh-CN', label: 'Chinese (Mandarin)' },
  { value: 'ur-PK', label: 'Urdu' },
];

const STORAGE_KEY = 'wispr-clone.settings.v1';

export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable (private mode, quota) — settings stay in memory */
  }
}

/** Merge persisted values over the defaults, dropping anything with the wrong shape. */
export function sanitizeSettings(input: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!input || typeof input !== 'object') return { ...d };
  const s = input as Record<string, unknown>;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  return {
    engine: pick(s.engine, ['auto', 'webspeech', 'openai', 'local', 'mock'] as const, d.engine),
    language: typeof s.language === 'string' && /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/.test(s.language) ? s.language : d.language,
    hotkey: pick(s.hotkey, ['space', 'ctrl-space', 'alt-space', 'backquote', 'f8'] as const, d.hotkey),
    talkMode: pick(s.talkMode, ['hold', 'toggle'] as const, d.talkMode),
    autoCopy: bool(s.autoCopy, d.autoCopy),
    removeFillers: bool(s.removeFillers, d.removeFillers),
    spokenPunctuation: pick(s.spokenPunctuation, ['auto', 'on', 'off'] as const, d.spokenPunctuation),
    capitalize: bool(s.capitalize, d.capitalize),
    dictionary: Array.isArray(s.dictionary)
      ? s.dictionary
          .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === 'object')
          .map((e) => ({ from: String(e.from ?? '').trim(), to: String(e.to ?? '').trim() }))
          .filter((e) => e.from)
          .slice(0, 500)
      : [],
    polishMode: pick(s.polishMode, ['clean', 'formal', 'casual', 'concise'] as const, d.polishMode),
    autoPolish: bool(s.autoPolish, d.autoPolish),
    micDeviceId: typeof s.micDeviceId === 'string' ? s.micDeviceId : '',
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
