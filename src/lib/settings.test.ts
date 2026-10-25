import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings } from './settings';

describe('settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ engine: 'bogus', hotkey: 42, language: 'not a code', dictionary: 'nope' })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and trims dictionary entries', () => {
    const result = sanitizeSettings({
      engine: 'local',
      language: 'en-GB',
      hotkey: 'f8',
      talkMode: 'toggle',
      autoCopy: false,
      dictionary: [{ from: '  acme ', to: ' ACME ' }, { from: '', to: 'x' }, null, 'junk'],
      polishMode: 'formal',
    });
    expect(result.engine).toBe('local');
    expect(result.language).toBe('en-GB');
    expect(result.hotkey).toBe('f8');
    expect(result.talkMode).toBe('toggle');
    expect(result.autoCopy).toBe(false);
    expect(result.dictionary).toEqual([{ from: 'acme', to: 'ACME' }]);
    expect(result.polishMode).toBe('formal');
  });

  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSettings({ ...DEFAULT_SETTINGS, hotkey: 'backquote' }, storage);
    expect(loadSettings(storage).hotkey).toBe('backquote');
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    store.set('wispr-clone.settings.v1', '{not json');
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });
});
