import type { PointerEvent } from 'react';
import type { Phase } from '../hooks/useDictation';
import type { TalkMode } from '../lib/settings';

interface Props {
  phase: Phase;
  talkMode: TalkMode;
  onStart: () => void;
  onStop: () => void;
  onToggle: () => void;
}

const BUSY: Phase[] = ['transcribing', 'polishing', 'saving'];

export function MicButton({ phase, talkMode, onStart, onStop, onToggle }: Props) {
  const busy = BUSY.includes(phase);
  const listening = phase === 'listening';

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (talkMode !== 'hold' || busy) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onStart();
  };

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (talkMode !== 'hold') return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (listening) onStop();
  };

  const label = busy
    ? 'Working…'
    : listening
      ? talkMode === 'hold'
        ? 'Release to transcribe'
        : 'Stop'
      : talkMode === 'hold'
        ? 'Hold to talk'
        : 'Start dictating';

  return (
    <button
      type="button"
      className={`mic-button phase-${phase}`}
      data-testid="mic-button"
      data-phase={phase}
      aria-pressed={listening}
      aria-label={label}
      title={label}
      disabled={busy}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onClick={(event) => {
        if (talkMode === 'toggle' && !busy) {
          event.preventDefault();
          onToggle();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="mic-ring" aria-hidden="true" />
      <span className="mic-ring mic-ring-2" aria-hidden="true" />
      <span className="mic-icon" aria-hidden="true">
        {busy ? (
          <span className="spinner" />
        ) : (
          <svg
            viewBox="0 0 24 24"
            width="36"
            height="36"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" />
            <path d="M12 18v3" />
            <path d="M8.5 21h7" />
          </svg>
        )}
      </span>
    </button>
  );
}
