import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import type { ModelOption } from '@shared/transport/protocol.ts';
import { CHAT_SESSION, type ChatLiveActivity, type ChatSession } from './chat-session.service.ts';
import { MODELS, type ModelsClient } from './models.client.ts';
import { useModels } from './useModels.ts';

const claude = (id: string): ModelOption => ({
  provider: 'claude-code',
  id,
  name: id,
  thinkingLevels: [],
  input: ['text', 'image'],
});
const pi = (id: string): ModelOption => ({ provider: 'openai', id, name: id, thinkingLevels: [], input: ['text'] });

/** A chat session that only announces when turns end, and a models client that answers from a script. */
function setup(lists: (ModelOption[] | Error)[]) {
  const listeners = new Set<(activity: ChatLiveActivity) => void>();
  const list = vi.fn(() => {
    const next = lists.shift();
    if (next === undefined) throw new Error('no more scripted lists');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const container = new Container();
  container.registerInstance(MODELS, { list } as unknown as ModelsClient);
  container.registerInstance(CHAT_SESSION, {
    subscribeActivity: (listener: (activity: ChatLiveActivity) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ChatSession);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ContainerProvider container={container}>{children}</ContainerProvider>
  );
  const turnEnds = () =>
    act(() => {
      for (const listener of [...listeners]) listener({ kind: 'turn-ended', at: 1 });
    });
  return { list, listeners, wrapper, turnEnds };
}

describe('useModels', () => {
  it('loads the models once when the composer mounts', async () => {
    const { wrapper, list } = setup([[pi('gpt')]]);

    const { result } = renderHook(() => useModels(), { wrapper });

    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['gpt']));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('reads Claude Code\'s models again when the first turn ends, then stops asking', async () => {
    // Before any process has run, the engine can only offer the aliases (the SDK lists models through a process).
    const { wrapper, list, turnEnds, listeners } = setup([
      [claude('sonnet'), claude('opus'), claude('haiku')],
      [claude('opus'), claude('sonnet'), claude('haiku'), claude('claude-haiku-4-5-20251001')],
    ]);
    const { result } = renderHook(() => useModels(), { wrapper });
    await waitFor(() => expect(result.current.models).toHaveLength(3));

    turnEnds();

    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual([
      'opus', 'sonnet', 'haiku', 'claude-haiku-4-5-20251001',
    ]));
    expect(list).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
    turnEnds();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('leaves pi\'s list alone: its models do not change when a turn ends', async () => {
    const { wrapper, list, turnEnds } = setup([[pi('gpt')]]);
    const { result } = renderHook(() => useModels(), { wrapper });
    await waitFor(() => expect(result.current.models).toHaveLength(1));

    turnEnds();

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('keeps the list it has when the second read fails', async () => {
    const { wrapper, turnEnds } = setup([[claude('sonnet')], new Error('sidecar went away')]);
    const { result } = renderHook(() => useModels(), { wrapper });
    await waitFor(() => expect(result.current.models).toHaveLength(1));

    turnEnds();
    await act(() => Promise.resolve());

    expect(result.current.models.map((m) => m.id)).toEqual(['sonnet']);
    expect(result.current.error).toBeNull();
  });

  it('stops listening when the composer unmounts', async () => {
    const { wrapper, listeners } = setup([[claude('sonnet')]]);
    const { result, unmount } = renderHook(() => useModels(), { wrapper });
    await waitFor(() => expect(result.current.models).toHaveLength(1));
    expect(listeners.size).toBe(1);

    unmount();

    expect(listeners.size).toBe(0);
  });
});
