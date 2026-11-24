import { describe, expect, it } from 'vitest';
import type { CustomMessageEntry } from '@earendil-works/pi-coding-agent';
import {
  createCustomIdState,
  customMessageChunkFromEntry,
  customMessageChunkFromLive,
  customMessageText,
  jsonSafeDetails,
  resolveCustomEntryId,
  type CustomIdState,
} from './custom-message.ts';

function liveMessage(overrides: Record<string, unknown> = {}): {
  role: 'custom';
  customType: string;
  content: unknown;
  display: boolean;
  details: unknown;
  timestamp: number;
} {
  return {
    role: 'custom',
    customType: 'crew-result',
    content: 'result body',
    display: true,
    details: { agentId: 'scout-1' },
    timestamp: 1000,
    ...overrides,
  } as never;
}

function customEntry(id: string, overrides: Record<string, unknown> = {}): CustomMessageEntry {
  return {
    type: 'custom_message',
    id,
    parentId: null,
    timestamp: '1970-01-01T00:00:01.000Z',
    customType: 'crew-result',
    content: 'result body',
    display: true,
    details: { agentId: 'scout-1' },
    ...overrides,
  } as unknown as CustomMessageEntry;
}

describe('customMessageText', () => {
  it('passes a plain string through verbatim', () => {
    expect(customMessageText('plain body')).toBe('plain body');
  });

  it('joins text parts and skips images and junk', () => {
    expect(
      customMessageText([
        { type: 'text', text: 'line one' },
        { type: 'image', source: 'data:' },
        { type: 'text', text: 'line two' },
        { type: 'other', value: 1 },
      ]),
    ).toBe('line one\nline two');
  });

  it('returns empty string for non-text content', () => {
    expect(customMessageText(42)).toBe('');
    expect(customMessageText(null)).toBe('');
  });
});

describe('jsonSafeDetails', () => {
  it('copies plain JSON values unchanged', () => {
    const input = { a: 1, b: 'x', c: true, d: null, list: [1, { k: 2 }] };
    expect(jsonSafeDetails(input)).toEqual(input);
  });

  it('neutralises cycles instead of throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const safe = jsonSafeDetails(cyclic);
    expect(safe).toEqual({ a: 1, self: null });
  });

  it('neutralises functions, symbols and undefined', () => {
    const safe = jsonSafeDetails({
      fn: () => 1,
      sym: Symbol('x'),
      undef: undefined,
      ok: 'kept',
    });
    expect(safe).toEqual({ fn: null, sym: null, undef: null, ok: 'kept' });
  });

  it('keeps shared references as independent copies, not cycles', () => {
    const shared = { x: 1 };
    expect(jsonSafeDetails([shared, shared])).toEqual([{ x: 1 }, { x: 1 }]);
  });
});

describe('resolveCustomEntryId', () => {
  const freshState = (): CustomIdState => createCustomIdState();

  it('matches semantically and ignores deliberately divergent timestamps', () => {
    // The entry and the live event are 151 seconds apart — timestamp equality
    // is not part of the match; semantic fields and append order decide.
    const entries = [customEntry('match', { timestamp: '1970-01-01T00:02:31.000Z' })];
    expect(resolveCustomEntryId(entries, freshState(), liveMessage({ timestamp: 1000 }))).toBe(
      'match',
    );
  });

  it('matches on customType, display, normalized content and JSON-safe details', () => {
    const entries = [customEntry('match')];
    expect(
      resolveCustomEntryId(
        entries,
        freshState(),
        liveMessage({ content: [{ type: 'text', text: 'result body' }], details: { agentId: 'scout-1' } }),
      ),
    ).toBe('match');
  });

  it('gives two distinct identical events two distinct ids (oldest unmatched first)', () => {
    const state = freshState();
    const entries = [customEntry('a'), customEntry('b')];
    const first = liveMessage();
    const second = liveMessage(); // same semantic fields, distinct event object
    expect(resolveCustomEntryId(entries, state, first)).toBe('a');
    expect(resolveCustomEntryId(entries, state, second)).toBe('b');
  });

  it('resolves the same message object to the same id, so simultaneous observers agree', () => {
    const state = freshState();
    const entries = [customEntry('a')];
    const message = liveMessage();
    expect(resolveCustomEntryId(entries, state, message)).toBe('a');
    // chat.send and the observation stream observe the same event object; the
    // per-message cache must return the same canonical entry id, not claim a
    // fresh one.
    expect(resolveCustomEntryId(entries, state, message)).toBe('a');
  });

  it('returns null on a semantic mismatch', () => {
    expect(
      resolveCustomEntryId(
        [customEntry('a', { customType: 'crew-list-warning' })],
        freshState(),
        liveMessage(),
      ),
    ).toBeNull();
  });

  it('keeps display in the match', () => {
    expect(
      resolveCustomEntryId([customEntry('a', { display: false })], freshState(), liveMessage()),
    ).toBeNull();
  });

  it('returns null when nothing is persisted yet — no irreconcilable fallback', () => {
    expect(resolveCustomEntryId([], freshState(), liveMessage())).toBeNull();
  });
});

describe('createCustomIdState seeding', () => {
  it('pre-claims historical entry ids so a resumed session cannot collapse into them', () => {
    const historical = customEntry('historical');
    const fresh = customEntry('fresh');
    // The historical entry was already persisted when the session was armed;
    // its id is pre-claimed, so a new live message with identical semantic
    // fields must resolve to the *new* entry, never the historical one.
    const state = createCustomIdState([historical.id]);
    expect(resolveCustomEntryId([historical, fresh], state, liveMessage())).toBe('fresh');
  });

  it('keeps the same-object cache working on a seeded state', () => {
    const state = createCustomIdState(['historical']);
    const entries = [customEntry('historical'), customEntry('fresh')];
    const message = liveMessage();
    // Simultaneous observers of one event still agree, and the historical id
    // is never offered.
    expect(resolveCustomEntryId(entries, state, message)).toBe('fresh');
    expect(resolveCustomEntryId(entries, state, message)).toBe('fresh');
  });
});

describe('chunk mapping', () => {
  it('maps a persisted entry to a generic chunk with the entry id and epoch timestamp', () => {
    const chunk = customMessageChunkFromEntry(
      customEntry('entry-1', {
        customType: 'crew-result',
        content: 'body',
        display: true,
        details: { agentId: 'scout-1' },
      }),
    );
    expect(chunk).toEqual({
      kind: 'custom-message',
      id: 'entry-1',
      customType: 'crew-result',
      display: true,
      content: 'body',
      details: { agentId: 'scout-1' },
      timestamp: 1000,
    });
  });

  it('maps a live role-custom message preserving display:false and safe details', () => {
    const chunk = customMessageChunkFromLive(
      liveMessage({ display: false, content: 'hidden', details: { status: 'running' } }),
      'entry-2',
    );
    expect(chunk).toEqual({
      kind: 'custom-message',
      id: 'entry-2',
      customType: 'crew-result',
      display: false,
      content: 'hidden',
      details: { status: 'running' },
      timestamp: 1000,
    });
  });

  it('never lets unsafe details reach the wire', () => {
    const cyclic: Record<string, unknown> = { list: [1] };
    cyclic.self = cyclic;
    const chunk = customMessageChunkFromLive(
      liveMessage({ details: cyclic, content: [{ type: 'text', text: 'body' }] }),
      'entry-3',
    );
    expect(JSON.stringify(chunk)).toBe(
      JSON.stringify({
        kind: 'custom-message',
        id: 'entry-3',
        customType: 'crew-result',
        display: true,
        content: 'body',
        details: { list: [1], self: null },
        timestamp: 1000,
      }),
    );
  });
});
