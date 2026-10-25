import { useEffect, useState } from 'react';
import { isEngineAvailable } from '../hooks/useDictation';
import { HOTKEY_OPTIONS } from '../lib/hotkey';
import { DEFAULT_SETTINGS, LANGUAGE_OPTIONS, type Settings } from '../lib/settings';
import { ENGINE_LABELS, POLISH_MODES, type EngineId, type HealthInfo, type PolishMode } from '../shared/types';

interface Props {
  settings: Settings;
  health: HealthInfo | null;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
}

const ENGINE_ORDER: EngineId[] = ['webspeech', 'openai', 'local', 'mock'];

const ENGINE_HINTS: Record<EngineId, string> = {
  webspeech: 'Free, live words as you speak. Chrome, Edge and Safari only; Chrome sends audio to Google.',
  openai: 'Best accuracy. Needs OPENAI_API_KEY on the server; audio goes to OpenAI.',
  local: 'Private and offline. Runs Whisper on the server CPU; the first use downloads the model.',
  mock: 'Returns fixed text, for testing the app without a microphone backend.',
};

export function SettingsPanel({ settings, health, onChange, onReset }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!cancelled) setDevices(list.filter((d) => d.kind === 'audioinput'));
        })
        .catch(() => undefined);
    void refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  const engines = ENGINE_ORDER.filter((id) => id !== 'mock' || health?.engines.mock);

  return (
    <div className="settings" data-testid="settings">
      <fieldset className="field-group">
        <legend>Transcription</legend>
        <label className="field">
          <span>Engine</span>
          <select
            className="select"
            value={settings.engine}
            data-testid="engine-select"
            onChange={(e) => onChange({ engine: e.target.value as Settings['engine'] })}
          >
            <option value="auto">Automatic (best available)</option>
            {engines.map((id) => (
              <option key={id} value={id}>
                {ENGINE_LABELS[id]}
                {isEngineAvailable(id, health) ? '' : ' — not available'}
              </option>
            ))}
          </select>
          <small className="hint">
            {settings.engine === 'auto' ? 'Prefers OpenAI, then browser speech, then local Whisper.' : ENGINE_HINTS[settings.engine]}
          </small>
        </label>
        <label className="field">
          <span>Language</span>
          <select className="select" value={settings.language} onChange={(e) => onChange({ language: e.target.value })}>
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Microphone</span>
          <select className="select" value={settings.micDeviceId} onChange={(e) => onChange({ micDeviceId: e.target.value })}>
            <option value="">System default</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
          <small className="hint">Device names appear after the first recording grants microphone access.</small>
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>Push to talk</legend>
        <label className="field">
          <span>Hotkey</span>
          <select
            className="select"
            value={settings.hotkey}
            data-testid="hotkey-select"
            onChange={(e) => onChange({ hotkey: e.target.value as Settings['hotkey'] })}
          >
            {HOTKEY_OPTIONS.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
          <small className="hint">Ignored while you are typing in a text field.</small>
        </label>
        <div className="field">
          <span>Mode</span>
          <div className="radio-row" role="radiogroup" aria-label="Talk mode">
            <label className="radio">
              <input
                type="radio"
                name="talkMode"
                value="hold"
                checked={settings.talkMode === 'hold'}
                onChange={() => onChange({ talkMode: 'hold' })}
              />
              Hold to talk
            </label>
            <label className="radio">
              <input
                type="radio"
                name="talkMode"
                value="toggle"
                checked={settings.talkMode === 'toggle'}
                onChange={() => onChange({ talkMode: 'toggle' })}
              />
              Press to start / stop
            </label>
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.autoCopy}
            data-testid="auto-copy"
            onChange={(e) => onChange({ autoCopy: e.target.checked })}
          />
          <span>Copy each dictation to the clipboard</span>
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>Clean-up</legend>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.removeFillers}
            data-testid="remove-fillers"
            onChange={(e) => onChange({ removeFillers: e.target.checked })}
          />
          <span>Remove filler words (um, uh, hmm…)</span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.capitalize} onChange={(e) => onChange({ capitalize: e.target.checked })} />
          <span>Capitalise sentences</span>
        </label>
        <label className="field">
          <span>Spoken punctuation (“comma”, “new line”, “scratch that”)</span>
          <select
            className="select"
            value={settings.spokenPunctuation}
            data-testid="spoken-punctuation"
            onChange={(e) => onChange({ spokenPunctuation: e.target.value as Settings['spokenPunctuation'] })}
          >
            <option value="auto">Automatic (only for browser speech, which does not punctuate)</option>
            <option value="on">Always on</option>
            <option value="off">Off</option>
          </select>
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>AI polish</legend>
        {!health?.polish && <p className="hint">Set ANTHROPIC_API_KEY on the server to enable rewriting with Claude.</p>}
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.autoPolish}
            disabled={!health?.polish}
            onChange={(e) => onChange({ autoPolish: e.target.checked })}
          />
          <span>Polish every dictation automatically</span>
        </label>
        <label className="field">
          <span>Default style</span>
          <select
            className="select"
            value={settings.polishMode}
            disabled={!health?.polish}
            onChange={(e) => onChange({ polishMode: e.target.value as PolishMode })}
          >
            {(Object.keys(POLISH_MODES) as PolishMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {POLISH_MODES[mode].label} — {POLISH_MODES[mode].hint}
              </option>
            ))}
          </select>
        </label>
      </fieldset>

      <fieldset className="field-group">
        <legend>Personal dictionary</legend>
        <p className="hint">Fix words the engines keep getting wrong: names, products, jargon. Matches are whole words, any case.</p>
        <div className="dictionary" data-testid="dictionary">
          {settings.dictionary.map((entry, index) => (
            <div key={index} className="dictionary-row">
              <input
                className="input"
                placeholder="heard as"
                value={entry.from}
                aria-label="Heard as"
                onChange={(e) => {
                  const next = settings.dictionary.map((d, i) => (i === index ? { ...d, from: e.target.value } : d));
                  onChange({ dictionary: next });
                }}
              />
              <span aria-hidden="true">→</span>
              <input
                className="input"
                placeholder="replace with"
                value={entry.to}
                aria-label="Replace with"
                onChange={(e) => {
                  const next = settings.dictionary.map((d, i) => (i === index ? { ...d, to: e.target.value } : d));
                  onChange({ dictionary: next });
                }}
              />
              <button
                type="button"
                className="icon-btn danger"
                aria-label="Remove entry"
                onClick={() => onChange({ dictionary: settings.dictionary.filter((_, i) => i !== index) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small"
            data-testid="dictionary-add"
            onClick={() => onChange({ dictionary: [...settings.dictionary, { from: '', to: '' }] })}
          >
            + Add word
          </button>
        </div>
      </fieldset>

      <div className="actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onReset}
          disabled={JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS)}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
