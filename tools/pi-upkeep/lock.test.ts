import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile as fsReadFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INCOMPLETE_CLAIM_GRACE_MS,
  LOCK_DIR,
  RepositoryLock,
  ownerFileName,
  pendingFileFor,
  probeProcess,
  type AcquireOutcome,
  type HeldLock,
  type LockDeps,
  type LockOwner,
  type ProcessStatus,
} from './lock.ts';
import type { CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';
import { CoordinationFakeFs } from './test/fake-fs.ts';

function enotempty(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`), { code: 'ENOTEMPTY' });
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
}

function eexist(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EEXIST: file already exists, mkdir '${path}'`), { code: 'EEXIST' });
}

/** Lock-specific timing and operation faults layered on the shared coordination fake. */
class FakeFs extends CoordinationFakeFs {
  protected override readonly renameNeedsDestinationDir = true;
  readonly rmdirErrors = new Map<string, Error>();
  readonly chmodModes = new Map<string, number>();
  readonly statErrors = new Map<string, Error>();
  readonly mtimes = new Map<string, number>();
  mkdirImpl: ((path: string) => Promise<void>) | undefined;

  override mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<unknown> {
    this.events.push(`mkdir ${path}`);
    const forced = this.mkdirErrors.get(path);
    if (forced) return Promise.reject(forced);
    if (this.mkdirImpl) {
      return this.mkdirImpl(path).then(() => {
        this.dirs.add(path);
      });
    }
    if (options.recursive) {
      const parts = path.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        const ancestor = parts.slice(0, index).join('/');
        if (ancestor) this.dirs.add(ancestor);
      }
    } else {
      this.dirs.add(path);
    }
    return Promise.resolve();
  }

  override rename(oldPath: string, newPath: string): Promise<void> {
    this.events.push(`rename ${oldPath} -> ${newPath}`);
    const forced = this.renameErrors.get(newPath);
    if (forced) return Promise.reject(forced);
    const data = this.files.get(oldPath);
    if (data === undefined) return Promise.reject(enoent(oldPath));
    const destDir = newPath.slice(0, newPath.lastIndexOf('/'));
    if (!this.dirs.has(destDir)) return Promise.reject(enoent(newPath));
    this.files.delete(oldPath);
    this.files.set(newPath, data);
    return Promise.resolve();
  }

  override rmdir(path: string): Promise<void> {
    this.events.push(`rmdir ${path}`);
    const forced = this.rmdirErrors.get(path);
    if (forced) return Promise.reject(forced);
    if (!this.dirs.has(path)) return Promise.reject(enoent(path));
    if ([...this.files.keys()].some((key) => key.startsWith(`${path}/`))) {
      return Promise.reject(enotempty(path));
    }
    this.dirs.delete(path);
    return Promise.resolve();
  }

  override chmod(path: string, mode: number): Promise<void> {
    this.events.push(`chmod ${path}`);
    this.chmodModes.set(path, mode);
    return Promise.resolve();
  }

  override stat(path: string): Promise<{ mtimeMs: number }> {
    this.events.push(`stat ${path}`);
    const forced = this.statErrors.get(path);
    if (forced) return Promise.reject(forced);
    if (!this.dirs.has(path) && !this.files.has(path)) return Promise.reject(enoent(path));
    return Promise.resolve({ mtimeMs: this.mtimes.get(path) ?? 1_000 });
  }
}

function owner(pid: number, instance: string): LockOwner {
  return { pid, host: 'test-host', startedAt: 1_000, instance };
}

function makeDeps(fs: FakeFs, overrides: Partial<LockDeps> = {}): LockDeps {
  return {
    fs,
    pid: overrides.pid ?? 123,
    host: overrides.host ?? 'test-host',
    probe: overrides.probe ?? (() => 'dead'),
    now: overrides.now ?? (() => 1_000),
    randomId: overrides.randomId ?? (() => 'inst-1'),
  };
}

/** Path of the unique token-bearing owner file for one acquisition instance. */
function ownerPath(stateDir: string, instance: string): string {
  return join(stateDir, LOCK_DIR, ownerFileName(instance));
}

const LOCK_DIR_PATH = join('/state', LOCK_DIR);
/** Own pending file path for the default test instance (inst-1). */
const PENDING_INST_1 = pendingFileFor('/state', 'inst-1');
const removalEvents = (fs: FakeFs): string[] =>
  fs.events.filter((event) => event.startsWith('unlink ') || event.startsWith('rmdir '));

describe('RepositoryLock.acquire', () => {
  it('acquires an absent lock atomically and records owner metadata', async () => {
    const fs = new FakeFs();
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    expect(outcome.lock.owner).toEqual({ pid: 123, host: 'test-host', startedAt: 1_000, instance: 'inst-1' });
    // Owner metadata lives under a unique token-bearing filename.
    const meta = fs.files.get(ownerPath('/state', 'inst-1'));
    expect(meta).toBeTruthy();
    const parsed = JSON.parse(meta ?? '{}') as LockOwner;
    expect(parsed).toMatchObject({ pid: 123, host: 'test-host', startedAt: 1_000, instance: 'inst-1' });
    // The lock directory itself was created atomically by a plain mkdir.
    const mkdirEvent = fs.events.find((event) => event === 'mkdir /state/lock');
    expect(mkdirEvent).toBeTruthy();
  });

  it('refuses while the recorded owner is alive and never removes the lock', async () => {
    const fs = new FakeFs();
    fs.files.set(ownerPath('/state', 'other-instance'), JSON.stringify(owner(4242, 'other-instance')));
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs, { probe: (pid) => (pid === 4242 ? 'alive' : 'dead') }));
    const outcome = await lock.acquire();
    expect(outcome).toEqual({
      kind: 'contended',
      reason: expect.stringContaining('4242'),
    });
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.get(ownerPath('/state', 'other-instance'))).toBeTruthy();
  });

  it('refuses when the lock has no readable owner metadata (empty lock dir)', async () => {
    const fs = new FakeFs();
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/owner metadata/i);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
  });

  it('refuses when the recorded owner pid is not a valid positive integer', async () => {
    const fs = new FakeFs();
    fs.files.set(
      ownerPath('/state', 'i'),
      JSON.stringify({ pid: 'not-a-pid', host: 'x', startedAt: 1, instance: 'i' }),
    );
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
  });

  it('refuses when the owner liveness is ambiguous', async () => {
    const fs = new FakeFs();
    fs.files.set(ownerPath('/state', 'i'), JSON.stringify(owner(777, 'i')));
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock(
      '/state',
      makeDeps(fs, { probe: (pid) => (pid === 777 ? 'ambiguous' : 'dead') }),
    );
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
  });

  it('recovers a stale lock whose owner pid is positively dead, then acquires', async () => {
    const fs = new FakeFs();
    const stale = ownerPath('/state', 'stale-instance');
    fs.files.set(stale, JSON.stringify(owner(999, 'stale-instance')));
    fs.dirs.add('/state/lock');
    // mkdir fails while the stale lock exists, succeeds once it is removed.
    fs.mkdirImpl = (path) => {
      if (path === '/state/lock') {
        if (fs.dirs.has('/state/lock') || fs.files.has(stale)) return Promise.reject(eexist(path));
        fs.dirs.add(path);
      }
      return Promise.resolve();
    };
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    expect(outcome.lock.owner.instance).toBe('inst-1');
    // The stale owner file was unlinked and the empty lock dir removed exactly
    // once each, then the lock was re-created under a fresh token filename.
    expect(removalEvents(fs)).toEqual([`unlink ${stale}`, 'rmdir /state/lock']);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-1')) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-1',
    });
  });

  it('refuses when a competitor wins the lock during stale recovery', async () => {
    const fs = new FakeFs();
    const stale = ownerPath('/state', 'stale-instance');
    fs.files.set(stale, JSON.stringify(owner(999, 'stale-instance')));
    fs.dirs.add('/state/lock');
    let lockMkdirs = 0;
    fs.mkdirImpl = (path) => {
      if (path !== '/state/lock') return Promise.resolve();
      lockMkdirs += 1;
      if (lockMkdirs === 1) {
        return Promise.reject(eexist(path)); // stale lock present
      }
      // A competitor claimed the lock between our stale removal and retry.
      fs.files.set(ownerPath('/state', 'competitor'), JSON.stringify(owner(555, 'competitor')));
      fs.dirs.add('/state/lock');
      return Promise.reject(eexist(path));
    };
    const lock = new RepositoryLock('/state', makeDeps(fs, { probe: (pid) => (pid === 555 ? 'alive' : 'dead') }));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/555/);
    // The stale owner file was unlinked and the empty lock dir removed, but
    // the competitor's replacement lock was left alone; this acquisition then
    // gave up and removed its own pending file.
    expect(removalEvents(fs)).toEqual([`unlink ${stale}`, 'rmdir /state/lock', `unlink ${PENDING_INST_1}`]);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'competitor')) ?? '{}') as LockOwner).toMatchObject({
      pid: 555,
      instance: 'competitor',
    });
  });

  it('cleans up its own pending file when owner metadata cannot be staged', async () => {
    const fs = new FakeFs();
    const pending = pendingFileFor('/state', 'inst-1');
    fs.writeErrors.set(pending, new Error('disk full'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('disk full') });
    // Nothing was claimed: only the own pending file is unlinked, no lock dir
    // was ever created, so no owner-less lock is left behind.
    expect(removalEvents(fs)).toEqual([`unlink ${pending}`]);
    expect(fs.dirs.has('/state/lock')).toBe(false);
  });

  it('cleans up its own claim when the publish rename fails', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'inst-1');
    const pending = pendingFileFor('/state', 'inst-1');
    fs.renameErrors.set(token, Object.assign(new Error('EIO: input/output error'), { code: 'EIO' }));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome).toEqual({ kind: 'error', message: expect.stringContaining('EIO') });
    // The own pending file and the never-published token are unlinked and the
    // freshly created empty lock dir is removed — nothing else.
    expect(removalEvents(fs)).toEqual([`unlink ${pending}`, `unlink ${token}`, 'rmdir /state/lock']);
    expect(fs.dirs.has('/state/lock')).toBe(false);
  });
});

describe('RepositoryLock.release', () => {
  async function acquire(fs: FakeFs, pid = 123): Promise<HeldLock> {
    const lock = new RepositoryLock('/state', makeDeps(fs, { pid }));
    const outcome = await lock.acquire();
    if (outcome.kind !== 'acquired') throw new Error('expected acquisition');
    return outcome.lock;
  }

  it('removes the lock only when the owner token filename matches this instance', async () => {
    const fs = new FakeFs();
    const held = await acquire(fs);
    expect(await held.release()).toBe('released');
    expect(removalEvents(fs)).toEqual(['unlink /state/lock/owner-inst-1.json', 'rmdir /state/lock']);
    expect(fs.files.get(ownerPath('/state', 'inst-1'))).toBeUndefined();
  });

  it('never removes a lock that was re-created with a newer instance token', async () => {
    const fs = new FakeFs();
    const held = await acquire(fs);
    // The lock was replaced by a re-acquisition after stale recovery: same
    // process pid, but a fresh instance token under a new filename.
    fs.files.delete(ownerPath('/state', 'inst-1'));
    fs.files.set(ownerPath('/state', 'inst-2'), JSON.stringify(owner(123, 'inst-2')));
    expect(await held.release()).toBe('not_owned');
    // Only the attempted unlink of the old token path is logged — it misses
    // (ENOENT) and the re-created lock is untouched.
    expect(removalEvents(fs)).toEqual(['unlink /state/lock/owner-inst-1.json']);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-2')) ?? '{}') as LockOwner).toMatchObject({
      instance: 'inst-2',
    });
  });

  it('never removes a lock owned by another process', async () => {
    const fs = new FakeFs();
    const held = await acquire(fs);
    fs.files.delete(ownerPath('/state', 'inst-1'));
    fs.files.set(ownerPath('/state', 'other-process'), JSON.stringify(owner(999, 'other-process')));
    expect(await held.release()).toBe('not_owned');
    // Only the attempted unlink of the old token path is logged — it misses
    // (ENOENT) and the other process's lock is untouched.
    expect(removalEvents(fs)).toEqual(['unlink /state/lock/owner-inst-1.json']);
  });

  it('is a no-op when the lock directory is already gone', async () => {
    const fs = new FakeFs();
    const held = await acquire(fs);
    expect(await held.release()).toBe('released');
    expect(await held.release()).toBe('not_owned');
  });
});

describe('RepositoryLock stale-reclamation race and release safety (regressions)', () => {
  async function acquire(fs: FakeFs, pid = 123): Promise<HeldLock> {
    const lock = new RepositoryLock('/state', makeDeps(fs, { pid }));
    const outcome = await lock.acquire();
    if (outcome.kind !== 'acquired') throw new Error('expected acquisition');
    return outcome.lock;
  }

  /** Stale-lock fixture: one dead owner entry in an existing lock directory. */
  function staleLock(fs: FakeFs, instance = 'stale-instance'): string {
    const stale = ownerPath('/state', instance);
    fs.files.set(stale, JSON.stringify(owner(999, instance)));
    fs.dirs.add('/state/lock');
    return stale;
  }

  /** mkdir fails while the stale lock exists, then creates atomically. */
  function staleAwareMkdir(fs: FakeFs, stale: string): void {
    fs.mkdirImpl = (path) => {
      if (path === '/state/lock') {
        if (fs.dirs.has('/state/lock') || fs.files.has(stale)) {
          return Promise.reject(eexist(path));
        }
        fs.dirs.add(path);
      }
      return Promise.resolve();
    };
  }

  it('two simultaneous stale recoverers: at most one acquires and the winner lock survives', async () => {
    const fs = new FakeFs();
    const stale = staleLock(fs);
    staleAwareMkdir(fs, stale);
    const probe = (pid: number): ProcessStatus => (pid === 999 ? 'dead' : 'alive');
    const lockA = new RepositoryLock(
      '/state',
      makeDeps(fs, { pid: 123, randomId: () => 'inst-a', probe }),
    );
    const lockB = new RepositoryLock(
      '/state',
      makeDeps(fs, { pid: 456, randomId: () => 'inst-b', probe }),
    );
    const outcomes = await Promise.all([lockA.acquire(), lockB.acquire()]);
    const acquired = outcomes.filter(
      (outcome): outcome is Extract<AcquireOutcome, { kind: 'acquired' }> => outcome.kind === 'acquired',
    );
    expect(acquired).toHaveLength(1);
    // Exactly one token-bearing owner file remains, owned by the winner.
    const ownerFiles = [...fs.files.keys()].filter((key) => key.startsWith(`${LOCK_DIR_PATH}/`));
    expect(ownerFiles).toHaveLength(1);
    const surviving = JSON.parse(fs.files.get(ownerFiles[0]!) ?? '{}') as LockOwner;
    expect(surviving.instance).toBe(acquired[0]!.lock.owner.instance);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('B resumes removal of an old stale token after A reclaimed: A keeps the lock, B does not acquire', async () => {
    const fs = new FakeFs();
    const stale = staleLock(fs);
    staleAwareMkdir(fs, stale);
    // Hold B's removal of the old stale token until A has fully reclaimed.
    let bUnlinkCalled!: () => void;
    const bUnlinkCalledPromise = new Promise<void>((resolve) => {
      bUnlinkCalled = resolve;
    });
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let unlinkCount = 0;
    const originalUnlink = fs.unlink.bind(fs);
    fs.unlink = (path) => {
      if (path === stale) {
        unlinkCount += 1;
        if (unlinkCount === 1) {
          bUnlinkCalled();
          return gateB.then(() => originalUnlink(path));
        }
      }
      return originalUnlink(path);
    };
    const probe = (pid: number): ProcessStatus => (pid === 999 ? 'dead' : 'alive');
    const lockB = new RepositoryLock(
      '/state',
      makeDeps(fs, { pid: 456, randomId: () => 'inst-b', probe }),
    );
    const bPending = lockB.acquire();
    // B validated the old stale token and is blocked at its removal.
    await bUnlinkCalledPromise;
    // A fully reclaims the stale lock and writes its own fresh token.
    const lockA = new RepositoryLock(
      '/state',
      makeDeps(fs, { pid: 123, randomId: () => 'inst-a', probe }),
    );
    const aOutcome = await lockA.acquire();
    expect(aOutcome.kind).toBe('acquired');
    // B resumes removal of the old token path — it is gone, so ENOENT refuses
    // the reclaim without touching or claiming A's new lock.
    releaseB();
    const bOutcome = await bPending;
    expect(bOutcome.kind).not.toBe('acquired');
    // A's new-token owner file and lock directory remain intact.
    const aOwner = ownerPath('/state', 'inst-a');
    expect(fs.files.get(aOwner)).toContain('inst-a');
    expect(fs.dirs.has('/state/lock')).toBe(true);
    // The old stale token is gone; no stale token lingers.
    expect(fs.files.has(stale)).toBe(false);
  });

  it('unlinking the old token path after a competitor replaced the directory never touches the new lock', async () => {
    const fs = new FakeFs();
    const stale = staleLock(fs);
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    let removalStarted!: () => void;
    const removalStartedPromise = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    let releaseRemoval!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let unlinkCount = 0;
    const originalUnlink = fs.unlink.bind(fs);
    fs.unlink = (path) => {
      if (path === stale) {
        unlinkCount += 1;
        if (unlinkCount === 1) {
          removalStarted();
          return gate.then(() => originalUnlink(path));
        }
      }
      return originalUnlink(path);
    };
    const lock = new RepositoryLock(
      '/state',
      makeDeps(fs, { probe: (pid) => (pid === 555 ? 'alive' : 'dead') }),
    );
    const pending = lock.acquire();
    // The recoverer judged the stale token stale and started its removal.
    await removalStartedPromise;
    // A competitor removes the whole directory and re-creates it with a new
    // token file before the recoverer's unlink executes.
    fs.files.delete(stale);
    fs.dirs.delete('/state/lock');
    fs.dirs.add('/state/lock');
    fs.files.set(
      ownerPath('/state', 'competitor-instance'),
      JSON.stringify(owner(555, 'competitor-instance')),
    );
    releaseRemoval();
    const outcome = await pending;
    expect(outcome.kind).toBe('contended');
    // The competitor's new lock is untouched and still owns the directory.
    expect(fs.files.get(ownerPath('/state', 'competitor-instance'))).toContain('competitor-instance');
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('refuses without deleting when the single owner entry is malformed', async () => {
    const fs = new FakeFs();
    const stale = ownerPath('/state', 'stale-instance');
    fs.files.set(stale, 'not-json{{');
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(fs.files.has(stale)).toBe(true);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
  });

  it('refuses without deleting when the lock directory holds a non-owner entry', async () => {
    const fs = new FakeFs();
    const stale = ownerPath('/state', 'stale-instance');
    fs.files.set(stale, JSON.stringify(owner(999, 'stale-instance')));
    fs.mtimes.set(stale, 0); // an old dead owner, reclaimable on its own
    fs.files.set(join('/state/lock', 'stray.json'), JSON.stringify({ kind: 'not-an-owner' }));
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/stray\.json/);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(stale)).toBe(true);
  });

  it('never recursively deletes a lock directory that is not empty', async () => {
    const fs = new FakeFs();
    const held = await acquire(fs);
    const foreign = join('/state/lock', 'foreign-file');
    fs.files.set(foreign, 'not ours');
    expect(await held.release()).toBe('not_owned');
    // Our owner file is gone, but the foreign content survived the release.
    expect(fs.files.get(foreign)).toBe('not ours');
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('release fails closed when the owner file cannot be unlinked', async () => {
    const fs = new FakeFs();
    const held = await acquire(fs);
    fs.unlinkErrors.set(
      ownerPath('/state', 'inst-1'),
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );
    expect(await held.release()).toBe('not_owned');
    expect(fs.files.has(ownerPath('/state', 'inst-1'))).toBe(true);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });
});

describe('RepositoryLock incomplete-claim grace reclamation', () => {
  /** Mkdir fails while the lock dir exists; succeeds once it is removed. */
  function reclaimingMkdir(fs: FakeFs): void {
    fs.mkdirImpl = (path) => {
      if (path === '/state/lock') {
        if (fs.dirs.has('/state/lock')) return Promise.reject(eexist(path));
        fs.dirs.add(path);
      }
      return Promise.resolve();
    };
  }

  /** Old abandoned empty lock dir: the crash-between-mkdir-and-write window. */
  function abandonedEmptyDir(fs: FakeFs): void {
    fs.dirs.add('/state/lock');
    // mtime well before the fake clock (1_000): age >= INCOMPLETE_CLAIM_GRACE_MS.
    fs.mtimes.set('/state/lock', 0);
    reclaimingMkdir(fs);
  }

  it('reclaims an old empty lock directory (crash between mkdir and owner write)', async () => {
    const fs = new FakeFs();
    abandonedEmptyDir(fs);
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    // The abandoned empty dir is removed by a plain rmdir (no unlink, no
    // recursion), then the lock is re-created under a fresh token filename.
    expect(removalEvents(fs)).toEqual(['rmdir /state/lock']);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-1')) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-1',
    });
  });

  it('refuses a fresh empty lock directory (a live claim still mid-write)', async () => {
    const fs = new FakeFs();
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/owner metadata/i);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('reclaims an old malformed single owner token (crash mid-write)', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'abandoned');
    fs.files.set(token, '{"pid": 99'); // truncated JSON
    fs.mtimes.set(token, 0);
    fs.dirs.add('/state/lock');
    reclaimingMkdir(fs);
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    // The exact abandoned token was unlinked and the now-empty dir removed.
    expect(removalEvents(fs)).toEqual([`unlink ${token}`, 'rmdir /state/lock']);
    expect(fs.files.has(token)).toBe(false);
  });

  it('reclaims an old unreadable single owner token', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'abandoned');
    fs.files.set(token, 'should not matter');
    fs.readErrors.set(token, new Error('EACCES: permission denied'));
    fs.mtimes.set(token, 0);
    fs.dirs.add('/state/lock');
    reclaimingMkdir(fs);
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    expect(removalEvents(fs)).toEqual([`unlink ${token}`, 'rmdir /state/lock']);
  });

  it('reclaims an old single owner token with an invalid pid (never a valid owner)', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'abandoned');
    fs.files.set(token, JSON.stringify({ pid: 'not-a-pid', host: 'x', startedAt: 1, instance: 'abandoned' }));
    fs.mtimes.set(token, 0);
    fs.dirs.add('/state/lock');
    reclaimingMkdir(fs);
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    expect(removalEvents(fs)).toEqual([`unlink ${token}`, 'rmdir /state/lock']);
  });

  it('refuses a fresh unreadable single owner token (a live claim still mid-write)', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'fresh');
    fs.files.set(token, 'partial');
    fs.readErrors.set(token, new Error('EACCES: permission denied'));
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(token)).toBe(true);
  });

  it('A paused after mkdir beyond grace: B reclaims and acquires; A resumes and backs off without damaging B', async () => {
    const fs = new FakeFs();
    const aToken = ownerPath('/state', 'inst-a');
    const bToken = ownerPath('/state', 'inst-b');
    const aPending = pendingFileFor('/state', 'inst-a');
    // A's publish rename is held open after its atomic mkdir until B acquired.
    let aRenameStarted!: () => void;
    const aRenameStartedPromise = new Promise<void>((resolve) => (aRenameStarted = resolve));
    let releaseARename!: () => void;
    const aRenameGate = new Promise<void>((resolve) => (releaseARename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === aToken) {
        aRenameStarted();
        return aRenameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    const lockA = new RepositoryLock('/state', makeDeps(fs, { pid: 123, randomId: () => 'inst-a' }));
    const aPendingAcquire = lockA.acquire();
    // A atomically created the empty lock dir and is paused before publishing.
    await aRenameStartedPromise;
    // The lock directory must never expose partial owner JSON: while A is
    // paused it holds no entry at all — its complete metadata sits in the
    // pending file outside lockDir.
    expect([...fs.files.keys()].some((key) => key.startsWith(`${LOCK_DIR_PATH}/`))).toBe(false);
    expect(fs.files.get(aPending)).toContain('inst-a');
    // A stays paused far beyond the grace period, so the empty dir ages.
    fs.mtimes.set('/state/lock', 0);
    reclaimingMkdir(fs);
    const lockB = new RepositoryLock('/state', makeDeps(fs, { pid: 456, randomId: () => 'inst-b' }));
    const bOutcome = await lockB.acquire();
    expect(bOutcome.kind).toBe('acquired');
    // A resumes: its rename lands in B's directory (a second unique token) and
    // the post-publication verification fails; A removes only its own token
    // and never B's directory or owner.
    releaseARename();
    const aOutcome = await aPendingAcquire;
    expect(aOutcome.kind).not.toBe('acquired');
    expect(removalEvents(fs)).toEqual(['rmdir /state/lock', `unlink ${aToken}`]);
    expect(JSON.parse(fs.files.get(bToken) ?? '{}') as LockOwner).toMatchObject({
      pid: 456,
      instance: 'inst-b',
    });
    expect(fs.files.has(aPending)).toBe(false); // consumed by the rename
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('A paused after mkdir, B reclaims and re-creates; A publishes before B: at most one holder, loser backs off', async () => {
    const fs = new FakeFs();
    const aToken = ownerPath('/state', 'inst-a');
    const bToken = ownerPath('/state', 'inst-b');
    let aRenameStarted!: () => void;
    const aRenameStartedPromise = new Promise<void>((resolve) => (aRenameStarted = resolve));
    let releaseARename!: () => void;
    const aRenameGate = new Promise<void>((resolve) => (releaseARename = resolve));
    let bRenameStarted!: () => void;
    const bRenameStartedPromise = new Promise<void>((resolve) => (bRenameStarted = resolve));
    let releaseBRename!: () => void;
    const bRenameGate = new Promise<void>((resolve) => (releaseBRename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === aToken) {
        aRenameStarted();
        return aRenameGate.then(() => originalRename(oldPath, newPath));
      }
      if (newPath === bToken) {
        bRenameStarted();
        return bRenameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    const lockA = new RepositoryLock('/state', makeDeps(fs, { pid: 123, randomId: () => 'inst-a' }));
    const aPending = lockA.acquire();
    await aRenameStartedPromise;
    fs.mtimes.set('/state/lock', 0);
    reclaimingMkdir(fs);
    const lockB = new RepositoryLock('/state', makeDeps(fs, { pid: 456, randomId: () => 'inst-b' }));
    const bPending = lockB.acquire();
    // B reclaimed the empty dir, re-created it, and is paused before publishing.
    await bRenameStartedPromise;
    // A publishes first into B's re-created directory and verifies sole
    // ownership — A holds the lock B had just claimed.
    releaseARename();
    const aOutcome = await aPending;
    expect(aOutcome.kind).toBe('acquired');
    // B publishes second: two unique tokens exist, B's post-publication
    // verification fails, and B removes only its own token.
    releaseBRename();
    const bOutcome = await bPending;
    expect(bOutcome.kind).not.toBe('acquired');
    expect(removalEvents(fs)).toEqual(['rmdir /state/lock', `unlink ${bToken}`]);
    expect(JSON.parse(fs.files.get(aToken) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-a',
    });
    expect(fs.files.has(bToken)).toBe(false);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('A publishes while B\'s empty-dir reclaim rmdir is in flight: B\'s rmdir fails ENOTEMPTY and B refuses; A holds', async () => {
    const fs = new FakeFs();
    const aToken = ownerPath('/state', 'inst-a');
    let aRenameStarted!: () => void;
    const aRenameStartedPromise = new Promise<void>((resolve) => (aRenameStarted = resolve));
    let releaseARename!: () => void;
    const aRenameGate = new Promise<void>((resolve) => (releaseARename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === aToken) {
        aRenameStarted();
        return aRenameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    const lockA = new RepositoryLock('/state', makeDeps(fs, { pid: 123, randomId: () => 'inst-a' }));
    const aPending = lockA.acquire();
    await aRenameStartedPromise;
    fs.mtimes.set('/state/lock', 0);
    // Hold B's rmdir open after it judged the dir empty and abandoned.
    let bRmdirStarted!: () => void;
    const bRmdirStartedPromise = new Promise<void>((resolve) => (bRmdirStarted = resolve));
    let releaseBRmdir!: () => void;
    const bRmdirGate = new Promise<void>((resolve) => (releaseBRmdir = resolve));
    const originalRmdir = fs.rmdir.bind(fs);
    fs.rmdir = (path) => {
      if (path === '/state/lock') {
        bRmdirStarted();
        return bRmdirGate.then(() => originalRmdir(path));
      }
      return originalRmdir(path);
    };
    const lockB = new RepositoryLock('/state', makeDeps(fs, { pid: 456, randomId: () => 'inst-b' }));
    const bPending = lockB.acquire();
    // B's mkdir fails while the dir exists, so B goes through the empty-claim
    // reclamation and reaches its rmdir.
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    await bRmdirStartedPromise;
    // A publishes into the (still empty) directory and verifies sole ownership.
    releaseARename();
    const aOutcome = await aPending;
    expect(aOutcome.kind).toBe('acquired');
    // B's rmdir now runs: the directory holds A's token, so it fails ENOTEMPTY
    // and B refuses instead of destroying A's lock.
    releaseBRmdir();
    const bOutcome = await bPending;
    expect(bOutcome.kind).toBe('contended');
    expect(JSON.parse(fs.files.get(aToken) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-a',
    });
    expect(fs.files.has(ownerPath('/state', 'inst-b'))).toBe(false);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('A\'s publish rename misses a reclaimed directory (ENOENT): A retries and only one holder emerges', async () => {
    const fs = new FakeFs();
    const aToken = ownerPath('/state', 'inst-a');
    let aRenameStarted!: () => void;
    const aRenameStartedPromise = new Promise<void>((resolve) => (aRenameStarted = resolve));
    let releaseARename!: () => void;
    const aRenameGate = new Promise<void>((resolve) => (releaseARename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === aToken) {
        aRenameStarted();
        return aRenameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    // B's mkdir calls: #1 sees A's dir (EEXIST), #2 re-creates after the
    // reclaim and is held open; later calls behave normally.
    let mkdirCalls = 0;
    let bMkdirGateStarted!: () => void;
    const bMkdirGateStartedPromise = new Promise<void>((resolve) => (bMkdirGateStarted = resolve));
    let releaseBMkdir!: () => void;
    const bMkdirGate = new Promise<void>((resolve) => (releaseBMkdir = resolve));
    fs.mkdirImpl = (path) => {
      if (path !== '/state/lock') return Promise.resolve();
      mkdirCalls += 1;
      if (mkdirCalls === 1) {
        fs.dirs.add(path);
        return Promise.resolve();
      }
      if (mkdirCalls === 2) return Promise.reject(eexist(path));
      if (mkdirCalls === 3) {
        bMkdirGateStarted();
        return bMkdirGate.then(() => void fs.dirs.add(path));
      }
      if (fs.dirs.has(path)) return Promise.reject(eexist(path));
      fs.dirs.add(path);
      return Promise.resolve();
    };
    const lockA = new RepositoryLock('/state', makeDeps(fs, { pid: 123, randomId: () => 'inst-a' }));
    const aPending = lockA.acquire();
    await aRenameStartedPromise;
    fs.mtimes.set('/state/lock', 0);
    const lockB = new RepositoryLock('/state', makeDeps(fs, { pid: 456, randomId: () => 'inst-b' }));
    const bPending = lockB.acquire();
    // B judged the empty dir abandoned, rmdir'd it, and is now paused before
    // re-creating it — the directory is momentarily gone.
    await bMkdirGateStartedPromise;
    // A's paused rename now runs into the vanished directory: ENOENT. A keeps
    // its staged pending file and retries.
    releaseARename();
    // A's retry re-creates the directory and publishes while B is still paused.
    const aOutcome = await aPending;
    // B resumes its mkdir: the directory now belongs to A, so B contends and
    // refuses against A's live valid owner.
    releaseBMkdir();
    const bOutcome = await bPending;
    const acquired = [aOutcome, bOutcome].filter(
      (outcome): outcome is Extract<AcquireOutcome, { kind: 'acquired' }> => outcome.kind === 'acquired',
    );
    expect(acquired).toHaveLength(1);
    expect(fs.dirs.has('/state/lock')).toBe(true);
    // Exactly one token survives and it belongs to the acquirer.
    const ownerFiles = [...fs.files.keys()].filter((key) => key.startsWith(`${LOCK_DIR_PATH}/`));
    expect(ownerFiles).toHaveLength(1);
    const surviving = JSON.parse(fs.files.get(ownerFiles[0]!) ?? '{}') as LockOwner;
    expect(surviving.instance).toBe(acquired[0]!.lock.owner.instance);
  });

  it('sweeps only old orphan pending files while holding the lock; fresh ones and the lock are untouched', async () => {
    const fs = new FakeFs();
    fs.dirs.add('/state');
    const oldOrphan = pendingFileFor('/state', 'crashed-1');
    const freshPending = pendingFileFor('/state', 'in-flight');
    fs.files.set(oldOrphan, JSON.stringify(owner(999, 'crashed-1')));
    fs.mtimes.set(oldOrphan, 0); // abandoned long before the current clock
    fs.files.set(freshPending, JSON.stringify(owner(555, 'in-flight'))); // fresh: default mtime
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    // The abandoned orphan pending was swept; a fresh in-flight pending and
    // the newly acquired lock are untouched.
    expect(fs.files.has(oldOrphan)).toBe(false);
    expect(fs.files.has(freshPending)).toBe(true);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-1')) ?? '{}') as LockOwner).toMatchObject({
      instance: 'inst-1',
    });
    expect(await outcome.lock.release()).toBe('released');
    expect(removalEvents(fs)).toEqual([
      `unlink ${oldOrphan}`,
      `unlink ${ownerPath('/state', 'inst-1')}`,
      'rmdir /state/lock',
    ]);
  });

  it('reclaims an empty lock dir left by a release that crashed between unlink and rmdir', async () => {
    const fs = new FakeFs();
    reclaimingMkdir(fs);
    const first = new RepositoryLock('/state', makeDeps(fs, { pid: 123 }));
    const r1 = await first.acquire();
    expect(r1.kind).toBe('acquired');
    // The holder unlinks its owner file, then crashes before the rmdir.
    await fs.unlink(ownerPath('/state', 'inst-1'));
    fs.mtimes.set('/state/lock', 0); // the abandoned empty dir ages past grace
    const second = new RepositoryLock('/state', makeDeps(fs, { pid: 456, randomId: () => 'inst-2' }));
    const r2 = await second.acquire();
    expect(r2.kind).toBe('acquired');
    if (r2.kind !== 'acquired') return;
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-2')) ?? '{}') as LockOwner).toMatchObject({
      pid: 456,
      instance: 'inst-2',
    });
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('post-write verification failure removes only the current token', async () => {
    const fs = new FakeFs();
    const competitor = ownerPath('/state', 'competitor');
    const originalReaddir = fs.readdir.bind(fs);
    let injected = false;
    // A competitor's token lands between our owner write and verification.
    fs.readdir = (path) => {
      if (!injected && path === '/state/lock') {
        injected = true;
        fs.files.set(competitor, JSON.stringify(owner(555, 'competitor')));
      }
      return originalReaddir(path);
    };
    const lock = new RepositoryLock('/state', makeDeps(fs, { randomId: () => 'inst-1' }));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    // Only the current acquisition's own token is unlinked — never the
    // directory, so the competitor's lock is untouched.
    expect(removalEvents(fs)).toEqual([`unlink ${ownerPath('/state', 'inst-1')}`]);
    expect(JSON.parse(fs.files.get(competitor) ?? '{}') as LockOwner).toMatchObject({
      instance: 'competitor',
    });
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('refuses an old empty lock dir when its age cannot be established (stat error)', async () => {
    const fs = new FakeFs();
    fs.dirs.add('/state/lock');
    fs.mtimes.set('/state/lock', 0);
    fs.statErrors.set('/state/lock', new Error('EACCES: permission denied'));
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('refuses an empty lock dir whose mtime is in the future (clock ambiguity)', async () => {
    const fs = new FakeFs();
    fs.dirs.add('/state/lock');
    fs.mtimes.set('/state/lock', 9_999); // ahead of the fake clock (1_000)
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
  });

  it('refuses a malformed token whose age cannot be established (stat error)', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'abandoned');
    fs.files.set(token, 'not-json{{');
    fs.mtimes.set(token, 0);
    fs.statErrors.set(token, new Error('EACCES: permission denied'));
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(token)).toBe(true);
  });

  it('abandons the reclaim when a paused writer completes its token in the meantime', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'abandoned');
    // The writer completed a valid token while the reclaimer was mid-flight;
    // only the reclaimer's first read sees the earlier incomplete state.
    fs.files.set(token, JSON.stringify(owner(123, 'abandoned')));
    fs.mtimes.set(token, 0);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const originalRead = fs.readFile.bind(fs);
    let tokenReads = 0;
    fs.readFile = (path) => {
      if (path === token) {
        tokenReads += 1;
        if (tokenReads === 1) return Promise.resolve('{"pid": 9'); // incomplete at first judgment
      }
      return originalRead(path);
    };
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    // Nothing was removed: the now-valid owner's lock is left alone.
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.get(token)).toBe(JSON.stringify(owner(123, 'abandoned')));
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('refuses a valid live owner even when its token is older than the grace period', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'live-old');
    fs.files.set(token, JSON.stringify(owner(4242, 'live-old')));
    fs.mtimes.set(token, 0);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock(
      '/state',
      makeDeps(fs, { probe: (pid) => (pid === 4242 ? 'alive' : 'dead') }),
    );
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/4242/);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(token)).toBe(true);
  });

  it('two simultaneous reclaimers of an old empty dir: at most one acquires and the lock survives', async () => {
    const fs = new FakeFs();
    abandonedEmptyDir(fs);
    const probe = (pid: number): ProcessStatus => (pid === 123 || pid === 456 ? 'alive' : 'dead');
    const lockA = new RepositoryLock('/state', makeDeps(fs, { pid: 123, randomId: () => 'inst-a', probe }));
    const lockB = new RepositoryLock('/state', makeDeps(fs, { pid: 456, randomId: () => 'inst-b', probe }));
    const outcomes = await Promise.all([lockA.acquire(), lockB.acquire()]);
    const acquired = outcomes.filter(
      (outcome): outcome is Extract<AcquireOutcome, { kind: 'acquired' }> => outcome.kind === 'acquired',
    );
    expect(acquired).toHaveLength(1);
    const ownerFiles = [...fs.files.keys()].filter((key) => key.startsWith(`${LOCK_DIR_PATH}/`));
    expect(ownerFiles).toHaveLength(1);
    const surviving = JSON.parse(fs.files.get(ownerFiles[0]!) ?? '{}') as LockOwner;
    expect(surviving.instance).toBe(acquired[0]!.lock.owner.instance);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });
});

describe('RepositoryLock multi-token stale reclamation', () => {
  /** Mkdir fails while the lock dir exists; succeeds once it is removed. */
  function reclaimingMkdir(fs: FakeFs): void {
    fs.mkdirImpl = (path) => {
      if (path === '/state/lock') {
        if (fs.dirs.has('/state/lock')) return Promise.reject(eexist(path));
        fs.dirs.add(path);
      }
      return Promise.resolve();
    };
  }

  /** Old dead-owner token fixture: token mtime ages it past the grace period. */
  function deadToken(fs: FakeFs, instance: string, pid: number): string {
    const path = ownerPath('/state', instance);
    fs.files.set(path, JSON.stringify(owner(pid, instance)));
    fs.mtimes.set(path, 0);
    return path;
  }

  it('reclaims two old dead valid tokens (winner + crashed loser) and acquires', async () => {
    const fs = new FakeFs();
    const winner = deadToken(fs, 'a-winner', 999);
    const loser = deadToken(fs, 'b-crashed-loser', 888);
    fs.dirs.add('/state/lock');
    reclaimingMkdir(fs);
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    // Every judged token was unlinked by its exact filename, then the
    // now-empty directory was rmdir'd once; the lock was re-created under a
    // fresh token filename.
    expect(removalEvents(fs)).toEqual([`unlink ${winner}`, `unlink ${loser}`, 'rmdir /state/lock']);
    expect(fs.files.has(winner)).toBe(false);
    expect(fs.files.has(loser)).toBe(false);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-1')) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-1',
    });
  });

  it('refuses untouched when any multi-entry token belongs to a live pid', async () => {
    const fs = new FakeFs();
    deadToken(fs, 'a-dead', 999);
    const live = deadToken(fs, 'b-live', 4242);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock(
      '/state',
      makeDeps(fs, { probe: (pid) => (pid === 4242 ? 'alive' : 'dead') }),
    );
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/4242/);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(ownerPath('/state', 'a-dead'))).toBe(true);
    expect(fs.files.has(live)).toBe(true);
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('refuses untouched when any multi-entry token has ambiguous liveness', async () => {
    const fs = new FakeFs();
    deadToken(fs, 'a-dead', 999);
    const ambiguous = deadToken(fs, 'b-ambiguous', 777);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock(
      '/state',
      makeDeps(fs, { probe: (pid) => (pid === 777 ? 'ambiguous' : 'dead') }),
    );
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/cannot determine whether owner pid 777/);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(ownerPath('/state', 'a-dead'))).toBe(true);
    expect(fs.files.has(ambiguous)).toBe(true);
  });

  it('refuses untouched when any multi-entry token is younger than the grace period', async () => {
    const fs = new FakeFs();
    deadToken(fs, 'a-old', 999);
    const fresh = ownerPath('/state', 'b-fresh');
    fs.files.set(fresh, JSON.stringify(owner(888, 'b-fresh')));
    // b-fresh keeps the default fake-clock mtime: age 0 < grace period.
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/younger than/);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(ownerPath('/state', 'a-old'))).toBe(true);
    expect(fs.files.has(fresh)).toBe(true);
  });

  it('refuses untouched when any multi-entry token is malformed', async () => {
    const fs = new FakeFs();
    deadToken(fs, 'a-old', 999);
    const malformed = ownerPath('/state', 'b-malformed');
    fs.files.set(malformed, 'not-json{{');
    fs.mtimes.set(malformed, 0);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/not valid JSON/);
    expect(removalEvents(fs)).toEqual([`unlink ${PENDING_INST_1}`]);
    expect(fs.files.has(ownerPath('/state', 'a-old'))).toBe(true);
    expect(fs.files.has(malformed)).toBe(true);
  });

  it('a competitor publishing mid-reclaim survives: rmdir refuses and the new lock is preserved', async () => {
    const fs = new FakeFs();
    const a = deadToken(fs, 'a-old', 999);
    const b = deadToken(fs, 'b-old', 888);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    // A paused competitor's publish lands while the reclaim is removing the
    // judged tokens: right before the rmdir executes, a fresh token appears.
    const originalRmdir = fs.rmdir.bind(fs);
    const competitor = ownerPath('/state', 'competitor');
    fs.rmdir = (path) => {
      if (path === '/state/lock') {
        fs.files.set(competitor, JSON.stringify(owner(555, 'competitor')));
      }
      return originalRmdir(path);
    };
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/not empty/);
    // The two judged dead tokens were removed by exact filename, but the
    // competitor's fresh token and the directory survived the rmdir refusal.
    expect(fs.files.has(a)).toBe(false);
    expect(fs.files.has(b)).toBe(false);
    expect(JSON.parse(fs.files.get(competitor) ?? '{}') as LockOwner).toMatchObject({
      pid: 555,
      instance: 'competitor',
    });
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });

  it('a crash mid-multi-unlink leaves the remainder reclaimable on the next attempt', async () => {
    const fs = new FakeFs();
    deadToken(fs, 'a-old', 999);
    const b = deadToken(fs, 'b-old', 888);
    const c = deadToken(fs, 'c-old', 777);
    fs.dirs.add('/state/lock');
    fs.mkdirErrors.set('/state/lock', eexist('/state/lock'));
    // The reclaimer "crashes" after its first unlink: the second judged-token
    // unlink fails hard, refusing this attempt mid-reclaim.
    let tokenUnlinks = 0;
    const originalUnlink = fs.unlink.bind(fs);
    fs.unlink = (path) => {
      if (path.startsWith(`${LOCK_DIR_PATH}/owner-`)) {
        tokenUnlinks += 1;
        if (tokenUnlinks === 2) {
          return Promise.reject(Object.assign(new Error('EIO: input/output error'), { code: 'EIO' }));
        }
      }
      return originalUnlink(path);
    };
    const first = new RepositoryLock('/state', makeDeps(fs));
    const firstOutcome = await first.acquire();
    expect(firstOutcome.kind).toBe('contended');
    if (firstOutcome.kind === 'contended') expect(firstOutcome.reason).toMatch(/EIO/);
    // The first token was unlinked before the crash; the rest remain.
    expect(fs.files.has(ownerPath('/state', 'a-old'))).toBe(false);
    expect(fs.files.has(b)).toBe(true);
    expect(fs.files.has(c)).toBe(true);
    // The next attempt re-judges the remaining tokens (still valid dead
    // owners, now older) and completes the reclaim and the acquisition.
    fs.mkdirErrors.delete('/state/lock');
    reclaimingMkdir(fs);
    const second = new RepositoryLock('/state', makeDeps(fs));
    const secondOutcome = await second.acquire();
    expect(secondOutcome.kind).toBe('acquired');
    if (secondOutcome.kind !== 'acquired') return;
    expect(fs.files.has(b)).toBe(false);
    expect(fs.files.has(c)).toBe(false);
    expect(JSON.parse(fs.files.get(ownerPath('/state', 'inst-1')) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-1',
    });
    expect(fs.dirs.has('/state/lock')).toBe(true);
  });
});

describe('RepositoryLock publish-ENOENT retry', () => {
  it('retains the staged pending file on publish ENOENT and retries to acquisition', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'inst-1');
    const pending = pendingFileFor('/state', 'inst-1');
    // This acquisition's publish rename is held open after its atomic mkdir.
    let renameStarted!: () => void;
    const renameStartedPromise = new Promise<void>((resolve) => (renameStarted = resolve));
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => (releaseRename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === token) {
        renameStarted();
        return renameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    // The retry mkdir is paused so the test can observe the pending file
    // between the failed publish and the retry.
    let mkdirCalls = 0;
    let retryMkdirStarted!: () => void;
    const retryMkdirStartedPromise = new Promise<void>((resolve) => (retryMkdirStarted = resolve));
    let releaseRetryMkdir!: () => void;
    const retryMkdirGate = new Promise<void>((resolve) => (releaseRetryMkdir = resolve));
    fs.mkdirImpl = (path) => {
      if (path !== '/state/lock') return Promise.resolve();
      mkdirCalls += 1;
      if (mkdirCalls === 1) {
        fs.dirs.add(path);
        return Promise.resolve();
      }
      retryMkdirStarted();
      return retryMkdirGate.then(() => void fs.dirs.add(path));
    };
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const pendingAcquire = lock.acquire();
    await renameStartedPromise;
    // A recoverer judged the paused empty claim abandoned, rmdir'd it, and
    // was killed before re-creating: the directory is momentarily gone.
    fs.dirs.delete('/state/lock');
    releaseRename();
    // The rename misses (ENOENT) and the retry pauses at its mkdir. The
    // staged pending file must have survived the failed publish untouched.
    await retryMkdirStartedPromise;
    expect(fs.files.has(pending)).toBe(true);
    expect(JSON.parse(fs.files.get(pending) ?? '{}') as LockOwner).toMatchObject({ instance: 'inst-1' });
    // The retry re-creates the directory, publishes, and verifies sole
    // ownership: the acquisition succeeds.
    releaseRetryMkdir();
    const outcome = await pendingAcquire;
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    expect(fs.files.has(pending)).toBe(false); // consumed by the successful rename
    expect(JSON.parse(fs.files.get(token) ?? '{}') as LockOwner).toMatchObject({
      pid: 123,
      instance: 'inst-1',
    });
    // Nothing was unlinked or rmdir'd by this acquisition: no cleanup ran
    // on the ENOENT path.
    expect(removalEvents(fs)).toEqual([]);
  });

  it('never rmdirs a competitor\'s fresh empty dir while handling a publish ENOENT', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'inst-1');
    const pending = pendingFileFor('/state', 'inst-1');
    let renameStarted!: () => void;
    const renameStartedPromise = new Promise<void>((resolve) => (renameStarted = resolve));
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => (releaseRename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === token) {
        renameStarted();
        return renameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    // While a failing acquirer would clean up its own (never-published)
    // token, a competitor re-creates a fresh empty claim directory.
    let cleanupUnlinkSeen = false;
    const originalUnlink = fs.unlink.bind(fs);
    fs.unlink = (path) => {
      if (!cleanupUnlinkSeen && path === token) {
        cleanupUnlinkSeen = true;
        fs.dirs.add('/state/lock');
        return Promise.reject(enoent(path)); // no own token was ever published
      }
      return originalUnlink(path);
    };
    const lock = new RepositoryLock('/state', makeDeps(fs));
    const pendingAcquire = lock.acquire();
    await renameStartedPromise;
    fs.dirs.delete('/state/lock');
    releaseRename();
    // The ENOENT path never cleans up: the acquisition simply retries and
    // acquires. The competitor's fresh dir was never observed, let alone
    // rmdir'd by a failed-cleanup path.
    const outcome = await pendingAcquire;
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    expect(fs.dirs.has('/state/lock')).toBe(true);
    expect(fs.files.has(pending)).toBe(false); // consumed by the successful rename
    expect(fs.files.get(token)).toContain('inst-1');
    // No unlink/rmdir of lock-directory content ever ran.
    expect(removalEvents(fs)).toEqual([]);
  });

  it('a competitor publishing between publish attempts keeps its lock: the retry contends and removes nothing', async () => {
    const fs = new FakeFs();
    const token = ownerPath('/state', 'inst-1');
    const pending = pendingFileFor('/state', 'inst-1');
    const competitor = ownerPath('/state', 'competitor');
    let renameStarted!: () => void;
    const renameStartedPromise = new Promise<void>((resolve) => (renameStarted = resolve));
    let releaseRename!: () => void;
    const renameGate = new Promise<void>((resolve) => (releaseRename = resolve));
    const originalRename = fs.rename.bind(fs);
    fs.rename = (oldPath, newPath) => {
      if (newPath === token) {
        renameStarted();
        return renameGate.then(() => originalRename(oldPath, newPath));
      }
      return originalRename(oldPath, newPath);
    };
    // The retry mkdir is paused so the test can inject the competitor's
    // completed publish between the failed attempt and the retry.
    let mkdirCalls = 0;
    let retryMkdirStarted!: () => void;
    const retryMkdirStartedPromise = new Promise<void>((resolve) => (retryMkdirStarted = resolve));
    let releaseRetryMkdir!: () => void;
    const retryMkdirGate = new Promise<void>((resolve) => (releaseRetryMkdir = resolve));
    fs.mkdirImpl = (path) => {
      if (path !== '/state/lock') return Promise.resolve();
      mkdirCalls += 1;
      if (mkdirCalls === 1) {
        fs.dirs.add(path);
        return Promise.resolve();
      }
      retryMkdirStarted();
      return retryMkdirGate.then(() => {
        // The competitor completed its own publish while this acquisition
        // paused between attempts.
        fs.dirs.add(path);
        fs.files.set(competitor, JSON.stringify(owner(555, 'competitor')));
        return Promise.reject(eexist(path));
      });
    };
    const lock = new RepositoryLock(
      '/state',
      makeDeps(fs, { probe: (pid) => (pid === 555 ? 'alive' : 'dead') }),
    );
    const pendingAcquire = lock.acquire();
    await renameStartedPromise;
    fs.dirs.delete('/state/lock');
    releaseRename();
    await retryMkdirStartedPromise;
    // The staged pending file survived the failed publish; it is removed only
    // when this acquisition finally gives up, after the retry's refusal.
    expect(fs.files.has(pending)).toBe(true);
    releaseRetryMkdir();
    const outcome = await pendingAcquire;
    expect(outcome.kind).toBe('contended');
    if (outcome.kind === 'contended') expect(outcome.reason).toMatch(/555/);
    // The competitor's published lock is untouched: no rmdir, no unlink of
    // its token.
    expect(JSON.parse(fs.files.get(competitor) ?? '{}') as LockOwner).toMatchObject({
      pid: 555,
      instance: 'competitor',
    });
    expect(fs.dirs.has('/state/lock')).toBe(true);
    // The own pending file is removed only after the retry contended (final
    // give-up), never inside the failed-publish handling.
    const mkdirIndices = fs.events
      .map((event, index) => (event === 'mkdir /state/lock' ? index : -1))
      .filter((index) => index >= 0);
    const retryMkdirIndex = mkdirIndices[mkdirIndices.length - 1]!;
    const pendingUnlinkIndex = fs.events.indexOf(`unlink ${pending}`);
    expect(pendingUnlinkIndex).toBeGreaterThan(retryMkdirIndex);
  });
});

describe('RepositoryLock on a real filesystem (hermetic temp dir)', () => {
  const realFs: CoordinationFsOps = {
    mkdir: (path, options) => mkdir(path, options),
    readFile: (path) => fsReadFile(path, 'utf8'),
    writeFile: (path, data, options) => writeFile(path, data, options),
    readdir: (path) => readdir(path),
    chmod: (path, mode) => chmod(path, mode),
    stat: (path) => stat(path),
    rename: (oldPath, newPath) => rename(oldPath, newPath),
    unlink: (path) => unlink(path),
    rmdir: (path) => rmdir(path),
    realpath: (path) => Promise.resolve(path),
  };
  const realDeps = (): LockDeps => ({
    fs: realFs,
    pid: process.pid,
    host: 'test-host',
    probe: probeProcess,
  });

  it('acquires, a second acquisition contends against the live owner, release unblocks it', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-lock-real-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const first = new RepositoryLock(stateDir, realDeps());
    const r1 = await first.acquire();
    expect(r1.kind).toBe('acquired');
    const second = new RepositoryLock(stateDir, realDeps());
    const r2 = await second.acquire();
    expect(r2.kind).toBe('contended');
    if (r1.kind !== 'acquired') throw new Error('expected acquisition');
    expect(await r1.lock.release()).toBe('released');
    const r3 = await second.acquire();
    expect(r3.kind).toBe('acquired');
    if (r3.kind === 'acquired') await r3.lock.release();
    await rm(base, { recursive: true, force: true });
  });

  it('recovers a stale lock recorded for a positively-dead pid', async () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    if (child.pid === undefined) throw new Error('spawnSync returned no pid');
    const deadPid = child.pid;
    expect(probeProcess(deadPid)).toBe('dead');
    const base = await mkdtemp(join(tmpdir(), 'fo-lock-stale-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lockDir = join(stateDir, LOCK_DIR);
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    await writeFile(join(lockDir, ownerFileName('stale')), JSON.stringify(owner(deadPid, 'stale')));
    const lock = new RepositoryLock(stateDir, realDeps());
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind === 'acquired') {
      expect(outcome.lock.owner.pid).toBe(process.pid);
      await outcome.lock.release();
    }
    await rm(base, { recursive: true, force: true });
  });

  it('reclaims an abandoned empty lock directory on a real filesystem', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-lock-empty-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lockDir = join(stateDir, LOCK_DIR);
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    // Wait out the grace period so the empty dir reads as an abandoned claim.
    await new Promise((resolve) => setTimeout(resolve, INCOMPLETE_CLAIM_GRACE_MS + 100));
    const lock = new RepositoryLock(stateDir, realDeps());
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind === 'acquired') await outcome.lock.release();
    await rm(base, { recursive: true, force: true });
  });

  it('creates the lock directory and owner metadata with private permissions', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-lock-mode-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lock = new RepositoryLock(stateDir, realDeps());
    const outcome = await lock.acquire();
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    const lockDir = join(stateDir, LOCK_DIR);
    expect((await stat(lockDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(lockDir, ownerFileName(outcome.lock.owner.instance)))).mode & 0o777).toBe(0o600);
    await outcome.lock.release();
    await rm(base, { recursive: true, force: true });
  });
});

describe('probeProcess', () => {
  it('reports the current process as alive', () => {
    expect(probeProcess(process.pid)).toBe('alive');
  });

  it('reports a just-exited child as dead', () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    if (child.pid === undefined) throw new Error('spawnSync returned no pid');
    expect(probeProcess(child.pid)).toBe('dead');
  });
});
