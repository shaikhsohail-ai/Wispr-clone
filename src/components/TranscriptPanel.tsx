import { useState } from 'react';
import type { EditorDictation, Phase } from '../hooks/useDictation';
import type { TalkMode } from '../lib/settings';
import { formatDuration, wordsPerMinute } from '../shared/text';
import { ENGINE_SHORT_LABELS, POLISH_MODES, type EngineId, type PolishMode } from '../shared/types';

interface Props {
  phase: Phase;
  interimText: string;
  result: EditorDictation | null;
  error: string | null;
  activeEngine: EngineId | null;
  elapsedMs: number;
  canPolish: boolean;
  polishMode: PolishMode;
  hotkeyLabel: string;
  talkMode: TalkMode;
  onPolishModeChange: (mode: PolishMode) => void;
  onPolish: (mode: PolishMode) => void;
  onSave: (text: string) => void;
  onDelete: () => void;
  onCopy: (text: string) => void;
  onNew: () => void;
  onDismissError: () => void;
}

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function TranscriptPanel(props: Props) {
  const { phase, interimText, result, error, activeEngine, elapsedMs, canPolish, polishMode, hotkeyLabel, talkMode } = props;
  // The editable draft follows the result; when a different result (or an updated text) arrives, adopt it.
  const resultKey = result ? `${result.id}:${result.updatedAt}:${result.text}` : 'none';
  const [draftState, setDraftState] = useState({ key: resultKey, text: result?.text ?? '' });
  if (draftState.key !== resultKey) setDraftState({ key: resultKey, text: result?.text ?? '' });
  const draft = draftState.key === resultKey ? draftState.text : (result?.text ?? '');
  const setDraft = (text: string) => setDraftState({ key: resultKey, text });

  if (phase === 'error' && error) {
    return (
      <section className="panel transcript error-panel" data-testid="transcript-error" role="alert">
        <h2>Something went wrong</h2>
        <p>{error}</p>
        <div className="actions">
          <button type="button" className="btn" onClick={props.onDismissError}>
            Dismiss
          </button>
        </div>
      </section>
    );
  }

  if (phase === 'listening' || phase === 'transcribing' || phase === 'polishing' || phase === 'saving') {
    const label =
      phase === 'listening'
        ? `Listening ${formatClock(elapsedMs)}`
        : phase === 'transcribing'
          ? 'Transcribing…'
          : phase === 'polishing'
            ? 'Polishing with AI…'
            : 'Saving…';
    return (
      <section className="panel transcript live" data-testid="transcript-live" aria-live="polite">
        <div className="live-status">
          <span className={`dot ${phase === 'listening' ? 'dot-live' : 'dot-busy'}`} />
          <span data-testid="live-status">{label}</span>
          {activeEngine && <span className="chip">{ENGINE_SHORT_LABELS[activeEngine]}</span>}
        </div>
        <p className="live-text">
          {interimText ||
            (phase === 'listening'
              ? activeEngine === 'webspeech'
                ? 'Speak now, words appear as they are recognised.'
                : `Speak now. ${talkMode === 'hold' ? `Release ${hotkeyLabel}` : `Press ${hotkeyLabel} again`} when you are done.`
              : '')}
        </p>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="panel transcript empty" data-testid="transcript-empty">
        <h2>Your words, typed for you</h2>
        <p>
          {talkMode === 'hold' ? (
            <>
              Hold <kbd>{hotkeyLabel}</kbd> (or the microphone button), speak, then let go.
            </>
          ) : (
            <>
              Press <kbd>{hotkeyLabel}</kbd> (or the microphone button) to start, and again to finish.
            </>
          )}
        </p>
        <ul className="feature-list">
          <li>Filler words like “um” and “uh” are removed automatically.</li>
          <li>Say “comma”, “new paragraph” or “scratch that” to format as you speak.</li>
          <li>Every dictation is saved to the history and copied to your clipboard.</li>
          <li>
            Press <kbd>Esc</kbd> while listening to cancel.
          </li>
        </ul>
      </section>
    );
  }

  const dirty = draft.trim() !== result.text;
  const wpm = wordsPerMinute(result.wordCount, result.durationMs);
  return (
    <section className="panel transcript done" data-testid="transcript-result">
      <div className="result-meta">
        <span>{new Date(result.createdAt).toLocaleString()}</span>
        <span className="chip">{ENGINE_SHORT_LABELS[result.engine]}</span>
        <span>{result.wordCount} words</span>
        {result.durationMs > 0 && <span>{formatDuration(result.durationMs)}</span>}
        {wpm > 0 && <span>{wpm} wpm</span>}
        {result.polished && <span className="chip chip-accent">AI polished</span>}
        {result.unsaved && <span className="chip chip-warn">Not saved</span>}
      </div>
      <textarea
        className="result-text"
        data-testid="result-text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={Math.min(14, Math.max(4, draft.split('\n').length + 2))}
        aria-label="Dictated text"
        spellCheck
      />
      {result.rawText && result.rawText !== result.text && (
        <details className="raw-text">
          <summary>Raw transcript</summary>
          <p data-testid="raw-text">{result.rawText}</p>
        </details>
      )}
      <div className="actions">
        <button type="button" className="btn btn-primary" data-testid="copy-button" onClick={() => props.onCopy(draft)}>
          Copy
        </button>
        {dirty && (
          <button type="button" className="btn" data-testid="save-button" onClick={() => props.onSave(draft)}>
            Save changes
          </button>
        )}
        <span className="polish-group">
          <select
            className="select"
            value={polishMode}
            aria-label="Polish style"
            data-testid="polish-mode"
            onChange={(event) => props.onPolishModeChange(event.target.value as PolishMode)}
            disabled={!canPolish}
          >
            {(Object.keys(POLISH_MODES) as PolishMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {POLISH_MODES[mode].label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            data-testid="polish-button"
            disabled={!canPolish}
            title={canPolish ? POLISH_MODES[polishMode].hint : 'Set ANTHROPIC_API_KEY on the server to enable AI polish'}
            onClick={() => props.onPolish(polishMode)}
          >
            ✨ Polish
          </button>
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost" data-testid="new-button" onClick={props.onNew}>
          New dictation
        </button>
        <button type="button" className="btn btn-danger" data-testid="delete-button" onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </section>
  );
}
