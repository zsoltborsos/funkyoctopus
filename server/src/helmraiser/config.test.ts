import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnLike } from './cli.ts';

async function loadConfig() {
  vi.resetModules();
  return (await import('../config.ts')).config;
}

beforeEach(() => {
  for (const key of ['HELMRAISER_BIN', 'HELMRAISER_DATA_DIR']) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Helmraiser configuration', () => {
  it('defaults to the helmraiser binary and ~/.helmraiser run store without accessing either', async () => {
    const config = await loadConfig();
    expect(config.helmraiserBin).toBe('helmraiser');
    expect(config.helmraiserDataDir).toBe(resolve(homedir(), '.helmraiser'));
  });

  it.each([undefined, '/opt/helmraiser cli'])(
    'runs the configured binary (%s) through the CLI runner', async (bin) => {
      vi.stubEnv('HELMRAISER_BIN', bin);
      await loadConfig();
      const { runHelmraiserJson } = await import('./cli.ts');
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
      });
      const spawn = vi.fn(() => child);
      const pending = runHelmraiserJson(['status', '--json'], { spawnFn: spawn as unknown as SpawnLike });
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0);
      await expect(pending).resolves.toEqual({});
      expect(spawn).toHaveBeenCalledExactlyOnceWith(bin ?? 'helmraiser', ['status', '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  );

  it('takes HELMRAISER_BIN verbatim', async () => {
    vi.stubEnv('HELMRAISER_BIN', '/opt/helmraiser cli');
    expect((await loadConfig()).helmraiserBin).toBe('/opt/helmraiser cli');
  });

  it('resolves HELMRAISER_DATA_DIR', async () => {
    vi.stubEnv('HELMRAISER_DATA_DIR', 'local-helmraiser');
    expect((await loadConfig()).helmraiserDataDir).toBe(resolve('local-helmraiser'));
  });
});
