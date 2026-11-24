import { describe, expect, it } from 'vitest';
import {
  isJumpToLatestShortcut,
  isNewChatShortcut,
  isStopShortcut,
  newTabShortcut,
  switcherShortcut,
  tabCycleShortcut,
  tabJumpShortcut,
  type KeyLike,
} from './shortcuts.ts';

const key = (over: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});

describe('chat shortcuts', () => {
  it('new chat is Ctrl+N or Alt+N, by physical key, and nothing else', () => {
    expect(isNewChatShortcut(key({ key: 'n', code: 'KeyN', ctrlKey: true }))).toBe(true);
    expect(isNewChatShortcut(key({ key: '˜', code: 'KeyN', altKey: true }))).toBe(true);
    expect(isNewChatShortcut(key({ key: 'n', code: 'KeyN' }))).toBe(false);
    expect(isNewChatShortcut(key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isNewChatShortcut(key({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }))).toBe(false);
    expect(isNewChatShortcut(key({ key: 'n', code: 'KeyN', metaKey: true }))).toBe(false);
  });

  it('jump to latest is Ctrl+End and nothing else', () => {
    expect(isJumpToLatestShortcut(key({ key: 'End', code: 'End', ctrlKey: true }))).toBe(true);
    expect(isJumpToLatestShortcut(key({ key: 'End', code: 'End' }))).toBe(false);
    expect(isJumpToLatestShortcut(key({ key: 'End', code: 'End', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isJumpToLatestShortcut(key({ key: 'Home', code: 'Home', ctrlKey: true }))).toBe(false);
  });

  it('stop is a bare Escape', () => {
    expect(isStopShortcut(key({ key: 'Escape', code: 'Escape' }))).toBe(true);
    expect(isStopShortcut(key({ key: 'Escape', code: 'Escape', shiftKey: true }))).toBe(false);
    expect(isStopShortcut(key({ key: 'Enter', code: 'Enter' }))).toBe(false);
  });

  it('tab jump is Alt+1…9 by physical key, never while composing, never when the key types another character', () => {
    expect(tabJumpShortcut(key({ key: '1', code: 'Digit1', altKey: true }))).toBe(1);
    expect(tabJumpShortcut(key({ key: '9', code: 'Digit9', altKey: true }))).toBe(9);
    // macOS: Option+digit types a character (¡ ™ £ …), which is the owner's to type.
    expect(tabJumpShortcut(key({ key: '¡', code: 'Digit1', altKey: true }))).toBeNull();
    // An input method composing owns the keys.
    expect(tabJumpShortcut(key({ key: '1', code: 'Digit1', altKey: true, isComposing: true }))).toBeNull();
    expect(tabJumpShortcut(key({ key: '0', code: 'Digit0', altKey: true }))).toBeNull();
    expect(tabJumpShortcut(key({ key: '1', code: 'Digit1', ctrlKey: true }))).toBeNull();
    expect(tabJumpShortcut(key({ key: '1', code: 'Digit1', altKey: true, ctrlKey: true }))).toBeNull();
    expect(tabJumpShortcut(key({ key: '!', code: 'Digit1', altKey: true, shiftKey: true }))).toBeNull();
    expect(tabJumpShortcut(key({ key: '1', code: 'Numpad1', altKey: true }))).toBeNull();
  });

  it('next / previous tab is Alt+PageDown / Alt+PageUp, never Alt+arrows (the browser’s back and forward)', () => {
    expect(tabCycleShortcut(key({ key: 'PageDown', code: 'PageDown', altKey: true }))).toBe(1);
    expect(tabCycleShortcut(key({ key: 'PageUp', code: 'PageUp', altKey: true }))).toBe(-1);
    expect(tabCycleShortcut(key({ key: 'PageDown', code: 'PageDown', ctrlKey: true }))).toBeNull();
    expect(tabCycleShortcut(key({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }))).toBeNull();
    expect(tabCycleShortcut(key({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toBeNull();
    expect(tabCycleShortcut(key({ key: 'PageDown', code: 'PageDown', altKey: true, isComposing: true }))).toBeNull();
  });

  it('new tab is Alt+T, never Ctrl+T (the browser keeps it)', () => {
    expect(newTabShortcut(key({ key: 't', code: 'KeyT', altKey: true }))).toBe(true);
    expect(newTabShortcut(key({ key: 't', code: 'KeyT', ctrlKey: true }))).toBe(false);
    expect(newTabShortcut(key({ key: 'T', code: 'KeyT', altKey: true, shiftKey: true }))).toBe(false);
    // macOS: Option+T types †.
    expect(newTabShortcut(key({ key: '†', code: 'KeyT', altKey: true }))).toBe(false);
    expect(newTabShortcut(key({ key: 't', code: 'KeyT', altKey: true, isComposing: true }))).toBe(false);
  });

  it('the switcher is Ctrl+K by physical key, and nothing else', () => {
    expect(switcherShortcut(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe(true);
    // Another layout: the physical key still counts.
    expect(switcherShortcut(key({ key: 'л', code: 'KeyK', ctrlKey: true }))).toBe(true);
    expect(switcherShortcut(key({ key: 'k', code: 'KeyK' }))).toBe(false);
    expect(switcherShortcut(key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(switcherShortcut(key({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }))).toBe(false);
    expect(switcherShortcut(key({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(false);
    expect(switcherShortcut(key({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }))).toBe(false);
  });
});
