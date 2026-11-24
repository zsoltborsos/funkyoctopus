import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from './approval-broker.ts';

describe('ApprovalBroker', () => {
  it('emits an inline request and suspends until resolved', async () => {
    const broker = new ApprovalBroker();
    const emit = vi.fn();
    broker.setEmitter(emit);

    const pending = broker.request({
      callId: 'call-1',
      tool: 'bash',
      target: '/srv/prod',
      args: { command: 'deploy' },
    });

    expect(emit).toHaveBeenCalledWith({
      kind: 'approval-request',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      callId: 'call-1',
      tool: 'bash',
      target: '/srv/prod',
      args: { command: 'deploy' },
    });
    const { requestId } = emit.mock.calls[0]?.[0] as { requestId: string };
    // The tool-call id is not the answer key: providers reuse index-style ids.
    expect(broker.resolve('call-1', true)).toBe(false);
    expect(broker.resolve(requestId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(broker.resolve(requestId, false)).toBe(false);
  });

  it('also tells a standing listener of every request, with or without a turn to emit into', async () => {
    const broker = new ApprovalBroker();
    const heard = vi.fn();
    broker.onRequest(heard);

    const unseen = broker.request({ callId: 'call-2', tool: 'bash', target: '/x', args: {} });
    const emit = vi.fn();
    broker.setEmitter(emit);
    const seen = broker.request({ callId: 'call-3', tool: 'read', target: '/y', args: {} });

    const heardChunks = heard.mock.calls.map(([chunk]) => chunk as { requestId: string; callId: string });
    expect(heardChunks.map((chunk) => chunk.callId)).toEqual(['call-2', 'call-3']);
    expect(emit).toHaveBeenCalledTimes(1);
    broker.resolve(heardChunks[0]?.requestId ?? '', false);
    broker.resolve(heardChunks[1]?.requestId ?? '', true);
    await expect(unseen).resolves.toBe(false);
    await expect(seen).resolves.toBe(true);
  });

  it('tells a standing listener of every answer, so every view of the slot can settle its card', async () => {
    const broker = new ApprovalBroker();
    const asked = vi.fn();
    const answered = vi.fn();
    broker.onRequest(asked);
    broker.onResolved(answered);
    const pending = broker.request({ callId: 'call-4', tool: 'bash', target: '/z', args: {} });
    const { requestId } = asked.mock.calls[0]?.[0] as { requestId: string };

    expect(broker.resolve('nobody-asked', true)).toBe(false);
    expect(answered).not.toHaveBeenCalled();
    expect(broker.resolve(requestId, false)).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(answered.mock.calls).toEqual([[{ kind: 'approval-resolved', requestId, approved: false }]]);
    // An answer is given once: a second one is refused and announces nothing.
    expect(broker.resolve(requestId, true)).toBe(false);
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it('keeps two requests for a reused tool-call id apart', async () => {
    const broker = new ApprovalBroker();
    const emit = vi.fn();
    broker.setEmitter(emit);
    const first = broker.request({ callId: 'read:5', tool: 'read', target: '/a', args: {} });
    const second = broker.request({ callId: 'read:5', tool: 'read', target: '/b', args: {} });
    const [a, b] = emit.mock.calls.map(([chunk]) => (chunk as { requestId: string }).requestId);
    expect(a).not.toBe(b);

    expect(broker.resolve(b as string, false)).toBe(true);
    await expect(second).resolves.toBe(false);
    expect(broker.resolve(a as string, true)).toBe(true);
    await expect(first).resolves.toBe(true);
  });
});
