import type { HotkeyId } from './settings';

export interface HotkeyOption {
  id: HotkeyId;
  label: string;
  code: string;
  modifiers: { ctrl?: boolean; alt?: boolean };
}

export const HOTKEY_OPTIONS: HotkeyOption[] = [
  { id: 'space', label: 'Space', code: 'Space', modifiers: {} },
  { id: 'ctrl-space', label: 'Ctrl + Space', code: 'Space', modifiers: { ctrl: true } },
  { id: 'alt-space', label: 'Alt + Space', code: 'Space', modifiers: { alt: true } },
  { id: 'backquote', label: '` (backtick)', code: 'Backquote', modifiers: {} },
  { id: 'f8', label: 'F8', code: 'F8', modifiers: {} },
];

export function hotkeyLabel(id: HotkeyId): string {
  return HOTKEY_OPTIONS.find((h) => h.id === id)?.label ?? id;
}

/**
 * Does this key event trigger the hotkey? On release only the main key is compared, because the
 * modifier is often let go first.
 */
export function matchesHotkey(
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>,
  id: HotkeyId,
  phase: 'press' | 'release' = 'press',
): boolean {
  const option = HOTKEY_OPTIONS.find((h) => h.id === id);
  if (!option || event.code !== option.code) return false;
  if (phase === 'release') return true;
  const wantCtrl = Boolean(option.modifiers.ctrl);
  const wantAlt = Boolean(option.modifiers.alt);
  return event.ctrlKey === wantCtrl && event.altKey === wantAlt && !event.metaKey && !event.shiftKey;
}

/** True when the key press belongs to a text field, where Space must keep typing spaces. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(type);
  }
  return false;
}
