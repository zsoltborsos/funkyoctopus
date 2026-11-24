import { describe, expect, it } from 'vitest';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import {
  INPUT_HISTORY_CAP,
  InputHistoryService,
  caretOnFirstLine,
  caretOnLastLine,
  recallCancel,
  recallNewer,
  recallOlder,
} from './input-history.ts';

describe('InputHistoryService', () => {
  it('records sent text oldest-first and persists across instances', () => {
    const storage = new MemoryStorageAdapter();
    const a = new InputHistoryService(storage);
    a.record('first');
    a.record('second');
    expect(a.list()).toEqual(['first', 'second']);
    expect(new InputHistoryService(storage).list()).toEqual(['first', 'second']);
  });

  it('skips blanks and collapses consecutive repeats, but keeps non-adjacent ones', () => {
    const h = new InputHistoryService(new MemoryStorageAdapter());
    h.record('   ');
    h.record('continue');
    h.record('continue');
    h.record('other');
    h.record('continue');
    expect(h.list()).toEqual(['continue', 'other', 'continue']);
  });

  it('caps the history, dropping the oldest', () => {
    const h = new InputHistoryService(new MemoryStorageAdapter());
    for (let i = 0; i < INPUT_HISTORY_CAP + 5; i++) h.record(`m${i}`);
    expect(h.list()).toHaveLength(INPUT_HISTORY_CAP);
    expect(h.list()[0]).toBe('m5');
  });

  it('tolerates a corrupt stored shape', () => {
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.chat.input-history', [1, 'ok', null]);
    expect(new InputHistoryService(storage).list()).toEqual(['ok']);
    storage.set('funkyoctopus.chat.input-history', { not: 'a list' });
    expect(new InputHistoryService(storage).list()).toEqual([]);
  });
});

describe('recall cursor', () => {
  const entries = ['a', 'b', 'c'];

  it('Up from rest stashes the draft and shows the newest; Up again walks older and stops at the oldest', () => {
    const s1 = recallOlder(entries, null, 'typing…');
    expect(s1).toEqual({ state: { index: 2, stash: 'typing…' }, text: 'c' });
    const s2 = recallOlder(entries, s1!.state, 'c');
    expect(s2).toEqual({ state: { index: 1, stash: 'typing…' }, text: 'b' });
    const s3 = recallOlder(entries, s2!.state, 'b');
    expect(s3!.text).toBe('a');
    expect(recallOlder(entries, s3!.state, 'a')).toBeNull();
  });

  it('Up with no history does nothing', () => {
    expect(recallOlder([], null, 'draft')).toBeNull();
  });

  it('Down walks newer and, past the newest, returns the stashed draft and rests', () => {
    const up = recallOlder(entries, recallOlder(entries, null, 'draft')!.state, 'c')!;
    expect(up.text).toBe('b');
    const d1 = recallNewer(entries, up.state);
    expect(d1).toEqual({ state: { index: 2, stash: 'draft' }, text: 'c' });
    const d2 = recallNewer(entries, d1!.state);
    expect(d2).toEqual({ state: null, text: 'draft' });
    expect(recallNewer(entries, null)).toBeNull();
  });

  it('Esc cancels a recall by returning the stash; at rest it is nothing', () => {
    const up = recallOlder(entries, null, 'half a thought');
    expect(recallCancel(up!.state)).toEqual({ state: null, text: 'half a thought' });
    expect(recallCancel(null)).toBeNull();
  });

  it('caret line tests', () => {
    expect(caretOnFirstLine('one', 3)).toBe(true);
    expect(caretOnFirstLine('one\ntwo', 2)).toBe(true);
    expect(caretOnFirstLine('one\ntwo', 5)).toBe(false);
    expect(caretOnLastLine('one\ntwo', 5)).toBe(true);
    expect(caretOnLastLine('one\ntwo', 2)).toBe(false);
    expect(caretOnLastLine('', 0)).toBe(true);
  });
});
