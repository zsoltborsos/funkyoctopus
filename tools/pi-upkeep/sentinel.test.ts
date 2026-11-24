import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SENTINEL_FILE, clearSentinel, createSentinel, sentinelPath, sentinelStatus } from './sentinel.ts';
import type { CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

function eexist(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: 'EEXIST' });
}

function makeFs(files: Record<string, string>, errors: Record<string, Error> = {}): Pick<CoordinationFsOps, 'readFile'> {
  return {
    readFile: (path: string) => {
      const forced = errors[path];
      if (forced) return Promise.reject(forced);
      const content = files[path];
      if (content === undefined) return Promise.reject(enoent(path));
      return Promise.resolve(content);
    },
  };
}

describe('sentinelPath', () => {
  it('lives directly in the state directory under a stable name', () => {
    expect(sentinelPath('/state/abc')).toBe(join('/state/abc', SENTINEL_FILE));
    expect(SENTINEL_FILE).toMatch(/^[a-z0-9.-]+$/);
  });
});

describe('sentinelStatus', () => {
  it('reports absent for ENOENT so a clean state proceeds', async () => {
    expect(await sentinelStatus('/state/abc', makeFs({}))).toBe('absent');
  });

  it('reports present when the sentinel file exists, even with empty content', async () => {
    expect(await sentinelStatus('/state/abc', makeFs({ [sentinelPath('/state/abc')]: '' }))).toBe('present');
    expect(
      await sentinelStatus('/state/abc', makeFs({ [sentinelPath('/state/abc')]: 'phase: mutate' })),
    ).toBe('present');
  });

  it('reports unreadable on any non-ENOENT error so ambiguity blocks the next promotion', async () => {
    const error = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(await sentinelStatus('/state/abc', makeFs({}, { [sentinelPath('/state/abc')]: error }))).toBe(
      'unreadable',
    );
  });
});

describe('createSentinel', () => {
  it('creates the sentinel exclusively and privately (flag wx, mode 0600)', async () => {
    const writes: { path: string; options: { mode?: number; flag?: string } }[] = [];
    const fs: Pick<CoordinationFsOps, 'writeFile'> = {
      writeFile: (path, _data, options) => {
        writes.push({ path, options });
        return Promise.resolve();
      },
    };
    expect(await createSentinel('/state/abc', fs, '{"transactionId":"tx-1"}')).toBe('created');
    expect(writes).toEqual([
      { path: sentinelPath('/state/abc'), options: { mode: 0o600, flag: 'wx' } },
    ]);
  });

  it('reports exists when the sentinel file already blocks', async () => {
    const fs: Pick<CoordinationFsOps, 'writeFile'> = {
      writeFile: (path, _data, options) =>
        options.flag === 'wx' ? Promise.reject(eexist(path)) : Promise.resolve(),
    };
    expect(await createSentinel('/state/abc', fs, 'x')).toBe('exists');
  });

  it('reports error on any other write failure', async () => {
    const fs: Pick<CoordinationFsOps, 'writeFile'> = {
      writeFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })),
    };
    expect(await createSentinel('/state/abc', fs, 'x')).toBe('error');
  });

  it('writes a real 0600 sentinel on the filesystem and clearSentinel removes it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-sentinel-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true });
    try {
      const path = sentinelPath(stateDir);
      const realFs = {
        readFile: (p: string): Promise<string> => readFile(p, 'utf8'),
        writeFile: (p: string, data: string, options: { mode?: number; flag?: string }) =>
          writeFile(p, data, options),
        unlink,
      };
      expect(await createSentinel(stateDir, realFs, '{"transactionId":"tx-1"}')).toBe('created');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await sentinelStatus(stateDir, realFs)).toBe('present');
      await clearSentinel(stateDir, realFs);
      expect(await sentinelStatus(stateDir, realFs)).toBe('absent');
      // Clearing an already-absent sentinel is a no-op, not an error.
      await clearSentinel(stateDir, realFs);
      expect(await sentinelStatus(stateDir, realFs)).toBe('absent');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('is tolerant of a missing file when clearing', async () => {
    const fs: Pick<CoordinationFsOps, 'unlink'> = {
      unlink: () => Promise.reject(enoent('/state/abc/transaction.sentinel')),
    };
    await expect(clearSentinel('/state/abc', fs)).resolves.toBeUndefined();
  });
});
