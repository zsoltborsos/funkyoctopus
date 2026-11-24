import { describe, expect, it, vi } from 'vitest';
import type { TransportClient } from '@core/transport/transport-client.ts';
import type { ChatSlotInfo, ModelOption } from '@shared/transport/protocol.ts';
import { ModelsClient } from './models.client.ts';

const model = (provider: string, id: string): ModelOption => ({ provider, id, name: id, thinkingLevels: [], input: ['text'] });
const PI = model('opencode-go', 'deepseek-v4-flash');
const CLAUDE = model('claude-code', 'sonnet');

function transportWith(models: ModelOption[], slots: Partial<ChatSlotInfo>[]) {
  const call = vi.fn((method: string) => Promise.resolve(method === 'models.list' ? models : slots));
  return { call, transport: { call } as unknown as TransportClient };
}

describe('ModelsClient', () => {
  it('offers only the models its chat’s engine can run, from the union the sidecar lists', async () => {
    const pi = transportWith([PI, CLAUDE], [{ chatId: 'main', kind: 'pi' }, { chatId: 'c2', kind: 'claude-code' }]);
    expect(await new ModelsClient(pi.transport).list()).toEqual([PI]);
    expect(pi.call).toHaveBeenCalledWith('models.list');
    expect(pi.call).toHaveBeenCalledWith('chat.slots');

    expect(await new ModelsClient(pi.transport, 'c2').list()).toEqual([CLAUDE]);
  });

  it('offers the whole list when its chat is not among the slots', async () => {
    const { transport } = transportWith([PI, CLAUDE], []);
    expect(await new ModelsClient(transport).list()).toEqual([PI, CLAUDE]);
  });
});
