import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  defaultStateRoot,
  ensureStateDir,
  repositoryPathHash,
  repositoryStateDir,
  sha256Hex,
  stateDirFor,
  type CoordinationFsOps,
} from './state-path.ts';

describe('sha256Hex', () => {
  it('is deterministic and lowercase hex', () => {
    expect(sha256Hex('/repo')).toBe(sha256Hex('/repo'));
    expect(sha256Hex('/repo')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('repositoryPathHash', () => {
  it('is stable for the same canonical path', () => {
    expect(repositoryPathHash('/a/b/repo')).toBe(repositoryPathHash('/a/b/repo'));
  });

  it('distinct canonical paths produce distinct hashes', () => {
    expect(repositoryPathHash('/a/b/repo')).not.toBe(repositoryPathHash('/a/c/repo'));
  });

  it('defaults to the sha256 of the exact canonical path string', () => {
    expect(repositoryPathHash('/x/y')).toBe(sha256Hex('/x/y'));
  });
});

describe('defaultStateRoot', () => {
  it('prefers XDG_STATE_HOME when set', () => {
    expect(defaultStateRoot('/xdg/state', () => '/home/u')).toBe('/xdg/state');
  });

  it('falls back to ~/.local/state when XDG_STATE_HOME is unset', () => {
    expect(defaultStateRoot(undefined, () => '/home/u')).toBe('/home/u/.local/state');
  });

  it('falls back to ~/.local/state when XDG_STATE_HOME is empty (not a relative in-repo path)', () => {
    expect(defaultStateRoot('', () => '/home/u')).toBe('/home/u/.local/state');
    expect(isAbsolute(defaultStateRoot('', () => '/home/u'))).toBe(true);
  });
});

describe('stateDirFor', () => {
  it('places state under <stateRoot>/funkyoctopus/upkeep/<hash>', () => {
    expect(stateDirFor('/canonical/repo', '/state-root')).toBe(
      join('/state-root', 'funkyoctopus', 'upkeep', repositoryPathHash('/canonical/repo')),
    );
  });

  it('derives the same state dir for the same canonical path', () => {
    expect(stateDirFor('/same/repo', '/state')).toBe(stateDirFor('/same/repo', '/state'));
  });

  it('derives different state dirs for distinct repos under one state root', () => {
    expect(stateDirFor('/repo-a', '/state')).not.toBe(stateDirFor('/repo-b', '/state'));
  });
});

describe('repositoryStateDir', () => {
  const identity = (path: string): Promise<string> => Promise.resolve(path);

  it('hashes the canonical realpath: aliases of the same repo map to one state dir', async () => {
    const realpath = (path: string): Promise<string> =>
      Promise.resolve(path === '/elsewhere/alias' ? '/real/repo' : path);
    const viaReal = await repositoryStateDir('/real/repo', { fs: { realpath }, stateRoot: '/state' });
    const viaAlias = await repositoryStateDir('/elsewhere/alias', {
      fs: { realpath },
      stateRoot: '/state',
    });
    expect(viaAlias).toBe(viaReal);
  });

  it('distinct repos differ even under the same state root', async () => {
    const a = await repositoryStateDir('/repo-a', { fs: { realpath: identity }, stateRoot: '/state' });
    const b = await repositoryStateDir('/repo-b', { fs: { realpath: identity }, stateRoot: '/state' });
    expect(a).not.toBe(b);
  });
});

describe('ensureStateDir', () => {
  const realFs: Pick<CoordinationFsOps, 'mkdir' | 'chmod'> = {
    mkdir: (path, options) => mkdir(path, options),
    chmod: (path, mode) => chmod(path, mode),
  };

  it('creates the full state chain with private 0o700 permissions (real fs)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-state-path-'));
    const stateRoot = join(base, 'nested', 'state-root');
    const hash = repositoryPathHash('/canonical/repo');
    const stateDir = stateDirFor('/canonical/repo', stateRoot);
    expect(hash).toBeTruthy();
    await ensureStateDir(stateDir, realFs);
    const dirMode = (await stat(stateDir)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    // The intermediate funkyoctopus/upkeep chain exists too.
    const upkeepDir = join(stateRoot, 'funkyoctopus', 'upkeep');
    expect((await stat(upkeepDir)).mode & 0o777).toBe(0o700);
    await rm(base, { recursive: true, force: true });
  });

  it('tightens an existing 0o755 state leaf to 0o700 (real fs)', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-state-leaf-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o755 });
    await ensureStateDir(stateDir, realFs);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    await rm(base, { recursive: true, force: true });
  });
});
