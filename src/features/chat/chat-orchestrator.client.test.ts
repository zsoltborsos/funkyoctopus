import { describe, expect, it, vi } from 'vitest';
import type { TransportClient, StreamHandlers } from '@core/transport/transport-client.ts';
import type { ChatChunk } from '@shared/transport/protocol.ts';
import { ChatOrchestrator } from './chat-orchestrator.client.ts';

/** Captures the transport stream handlers so the test can drive chunks. */
function fakeTransport() {
  let handlers: StreamHandlers | null = null;
  let lastParams: unknown = null;
  const cancel = vi.fn();
  const transport = {
    stream: (_method: string, params: unknown, h: StreamHandlers) => {
      handlers = h;
      lastParams = params;
      return cancel;
    },
  } as unknown as TransportClient;
  const params = (): unknown => lastParams;
  const emit = (): StreamHandlers => {
    if (!handlers) {
      throw new Error('stream not started');
    }
    return handlers;
  };
  return { transport, cancel, emit, params };
}

describe('ChatOrchestrator', () => {
  it('routes text and thinking chunks, and signals completion', () => {
    const { transport, emit } = fakeTransport();
    const orchestrator = new ChatOrchestrator(transport);
    const onChunk = vi.fn<(chunk: ChatChunk) => void>();
    const onDone = vi.fn();
    const onError = vi.fn();

    orchestrator.send('hi', { onChunk, onDone, onError });
    const h = emit();
    h.onChunk({ kind: 'thinking', delta: 'hmm' });
    h.onChunk({ kind: 'text', delta: 'hel' });
    h.onChunk({ kind: 'text', delta: 'lo' });
    h.onEnd();

    expect(onChunk.mock.calls.map((call) => call[0])).toEqual([
      { kind: 'thinking', delta: 'hmm' },
      { kind: 'text', delta: 'hel' },
      { kind: 'text', delta: 'lo' },
    ]);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards the per-turn model + effort in the stream params', () => {
    const { transport, params } = fakeTransport();
    const orchestrator = new ChatOrchestrator(transport);

    orchestrator.send(
      'hi',
      { onChunk: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
      { provider: 'opencode-go', model: 'grok-4.5', effort: 'high' },
    );

    expect(params()).toEqual({ chatId: 'main', text: 'hi', provider: 'opencode-go', model: 'grok-4.5', effort: 'high' });
  });

  it('surfaces stream errors through onError with message and code', () => {
    const { transport, emit } = fakeTransport();
    const orchestrator = new ChatOrchestrator(transport);
    const onError = vi.fn();
    orchestrator.send('hi', { onChunk: vi.fn(), onDone: vi.fn(), onError });
    emit().onEnd({ message: 'model exploded' });
    expect(onError).toHaveBeenCalledWith('model exploded', undefined);
    emit().onEnd({ message: 'a turn is already running', code: 'turn_in_progress' });
    expect(onError).toHaveBeenLastCalledWith('a turn is already running', 'turn_in_progress');
  });
});

describe('ChatOrchestrator client identity', () => {
  /** Fake transport capturing stream params and call (method, params). */
  function capturingTransport() {
    const streams: Array<{ method: string; params: unknown }> = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      stream: (method: string, params: unknown, _h: StreamHandlers) => {
        streams.push({ method, params });
        return () => undefined;
      },
      call: (method: string, params: unknown) => {
        calls.push({ method, params });
        return Promise.resolve([]);
      },
    } as unknown as TransportClient;
    return { transport, streams, calls };
  }

  it('carries the clientId into every mutating chat request', async () => {
    const { transport, streams, calls } = capturingTransport();
    const orchestrator = new ChatOrchestrator(transport);
    const noop = (): void => undefined;

    orchestrator.send('hi', { onChunk: noop, onDone: noop, onError: noop }, {}, [], 'tab-1');
    await orchestrator.newChat('tab-1');
    await orchestrator.openChat('/s/1.jsonl', 'tab-1');
    await orchestrator.setRoot('/p', 'tab-1');
    orchestrator.observe({ onChunk: noop, onEnd: noop }, 'tab-1');

    expect(streams.map((s) => s.params)).toEqual([
      { chatId: 'main', text: 'hi', clientId: 'tab-1' },
      { chatId: 'main', clientId: 'tab-1' },
    ]);
    expect(calls).toEqual([
      { method: 'chat.new', params: { chatId: 'main', clientId: 'tab-1' } },
      { method: 'chat.open', params: { chatId: 'main', path: '/s/1.jsonl', clientId: 'tab-1' } },
      { method: 'chat.setRoot', params: { chatId: 'main', path: '/p', clientId: 'tab-1' } },
    ]);
  });

  it('omits the key when no clientId is supplied', async () => {
    const { transport, streams, calls } = capturingTransport();
    const orchestrator = new ChatOrchestrator(transport);
    const noop = (): void => undefined;

    orchestrator.send('hi', { onChunk: noop, onDone: noop, onError: noop });
    await orchestrator.newChat();
    await orchestrator.openChat('/s/1.jsonl');
    await orchestrator.setRoot('/p');
    orchestrator.observe({ onChunk: noop, onEnd: noop });

    for (const params of [...streams.map((s) => s.params), ...calls.map((c) => c.params)]) {
      expect(params).not.toHaveProperty('clientId');
    }
  });

  it('transcript reads back through chat.transcript', async () => {
    const { transport, calls } = capturingTransport();
    const orchestrator = new ChatOrchestrator(transport);
    await orchestrator.transcript();
    expect(calls).toEqual([{ method: 'chat.transcript', params: { chatId: 'main' } }]);
  });

  it('names the chat slot it was made for on every chat call and stream', async () => {
    const { transport, streams, calls } = capturingTransport();
    const orchestrator = new ChatOrchestrator(transport, 'c7');
    const noop = (): void => undefined;

    orchestrator.send('hi', { onChunk: noop, onDone: noop, onError: noop });
    orchestrator.observe({ onChunk: noop, onEnd: noop });
    await orchestrator.newChat();
    await orchestrator.openChat('/s/1.jsonl');
    await orchestrator.setRoot('/p');
    await orchestrator.chatExists('/s/1.jsonl');
    await orchestrator.transcript();
    await orchestrator.listChats(null);
    await orchestrator.currentChat();

    for (const params of [...streams.map((s) => s.params), ...calls.map((c) => c.params)]) {
      expect(params).toMatchObject({ chatId: 'c7' });
    }
    expect(calls).toHaveLength(7);
  });

  it('resolves an approval by request id alone: any view of any chat can answer it', async () => {
    const { transport, calls } = capturingTransport();
    await new ChatOrchestrator(transport, 'c7').resolveApproval('r1', true);
    expect(calls).toEqual([{ method: 'vault.resolve', params: { requestId: 'r1', approved: true } }]);
  });
});

describe('ChatOrchestrator observe', () => {
  it('opens the observation stream and forwards custom-message chunks', () => {
    const { transport, emit } = fakeTransport();
    const orchestrator = new ChatOrchestrator(transport);
    const onChunk = vi.fn();
    const onEnd = vi.fn();

    const cancel = orchestrator.observe({ onChunk, onEnd });
    const h = emit();
    h.onChunk({
      kind: 'custom-message',
      id: 'entry-1',
      customType: 'crew-result',
      display: true,
      content: 'body',
      details: { agentId: 'scout-1' },
      timestamp: 1000,
    });
    expect(onChunk).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'custom-message', id: 'entry-1' }),
    );

    cancel();
    expect(onEnd).not.toHaveBeenCalled();
  });
});

describe('ChatOrchestrator projects', () => {
  it('discovers the catalog and resolves a typed path through the transport', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      call: (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'projects.discover') {
          return Promise.resolve({
            globalRoot: '/home/you/Work',
            known: [],
            folders: [],
          });
        }
        return Promise.resolve({
          id: '/home/you/Work/x',
          name: 'x',
          path: '/home/you/Work/x',
          envTier: 'normal',
        });
      },
    } as unknown as TransportClient;
    const orchestrator = new ChatOrchestrator(transport);

    const catalog = await orchestrator.discoverProjects();
    expect(calls).toEqual([{ method: 'projects.discover', params: {} }]);
    expect(catalog.globalRoot).toBe('/home/you/Work');

    const option = await orchestrator.resolveProject('/somewhere/else');
    expect(calls[1]).toEqual({ method: 'projects.resolve', params: { path: '/somewhere/else' } });
    expect(option.name).toBe('x');
  });
});
