import { useSyncExternalStore } from 'react';

/** Phones and tablets: no hover and a coarse pointer. Hybrids (touch laptops, iPad + keyboard) report false. */
const QUERY = '(hover: none) and (pointer: coarse)';

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = mediaQuery();
  if (!mql) return () => undefined;
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return mediaQuery()?.matches ?? false;
}

/** True on a touch-first device, so on-screen instructions can talk about the button instead of a key. Live: docking a keyboard updates it. */
export function useTouchFirst(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
