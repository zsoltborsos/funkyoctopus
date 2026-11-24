import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ChatChunk } from '@shared/transport/protocol.ts';
import { insertTimelineEvent, reduceChatChunk } from './chat-message.reducer.ts';
import type { ChatEventItem, ChatMessage, ChatRole } from './chat.types.ts';

describe('reduceChatChunk: compaction', () => {
  it('keeps a compaction in the turn where it happened, between what came before and after', () => {
    const initial: ChatMessage = { id: 'assistant-1', role: 'assistant', steps: [], createdAt: 1, streaming: true };
    const chunks: ChatChunk[] = [
      { kind: 'text', delta: 'Compacting.' },
      { kind: 'compaction', trigger: 'auto', preTokens: 180000, postTokens: 12000 },
      { kind: 'text', delta: 'Done.' },
    ];

    expect(chunks.reduce(reduceChatChunk, initial).steps).toEqual([
      { kind: 'text', text: 'Compacting.' },
      { kind: 'compaction', trigger: 'auto', preTokens: 180000, postTokens: 12000 },
      { kind: 'text', text: 'Done.' },
    ]);
  });
});

describe('reduceChatChunk', () => {
  it('assembles an ordered tool-using assistant turn', () => {
    const initial: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      steps: [],
      createdAt: 1,
      streaming: true,
    };
    const chunks: ChatChunk[] = [
      { kind: 'thinking', delta: 'I should inspect it.' },
      {
        kind: 'tool-call',
        callId: 'call-1',
        tool: 'read',
        summary: 'read: src/App.tsx',
        args: { path: 'src/App.tsx' },
      },
      { kind: 'tool-result', callId: 'call-1', ok: true, output: 'file contents' },
      { kind: 'text', delta: 'The file looks good.' },
    ];

    const message = chunks.reduce(reduceChatChunk, initial);

    expect(message.steps).toEqual([
      { kind: 'thinking', text: 'I should inspect it.' },
      {
        kind: 'tool-call',
        callId: 'call-1',
        tool: 'read',
        summary: 'read: src/App.tsx',
        args: { path: 'src/App.tsx' },
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        ok: true,
        output: 'file contents',
      },
      { kind: 'text', text: 'The file looks good.' },
    ]);
  });

  it('coalesces adjacent deltas without crossing step boundaries', () => {
    const initial: ChatMessage = { id: 'a', role: 'assistant', steps: [], createdAt: 1 };
    const chunks: ChatChunk[] = [
      { kind: 'thinking', delta: 'one' },
      { kind: 'thinking', delta: ' two' },
      { kind: 'text', delta: 'three' },
      { kind: 'text', delta: ' four' },
    ];

    expect(chunks.reduce(reduceChatChunk, initial).steps).toEqual([
      { kind: 'thinking', text: 'one two' },
      { kind: 'text', text: 'three four' },
    ]);
  });
});

describe('reduceChatChunk custom isolation', () => {
  it('never merges a custom-message chunk into assistant prose', () => {
    const initial: ChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      steps: [{ kind: 'text', text: 'already said' }],
      createdAt: 1,
      streaming: true,
    };
    const message = reduceChatChunk(initial, {
      kind: 'custom-message',
      id: 'event-1',
      customType: 'crew-result',
      display: true,
      content: 'result body',
      details: { agentId: 'scout-1' },
      timestamp: 5,
    });

    // The event is session-level, not a step: the assistant prose is untouched.
    expect(message.steps).toEqual([{ kind: 'text', text: 'already said' }]);
    expect(message).toBe(initial);
  });
});

describe('insertTimelineEvent', () => {
  const message = (id: string, createdAt: number): ChatMessage => ({
    id,
    role: 'assistant',
    steps: [],
    createdAt,
  });
  const event = (id: string, timestamp: number, customType = 'crew-result'): ChatEventItem => ({
    kind: 'custom-message',
    id,
    customType,
    display: true,
    content: 'body',
    details: {},
    timestamp,
  });

  it('inserts chronologically without merging into a message', () => {
    const timeline = [message('m1', 10), message('m2', 30)];
    expect(insertTimelineEvent(timeline, event('e1', 20))).toEqual([
      message('m1', 10),
      event('e1', 20),
      message('m2', 30),
    ]);
  });

  it('appends events newer than everything', () => {
    const timeline = [message('m1', 10)];
    expect(insertTimelineEvent(timeline, event('e1', 20))).toEqual([
      message('m1', 10),
      event('e1', 20),
    ]);
  });

  it('deduplicates by stable id', () => {
    const timeline = [message('m1', 10), event('e1', 20)];
    expect(insertTimelineEvent(timeline, event('e1', 20))).toBe(timeline);
  });

  it('keeps distinct events with the same customType but different ids', () => {
    const timeline = [event('e1', 10)];
    const next = insertTimelineEvent(timeline, event('e2', 20));
    expect(next).toHaveLength(2);
  });
});

describe('ChatRole stays binary', () => {
  it('keeps the wire role exactly user | assistant — events carry no role', () => {
    // Type-level contract: Phase 2 must not widen ChatRole to absorb custom
    // events. The discriminated timeline union handles them via `kind`, and a
    // custom event has no `role` field at all.
    expectTypeOf<ChatRole>().toEqualTypeOf<'user' | 'assistant'>();
  });
});

describe('reduceChatChunk tool-result details', () => {
  it('carries tool-result details into the step', () => {
    const initial: ChatMessage = { id: 'a1', role: 'assistant', steps: [], createdAt: 1 };
    const message = reduceChatChunk(initial, {
      kind: 'tool-result',
      callId: 'call-1',
      ok: true,
      output: 'ok',
      details: { id: 'scout-1' },
    });
    expect(message.steps).toContainEqual({
      kind: 'tool-result',
      callId: 'call-1',
      ok: true,
      output: 'ok',
      details: { id: 'scout-1' },
    });
  });
});
