import type { KeyboardEvent, PointerEvent } from 'react';
import { isBusyPhase, type Phase } from '../hooks/useDictation';
import type { TalkMode } from '../lib/settings';

interface Props {
  phase: Phase;
  talkMode: TalkMode;
  onStart: () => void;
  onStop: () => void;
  onToggle: () => void;
}

const isActivationKey = (event: KeyboardEvent<HTMLButtonElement>) => event.key === 'Enter' || event.key === ' ';

export function MicButton({ phase, talkMode, onStart, onStop, onToggle }: Props) {
  const busy = isBusyPhase(phase);
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

  // Keyboard on the focused button: in hold mode Enter and Space work like a held key (the global hotkey may also
  // see Space; start()/stop() ignore the duplicate). Preventing the default also suppresses the native click.
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (talkMode !== 'hold' || !isActivationKey(event)) return;
    event.preventDefault();
    if (event.repeat || busy) return;
    onStart();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (talkMode !== 'hold' || !isActivationKey(event)) return;
    event.preventDefault();
    if (listening) onStop();
  };

  const label = busy
    ? 'Working…'
    : listening
      ? talkMode === 'hold'
        ? 'Release (or press again) to transcribe'
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
      // aria-disabled keeps the button focusable while a run is in flight, so keyboard users do not lose their place.
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={(event) => {
        if (busy) return;
        // A pointer click carries detail >= 1 and is handled by the pointer events above. A click with detail 0 comes
        // from a screen reader or switch, which cannot hold a key, so it toggles even in hold mode.
        if (talkMode === 'toggle' || event.detail === 0) {
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
