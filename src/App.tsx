import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { HistoryPanel } from './components/HistoryPanel';
import { MicButton } from './components/MicButton';
import { SettingsPanel } from './components/SettingsPanel';
import { StatsBar } from './components/StatsBar';
import { TranscriptPanel } from './components/TranscriptPanel';
import { Toasts } from './components/Toasts';
import { Waveform } from './components/Waveform';
import { isBusyPhase, resolveEngine, useDictation } from './hooks/useDictation';
import { useToasts } from './hooks/useToasts';
import { useTouchFirst } from './hooks/useTouchFirst';
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
  const touchFirst = useTouchFirst();

  const dictation = useDictation({ settings, health, notify, onSaved: bumpHistory, onChanged: bumpHistory });
  const { phase, start, stop, toggle, cancel } = dictation;

  /** The app handled the matching keydown, so its keyup is ours to act on (a plain Space on a control is not). */
  const hotkeyHeld = useRef(false);
  /** In hold mode the key went down while a run was still in flight; start as soon as it settles. */
  const pendingHold = useRef(false);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    let wasDown = false;
    const poll = async () => {
      try {
        const info = await api.health();
        if (cancelled) return;
        setHealth(info);
        setServerOnline(true);
        if (wasDown) {
          // The sidebar only refetches when the version changes; refresh it now that the server is back.
          wasDown = false;
          bumpHistory();
        }
        timer = window.setTimeout(poll, 30_000);
      } catch {
        if (cancelled) return;
        wasDown = true;
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
        pendingHold.current = false;
        void cancel();
        return;
      }
      if (event.repeat || isEditableTarget(event.target)) return;
      if (!matchesHotkey(event, settings.hotkey, 'press')) return;
      event.preventDefault();
      hotkeyHeld.current = true;
      if (settings.talkMode === 'hold') {
        if (isBusyPhase(phase)) pendingHold.current = true;
        else if (phase !== 'listening') void start();
      } else {
        toggle();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!hotkeyHeld.current || !matchesHotkey(event, settings.hotkey, 'release')) return;
      hotkeyHeld.current = false;
      pendingHold.current = false;
      event.preventDefault();
      if (settings.talkMode === 'hold' && phase === 'listening') void stop();
    };
    const onBlur = () => {
      hotkeyHeld.current = false;
      pendingHold.current = false;
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

  // A hold that began while the previous dictation was still being processed starts once that run has settled.
  useEffect(() => {
    if (settings.talkMode !== 'hold' || !pendingHold.current) return;
    if (phase === 'done' || phase === 'idle' || phase === 'error') {
      pendingHold.current = false;
      void start();
    }
  }, [phase, settings.talkMode, start]);

  const updateSettings = useCallback((patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })), []);

  const resetSettings = useCallback(() => {
    if (settings.dictionary.length > 0 && !window.confirm('Reset all settings and remove your personal dictionary?')) return;
    setSettings({ ...DEFAULT_SETTINGS });
  }, [settings.dictionary.length]);

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
  const busy = isBusyPhase(phase);

  const heroHint = busy
    ? 'Working on it…'
    : touchFirst
      ? listening
        ? settings.talkMode === 'hold'
          ? 'Let go to finish'
          : 'Tap again to finish'
        : settings.talkMode === 'hold'
          ? 'Hold the button to talk'
          : 'Tap the button to start'
      : listening
        ? settings.talkMode === 'hold'
          ? `Release ${hotkey} to finish`
          : `Press ${hotkey} to finish`
        : settings.talkMode === 'hold'
          ? `Hold ${hotkey} to talk`
          : `Press ${hotkey} to start`;

  // One short announcement per phase change for screen readers; the live panel itself is not a live region.
  const announcement =
    phase === 'listening'
      ? 'Listening'
      : phase === 'transcribing'
        ? 'Transcribing'
        : phase === 'polishing'
          ? 'Polishing with AI'
          : phase === 'saving'
            ? 'Saving'
            : phase === 'done' && dictation.result
              ? `Dictation ready, ${dictation.result.wordCount} words`
              : '';

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
            <p className="hero-hint">{heroHint}</p>
            <span className="sr-only" role="status" data-testid="phase-status">
              {announcement}
            </span>
            <Waveform active={listening} getLevel={dictation.getLevel} />
          </div>

          <TranscriptPanel
            phase={phase}
            interimText={dictation.interimText}
            result={dictation.result}
            error={dictation.error}
            canRetry={dictation.canRetry}
            activeEngine={dictation.activeEngine}
            elapsedMs={dictation.elapsedMs}
            canPolish={Boolean(health?.polish)}
            polishMode={settings.polishMode}
            hotkeyLabel={hotkey}
            talkMode={settings.talkMode}
            touchFirst={touchFirst}
            onPolishModeChange={(mode: PolishMode) => updateSettings({ polishMode: mode })}
            onPolish={(mode, text) => void dictation.polishCurrent(mode, text)}
            onSave={(text) => void dictation.saveEdit(text)}
            onRetrySave={() => void dictation.retrySave()}
            onDelete={() => void dictation.deleteCurrent()}
            onCopy={(text) => void copy(text)}
            onNew={() => dictation.select(null)}
            onCancel={() => void cancel()}
            onRetry={() => void dictation.retry()}
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
              onDeleted={dictation.discard}
              notify={notify}
            />
          ) : (
            <SettingsPanel settings={settings} health={health} onChange={updateSettings} onReset={resetSettings} />
          )}
        </aside>
      </main>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
