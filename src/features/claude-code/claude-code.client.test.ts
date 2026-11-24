import { describe, expect, it, vi } from 'vitest';
import type { TransportClient } from '@core/transport/transport-client.ts';
import { ClaudeCodeClient } from './claude-code.client.ts';

function setup(result: unknown) {
  const call = vi.fn().mockResolvedValue(result);
  return { call, client: new ClaudeCodeClient({ call } as unknown as TransportClient) };
}

describe('ClaudeCodeClient', () => {
  it('reads claude.status, asking for a usage refresh only when told to', async () => {
    const status = { cli: 'ok', live: [] };
    const { call, client } = setup(status);
    expect(await client.status()).toBe(status);
    expect(call).toHaveBeenLastCalledWith('claude.status', { refreshUsage: false });
    await client.status(true);
    expect(call).toHaveBeenLastCalledWith('claude.status', { refreshUsage: true });
  });

  it('reads claude.sessions for a root, or for every project with null', async () => {
    const rows = [{ sessionId: 's', title: 't', lastModified: 1 }];
    const { call, client } = setup(rows);
    expect(await client.sessions('/work/alpha')).toBe(rows);
    expect(call).toHaveBeenLastCalledWith('claude.sessions', { root: '/work/alpha' });
    await client.sessions(null);
    expect(call).toHaveBeenLastCalledWith('claude.sessions', { root: null });
  });
});
