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
  /** The audio of the failed run is still held, so the transcription can be resent. */
  canRetry: boolean;
  activeEngine: EngineId | null;
  elapsedMs: number;
  canPolish: boolean;
  polishMode: PolishMode;
  hotkeyLabel: string;
  talkMode: TalkMode;
  /** Phone or tablet: instructions talk about the button rather than a key. */
  touchFirst: boolean;
  onPolishModeChange: (mode: PolishMode) => void;
  /** Polish what the user sees: the current draft, edits included. */
  onPolish: (mode: PolishMode, text: string) => void;
  onSave: (text: string) => void;
  onRetrySave: () => void;
  onDelete: () => void;
  onCopy: (text: string) => void;
  onNew: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDismissError: () => void;
}

/** After this long on the local engine, explain that the first run downloads the model. */
const LOCAL_SLOW_MS = 10_000;

function formatClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function TranscriptPanel(props: Props) {
  const { phase, interimText, result, error, canRetry, activeEngine, elapsedMs, canPolish, polishMode, hotkeyLabel, talkMode, touchFirst } =
    props;
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
          {canRetry && (
            <button type="button" className="btn btn-primary" data-testid="retry-button" onClick={props.onRetry}>
              Try again
            </button>
          )}
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
          ? `Transcribing… ${formatClock(elapsedMs)}`
          : phase === 'polishing'
            ? 'Polishing with AI…'
            : 'Saving…';
    const finishHint = touchFirst
      ? talkMode === 'hold'
        ? 'Let go of the button when you are done.'
        : 'Tap the button again when you are done.'
      : talkMode === 'hold'
        ? `Release ${hotkeyLabel} when you are done.`
        : `Press ${hotkeyLabel} again when you are done.`;
    const canCancel = phase === 'transcribing' || (phase === 'listening' && talkMode === 'toggle');
    // The clock and the interim transcript change constantly, so this panel is deliberately not a live region;
    // phase changes are announced once by the status element in App.
    return (
      <section className="panel transcript live" data-testid="transcript-live">
        <div className="live-status">
          <span className={`dot ${phase === 'listening' ? 'dot-live' : 'dot-busy'}`} />
          <span data-testid="live-status">{label}</span>
          {activeEngine && <span className="chip">{ENGINE_SHORT_LABELS[activeEngine]}</span>}
          {canCancel && (
            <button type="button" className="btn btn-small btn-ghost live-cancel" data-testid="cancel-button" onClick={props.onCancel}>
              Cancel
            </button>
          )}
        </div>
        <p className="live-text">
          {interimText ||
            (phase === 'listening'
              ? activeEngine === 'webspeech'
                ? 'Speak now, words appear as they are recognised.'
                : `Speak now. ${finishHint}`
              : '')}
        </p>
        {phase === 'transcribing' && activeEngine === 'local' && elapsedMs > LOCAL_SLOW_MS && (
          <p className="hint">Local Whisper can take a while; the first run downloads the model (about 150 MB).</p>
        )}
      </section>
    );
  }

  if (!result) {
    return (
      <section className="panel transcript empty" data-testid="transcript-empty">
        <h2>Your words, typed for you</h2>
        <p>
          {touchFirst ? (
            talkMode === 'hold' ? (
              <>Hold the microphone button, speak, then let go. With a keyboard, hold {hotkeyLabel}.</>
            ) : (
              <>Tap the microphone button to start, and again to finish. With a keyboard, press {hotkeyLabel}.</>
            )
          ) : talkMode === 'hold' ? (
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
            {touchFirst ? (
              <>Tap Cancel while a dictation is being transcribed to discard it.</>
            ) : (
              <>
                Press <kbd>Esc</kbd> (or Cancel) while listening or transcribing to cancel.
              </>
            )}
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
        {result.unsaved && (
          <>
            <span className="chip chip-warn">Not saved</span>
            <button type="button" className="btn btn-small" data-testid="retry-save-button" onClick={props.onRetrySave}>
              Retry save
            </button>
          </>
        )}
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
            onClick={() => props.onPolish(polishMode, draft)}
          >
            ✨ Polish
          </button>
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-ghost"
          data-testid="new-button"
          onClick={() => {
            if (!dirty || window.confirm('Discard your unsaved changes?')) props.onNew();
          }}
        >
          New dictation
        </button>
        <button type="button" className="btn btn-danger" data-testid="delete-button" onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </section>
  );
}
