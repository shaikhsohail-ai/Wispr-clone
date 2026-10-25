import { useCallback, useEffect, useReducer, useState } from 'react';
import { HistoryPanel } from './components/HistoryPanel';
import { MicButton } from './components/MicButton';
import { SettingsPanel } from './components/SettingsPanel';
import { StatsBar } from './components/StatsBar';
import { TranscriptPanel } from './components/TranscriptPanel';
import { Toasts } from './components/Toasts';
import { Waveform } from './components/Waveform';
import { resolveEngine, useDictation } from './hooks/useDictation';
import { useToasts } from './hooks/useToasts';
import { api } from './lib/api';
import { copyText } from './lib/clipboard';
import { hotkeyLabel, isEditableTarget, matchesHotkey } from './lib/hotkey';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './lib/settings';
import { ENGINE_SHORT_LABELS, type HealthInfo, type PolishMode } from './shared/types';

type Tab = 'history' | 'settings';

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('history');
  const [historyVersion, bumpHistory] = useReducer((n: number) => n + 1, 0);
  const { toasts, notify, dismiss } = useToasts();

  const dictation = useDictation({ settings, health, notify, onSaved: bumpHistory, onChanged: bumpHistory });
  const { phase, start, stop, toggle, cancel } = dictation;

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try {
        const info = await api.health();
        if (cancelled) return;
        setHealth(info);
        setServerOnline(true);
        timer = window.setTimeout(poll, 30_000);
      } catch {
        if (cancelled) return;
        setServerOnline(false);
        timer = window.setTimeout(poll, 4_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (phase === 'listening' || phase === 'transcribing')) {
        event.preventDefault();
        void cancel();
        return;
      }
      if (event.repeat || isEditableTarget(event.target)) return;
      if (!matchesHotkey(event, settings.hotkey, 'press')) return;
      event.preventDefault();
      if (settings.talkMode === 'hold') {
        if (phase !== 'listening') void start();
      } else {
        toggle();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!matchesHotkey(event, settings.hotkey, 'release')) return;
      if (isEditableTarget(event.target) && phase !== 'listening') return;
      event.preventDefault();
      if (settings.talkMode === 'hold' && phase === 'listening') void stop();
    };
    const onBlur = () => {
      if (settings.talkMode === 'hold' && phase === 'listening') void stop();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [phase, settings.hotkey, settings.talkMode, start, stop, toggle, cancel]);

  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      notify(ok ? 'Copied to clipboard' : 'Clipboard is unavailable here', ok ? 'success' : 'error');
    },
    [notify],
  );

  const engine = resolveEngine(settings, health);
  const hotkey = hotkeyLabel(settings.hotkey);
  const listening = phase === 'listening';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" width="32" height="32" />
          <div>
            <h1>Wispr Clone</h1>
            <p>Hold a key. Talk. Done.</p>
          </div>
        </div>
        <div className="topbar-status" data-testid="server-status">
          <span className={`dot ${serverOnline ? 'dot-ok' : serverOnline === false ? 'dot-bad' : 'dot-busy'}`} />
          <span>{serverOnline ? 'Server connected' : serverOnline === false ? 'Server offline' : 'Connecting…'}</span>
          <span className="chip" data-testid="engine-chip">
            {engine ? ENGINE_SHORT_LABELS[engine] : 'No engine'}
          </span>
        </div>
      </header>

      <main className="layout">
        <section className="stage">
          <div className="hero">
            <MicButton
              phase={phase}
              talkMode={settings.talkMode}
              onStart={() => void start()}
              onStop={() => void stop()}
              onToggle={toggle}
            />
            <p className="hero-hint" aria-live="polite">
              {listening
                ? settings.talkMode === 'hold'
                  ? `Release ${hotkey} to finish`
                  : `Press ${hotkey} to finish`
                : settings.talkMode === 'hold'
                  ? `Hold ${hotkey} to talk`
                  : `Press ${hotkey} to start`}
            </p>
            <Waveform active={listening} getLevel={dictation.getLevel} />
          </div>

          <TranscriptPanel
            phase={phase}
            interimText={dictation.interimText}
            result={dictation.result}
            error={dictation.error}
            activeEngine={dictation.activeEngine}
            elapsedMs={dictation.elapsedMs}
            canPolish={Boolean(health?.polish)}
            polishMode={settings.polishMode}
            hotkeyLabel={hotkey}
            talkMode={settings.talkMode}
            onPolishModeChange={(mode: PolishMode) => updateSettings({ polishMode: mode })}
            onPolish={(mode) => void dictation.polishCurrent(mode)}
            onSave={(text) => void dictation.saveEdit(text)}
            onDelete={() => void dictation.deleteCurrent()}
            onCopy={(text) => void copy(text)}
            onNew={() => dictation.select(null)}
            onDismissError={dictation.dismissError}
          />
        </section>

        <aside className="sidebar">
          <StatsBar version={historyVersion} />
          <nav className="tabs" role="tablist" aria-label="Sidebar">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={tab === 'history' ? 'active' : ''}
              onClick={() => setTab('history')}
              data-testid="tab-history"
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'settings'}
              className={tab === 'settings' ? 'active' : ''}
              onClick={() => setTab('settings')}
              data-testid="tab-settings"
            >
              Settings
            </button>
          </nav>
          {tab === 'history' ? (
            <HistoryPanel
              version={historyVersion}
              selectedId={dictation.result?.id ?? null}
              onSelect={dictation.select}
              onCopy={(text) => void copy(text)}
              onChanged={bumpHistory}
              notify={notify}
            />
          ) : (
            <SettingsPanel
              settings={settings}
              health={health}
              onChange={updateSettings}
              onReset={() => setSettings({ ...DEFAULT_SETTINGS })}
            />
          )}
        </aside>
      </main>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
