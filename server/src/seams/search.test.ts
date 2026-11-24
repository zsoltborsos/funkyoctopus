import { describe, expect, it, vi } from 'vitest';
import { MethodRegistry } from '../transport/registry.ts';
import type { ChatSearchResult } from '../../../src/shared/transport/protocol.ts';
import { registerSearchSeam } from './search.ts';

const RESULT: ChatSearchResult = { hits: [], total: 0, searched: 7 };

function setup() {
  const search = vi.fn((_query: string, _limit?: number) => Promise.resolve(RESULT));
  const registry = new MethodRegistry();
  registerSearchSeam(registry, { search });
  const call = (params: unknown): unknown => {
    const entry = registry.get('chat.search');
    if (!entry || entry.kind !== 'call') throw new Error('missing call chat.search');
    return entry.handler(params, { signal: new AbortController().signal });
  };
  return { search, call };
}

describe('chat.search', () => {
  it('is a call that needs no chat id and answers with what the search found', async () => {
    const { search, call } = setup();

    await expect(call({ query: 'deepseek' })).resolves.toBe(RESULT);

    expect(search).toHaveBeenCalledWith('deepseek', undefined);
  });

  it('trims the query and passes a limit on', async () => {
    const { search, call } = setup();

    await call({ query: '  tool   calls ', limit: 5 });

    expect(search).toHaveBeenCalledWith('tool   calls', 5);
  });

  it.each([undefined, null, 'deepseek', 4, [], {}, { query: 4 }, { query: '' }, { query: '   ' }, { query: null }])(
    'rejects %j without searching',
    (params) => {
      const { search, call } = setup();

      expect(() => call(params)).toThrow('chat.search requires { query: string } (not empty)');
      expect(search).not.toHaveBeenCalled();
    },
  );

  it.each(['5', 0, -3, 1.5, Number.NaN, null, Infinity, {}])('rejects the limit %j without searching', (limit) => {
    const { search, call } = setup();

    expect(() => call({ query: 'deepseek', limit })).toThrow('chat.search: limit must be a positive integer');
    expect(search).not.toHaveBeenCalled();
  });
});
