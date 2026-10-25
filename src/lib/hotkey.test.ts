import { describe, expect, it } from 'vitest';
import { hotkeyLabel, matchesHotkey } from './hotkey';

const key = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  code,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  ...mods,
});

describe('matchesHotkey', () => {
  it('matches the plain key without modifiers on press', () => {
    expect(matchesHotkey(key('Space'), 'space')).toBe(true);
    expect(matchesHotkey(key('Space', { ctrlKey: true }), 'space')).toBe(false);
    expect(matchesHotkey(key('KeyA'), 'space')).toBe(false);
  });

  it('requires the modifier for modified hotkeys', () => {
    expect(matchesHotkey(key('Space', { ctrlKey: true }), 'ctrl-space')).toBe(true);
    expect(matchesHotkey(key('Space'), 'ctrl-space')).toBe(false);
    expect(matchesHotkey(key('Space', { altKey: true }), 'alt-space')).toBe(true);
  });

  it('ignores modifiers on release', () => {
    expect(matchesHotkey(key('Space'), 'ctrl-space', 'release')).toBe(true);
    expect(matchesHotkey(key('F8', { shiftKey: true }), 'f8', 'release')).toBe(true);
    expect(matchesHotkey(key('Backquote'), 'backquote', 'release')).toBe(true);
  });

  it('has labels', () => {
    expect(hotkeyLabel('ctrl-space')).toBe('Ctrl + Space');
  });
});
