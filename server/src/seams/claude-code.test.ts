import { describe, expect, it, vi } from 'vitest';
import { MethodRegistry } from '../transport/registry.ts';
import type { ClaudeCodeStatus } from '../claude-code/status.ts';
import { registerClaudeCodeSeam } from './claude-code.ts';

function setup() {
  const claude = {
    status: vi.fn(() => Promise.resolve({ cli: 'ok' as const, live: [] })),
    recent: vi.fn(() => Promise.resolve([])),
  };
  const registry = new MethodRegistry();
  registerClaudeCodeSeam(registry, claude as unknown as ClaudeCodeStatus);
  const call = (name: string, params: unknown) => {
    const entry = registry.get(name);
    if (!entry || entry.kind !== 'call') throw new Error(`missing call ${name}`);
    return Promise.resolve().then(() => entry.handler(params, { signal: new AbortController().signal }));
  };
  return { claude, registry, call };
}

describe('claude-code seam', () => {
  it('registers the two read-only calls', () => {
    expect(setup().registry.names()).toEqual(['claude.status', 'claude.sessions']);
  });

  it('serves claude.status, passing the refresh request through', async () => {
    const { claude, call } = setup();
    await expect(call('claude.status', undefined)).resolves.toEqual({ cli: 'ok', live: [] });
    expect(claude.status).toHaveBeenLastCalledWith(false);
    await call('claude.status', {});
    expect(claude.status).toHaveBeenLastCalledWith(false);
    await call('claude.status', { refreshUsage: true });
    expect(claude.status).toHaveBeenLastCalledWith(true);
  });

  it('rejects a claude.status refresh flag that is not a boolean', async () => {
    const { claude, call } = setup();
    await expect(call('claude.status', { refreshUsage: 'yes' })).rejects.toThrow('claude.status');
    expect(claude.status).not.toHaveBeenCalled();
  });

  it('serves claude.sessions for a root or for every project', async () => {
    const { claude, call } = setup();
    await call('claude.sessions', { root: '/home/example/projects/alpha' });
    expect(claude.recent).toHaveBeenLastCalledWith('/home/example/projects/alpha');
    await call('claude.sessions', { root: null });
    expect(claude.recent).toHaveBeenLastCalledWith(null);
  });

  it.each([undefined, {}, { root: 5 }, { root: '' }, 'path'])('rejects claude.sessions params %j', async (params) => {
    const { claude, call } = setup();
    await expect(call('claude.sessions', params)).rejects.toThrow('claude.sessions requires { root: string | null }');
    expect(claude.recent).not.toHaveBeenCalled();
  });
});
