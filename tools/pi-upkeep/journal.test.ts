import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOURNAL_FILE,
  JOURNAL_PHASES,
  JOURNAL_SCHEMA_VERSION,
  createJournal,
  journalPath,
  parseJournal,
  pendingJournalPath,
  prepareTransaction,
  readJournal,
  readTransaction,
  removeJournal,
  updateJournal,
  type JournalFs,
  type NewJournalData,
} from './journal.ts';
import { sentinelPath } from './sentinel.ts';
import { sha256Hex } from '../../server/src/upkeep/state-path.ts';
import { CoordinationFakeFs as FakeFs } from './test/fake-fs.ts';

const MANIFESTS = {
  packageJson: {
    content: '{\n  "name": "funkyoctopus",\n  "dependencies": { "@earendil-works/pi-coding-agent": "0.84.1" }\n}\n',
    sha256: '',
  },
  packageLock: {
    content: '{\n  "lockfileVersion": 3,\n  "packages": { "": { "dependencies": { "@earendil-works/pi-coding-agent": "0.84.1" } } }\n}\n',
    sha256: '',
  },
};
MANIFESTS.packageJson.sha256 = sha256Hex(MANIFESTS.packageJson.content);
MANIFESTS.packageLock.sha256 = sha256Hex(MANIFESTS.packageLock.content);

function makeJournalData(): NewJournalData {
  return {
    repo: {
      canonicalPath: '/canonical/repo',
      head: 'a'.repeat(40),
      branch: 'main',
    },
    versions: { installed: '0.84.1', candidate: '0.85.0' },
    verificationLevel: 'live',
    manifests: {
      packageJson: { ...MANIFESTS.packageJson },
      packageLock: { ...MANIFESTS.packageLock },
    },
    paths: {
      backup: '/backup-sibling/funkyoctopus-node_modules-old-0.84.1',
      logs: ['/state/run-1.log'],
    },
  };
}

function makeDeps(idSequence: string[] = ['tx-1', 'tmp-2', 'tmp-3']) {
  const clock = { now: 1_000 };
  let next = 0;
  return {
    deps: {
      randomId: (): string => idSequence[Math.min(next++, idSequence.length - 1)] ?? 'fallback',
      now: (): number => clock.now,
    },
    clock,
  };
}

const STATE = '/state/abc';

function onlyWriteThenRename(events: string[]): boolean {
  return events.every((event) => {
    return event.startsWith('read ') || event.startsWith('write ') || event.startsWith('rename ');
  });
}

function pendingOf(stateDir: string, instance: string): string {
  return pendingJournalPath(stateDir, instance);
}

describe('journal schema and validation', () => {
  it('rejects arbitrary or malformed journal JSON instead of accepting it', () => {
    for (const raw of ['not json', '42', '{"hello":"world"}']) {
      const parsed = parseJournal(raw);
      expect(parsed.ok).toBe(false);
    }
  });

  it('rejects wrong schema versions, phases, versions, head, and broken manifest hashes', () => {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'tx-1',
      phase: 'armed' as const,
      createdAt: 1_000,
      repo: { canonicalPath: '/repo', head: 'a'.repeat(40), branch: 'main' },
      versions: { installed: '0.84.1', candidate: '0.85.0' },
      verificationLevel: 'live',
      manifests: {
        packageJson: { content: 'x', sha256: sha256Hex('x') },
        packageLock: { content: 'y', sha256: sha256Hex('y') },
      },
      paths: { backup: '/b', logs: ['/l'] },
    };
    expect(parseJournal(JSON.stringify({ ...journal, schemaVersion: 2 })).ok).toBe(false);
    expect(parseJournal(JSON.stringify({ ...journal, phase: 'bogus' })).ok).toBe(false);
    expect(parseJournal(JSON.stringify({ ...journal, versions: { installed: '^0.84.1', candidate: '0.85.0' } })).ok).toBe(false);
    expect(parseJournal(JSON.stringify({ ...journal, repo: { ...journal.repo, head: 'short' } })).ok).toBe(false);
    // A snapshot whose recorded hash does not match its content must fail validation.
    expect(
      parseJournal(
        JSON.stringify({
          ...journal,
          manifests: {
            ...journal.manifests,
            packageJson: { content: 'tampered', sha256: sha256Hex('original') },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(parseJournal(JSON.stringify(journal)).ok).toBe(true);
  });

  it('round-trips optional candidate manifest snapshots only when present', () => {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'tx-1',
      phase: 'mutating' as const,
      createdAt: 1_000,
      repo: { canonicalPath: '/repo', head: 'a'.repeat(40), branch: 'main' },
      versions: { installed: '0.84.1', candidate: '0.85.0' },
      verificationLevel: 'live',
      manifests: {
        packageJson: { content: 'x', sha256: sha256Hex('x') },
        packageLock: { content: 'y', sha256: sha256Hex('y') },
        candidatePackageJson: { content: 'xc', sha256: sha256Hex('xc') },
        candidatePackageLock: { content: 'yc', sha256: sha256Hex('yc') },
      },
      paths: { backup: '/b', logs: ['/l'] },
    };
    const parsed = parseJournal(JSON.stringify(journal));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.journal.manifests.candidatePackageJson?.content).toBe('xc');
      expect(parsed.journal.manifests.candidatePackageLock?.sha256).toBe(sha256Hex('yc'));
    }
  });

  it('fails closed when a candidate manifest snapshot is present but invalid', () => {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'tx-1',
      phase: 'mutating' as const,
      createdAt: 1_000,
      repo: { canonicalPath: '/repo', head: 'a'.repeat(40), branch: 'main' },
      versions: { installed: '0.84.1', candidate: '0.85.0' },
      verificationLevel: 'live',
      manifests: {
        packageJson: { content: 'x', sha256: sha256Hex('x') },
        packageLock: { content: 'y', sha256: sha256Hex('y') },
        candidatePackageJson: { content: 'xc', sha256: sha256Hex('xc') },
        candidatePackageLock: { content: 'yc', sha256: sha256Hex('yc') },
      },
      paths: { backup: '/b', logs: ['/l'] },
    };
    // Wrong type.
    expect(
      parseJournal(JSON.stringify({ ...journal, manifests: { ...journal.manifests, candidatePackageJson: 42 } })).ok,
    ).toBe(false);
    // Hash does not match the recorded content.
    expect(
      parseJournal(
        JSON.stringify({
          ...journal,
          manifests: {
            ...journal.manifests,
            candidatePackageLock: { content: 'tampered', sha256: sha256Hex('original') },
          },
        }),
      ).ok,
    ).toBe(false);
    // Non-hash-shaped sha256.
    expect(
      parseJournal(
        JSON.stringify({
          ...journal,
          manifests: {
            ...journal.manifests,
            candidatePackageJson: { content: 'xc', sha256: 'not-a-sha' },
          },
        }),
      ).ok,
    ).toBe(false);
    expect(parseJournal(JSON.stringify(journal)).ok).toBe(true);
  });

  it('fails closed when only one member of the candidate snapshot pair is recorded', () => {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'tx-1',
      phase: 'mutating' as const,
      createdAt: 1_000,
      repo: { canonicalPath: '/repo', head: 'a'.repeat(40), branch: 'main' },
      versions: { installed: '0.84.1', candidate: '0.85.0' },
      verificationLevel: 'live',
      manifests: {
        packageJson: { content: 'x', sha256: sha256Hex('x') },
        packageLock: { content: 'y', sha256: sha256Hex('y') },
        candidatePackageJson: { content: 'xc', sha256: sha256Hex('xc') },
        candidatePackageLock: { content: 'yc', sha256: sha256Hex('yc') },
      },
      paths: { backup: '/b', logs: ['/l'] },
    };
    const onlyJson = {
      ...journal,
      manifests: {
        packageJson: journal.manifests.packageJson,
        packageLock: journal.manifests.packageLock,
        candidatePackageJson: journal.manifests.candidatePackageJson,
      },
    };
    expect(parseJournal(JSON.stringify(onlyJson)).ok).toBe(false);
    const onlyLock = {
      ...journal,
      manifests: {
        packageJson: journal.manifests.packageJson,
        packageLock: journal.manifests.packageLock,
        candidatePackageLock: journal.manifests.candidatePackageLock,
      },
    };
    expect(parseJournal(JSON.stringify(onlyLock)).ok).toBe(false);
    // Neither member present is legitimately absent.
    const neither = {
      ...journal,
      manifests: {
        packageJson: journal.manifests.packageJson,
        packageLock: journal.manifests.packageLock,
      },
    };
    expect(parseJournal(JSON.stringify(neither)).ok).toBe(true);
  });

  it('rejects installed/candidate versions with leading zeros or unsafe precision', () => {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'tx-1',
      phase: 'prepared' as const,
      createdAt: 1_000,
      repo: { canonicalPath: '/repo', head: 'a'.repeat(40), branch: 'main' },
      versions: { installed: '0.84.1', candidate: '0.85.0' },
      verificationLevel: 'live',
      manifests: {
        packageJson: { content: 'x', sha256: sha256Hex('x') },
        packageLock: { content: 'y', sha256: sha256Hex('y') },
      },
      paths: { backup: '/b', logs: ['/l'] },
    };
    for (const bad of ['0.84.01', '01.84.1', '0.9007199254740992.0', '999999999999999999999999999999.0.0']) {
      expect(
        parseJournal(JSON.stringify({ ...journal, versions: { installed: bad, candidate: '0.85.0' } })).ok,
      ).toBe(false);
    }
    // MAX_SAFE_INTEGER components are exact and accepted.
    const max = '9007199254740991';
    expect(
      parseJournal(JSON.stringify({ ...journal, versions: { installed: `0.${max}.1`, candidate: '0.85.0' } })).ok,
    ).toBe(true);
  });

  it('rejects an oversized transaction id instead of accepting unbounded journal data', () => {
    const parsed = parseJournal(JSON.stringify({
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'x'.repeat(129),
      phase: 'prepared',
      createdAt: 1_000,
      ...makeJournalData(),
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('transaction id');
  });

  it('requires a strictly validated durable verificationLevel (live or deterministic_only)', () => {
    const journal = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      transactionId: 'tx-1',
      phase: 'prepared' as const,
      createdAt: 1_000,
      repo: { canonicalPath: '/repo', head: 'a'.repeat(40), branch: 'main' },
      versions: { installed: '0.84.1', candidate: '0.85.0' },
      verificationLevel: 'live' as const,
      manifests: {
        packageJson: { content: 'x', sha256: sha256Hex('x') },
        packageLock: { content: 'y', sha256: sha256Hex('y') },
      },
      paths: { backup: '/b', logs: ['/l'] },
    };
    expect(parseJournal(JSON.stringify(journal)).ok).toBe(true);
    expect(parseJournal(JSON.stringify({ ...journal, verificationLevel: 'deterministic_only' })).ok).toBe(true);
    // Missing or any value outside the closed set fails: an attempt must
    // record whether it used the required live canary or the explicit skip.
    for (const bad of [undefined, null, 'unknown', 'LIVE', 'deterministic', 42, true]) {
      // JSON.stringify drops an undefined value, so the missing-key case is
      // exercised through the same spread (bad === undefined omits the field).
      const candidate = bad === undefined ? { ...journal, verificationLevel: undefined } : { ...journal, verificationLevel: bad };
      const parsed = parseJournal(JSON.stringify(candidate));
      expect(parsed.ok).toBe(false);
    }
  });
});

describe('createJournal', () => {
  it('publishes atomically via a private unique temp and rename, never in place', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1', 'tmp-2']);
    const result = await createJournal(STATE, fs, deps, makeJournalData());
    expect(result.kind).toBe('created');
    const journal = fs.files.get(journalPath(STATE));
    expect(journal).toBeDefined();
    const parsed = parseJournal(journal!);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.journal.transactionId).toBe('tx-1');
      expect(parsed.journal.phase).toBe('prepared');
      expect(parsed.journal.createdAt).toBe(1_000);
      // Byte-exact manifest copies and correct hashes survive the round trip.
      expect(parsed.journal.manifests.packageJson.content).toBe(MANIFESTS.packageJson.content);
      expect(parsed.journal.manifests.packageJson.sha256).toBe(MANIFESTS.packageJson.sha256);
      expect(parsed.journal.manifests.packageLock.content).toBe(MANIFESTS.packageLock.content);
    }
    // The canonical journal path is only ever reached by an atomic rename.
    expect(onlyWriteThenRename(fs.events)).toBe(true);
    const writes = fs.events.filter((event) => !event.startsWith('read '));
    expect(writes[0]).toBe(`write ${pendingOf(STATE, 'tx-1')}`);
    expect(writes[1]).toBe(`rename ${pendingOf(STATE, 'tx-1')} -> ${journalPath(STATE)}`);
    expect(fs.writeModes.get(pendingOf(STATE, 'tx-1'))).toBe(0o600);
    // The temp file itself is consumed by the rename — no staging residue.
    expect(fs.files.has(pendingOf(STATE, 'tx-1'))).toBe(false);
  });

  it('refuses when a journal already exists or is unreadable (evidence is never overwritten)', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps();
    await createJournal(STATE, fs, deps, makeJournalData());
    expect((await createJournal(STATE, fs, deps, makeJournalData())).kind).toBe('refuse');
    const fs2 = new FakeFs();
    fs2.readErrors.set(journalPath(STATE), Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect((await createJournal(STATE, fs2, deps, makeJournalData())).kind).toBe('refuse');
  });

  it('cleans its own staging file when the atomic write fails', async () => {
    const fs = new FakeFs();
    fs.renameErrors.set(pendingOf(STATE, 'tx-1'), Object.assign(new Error('EIO'), { code: 'EIO' }));
    const { deps } = makeDeps();
    const result = await createJournal(STATE, fs, deps, makeJournalData());
    expect(result.kind).toBe('error');
    expect(fs.files.has(journalPath(STATE))).toBe(false);
    expect(fs.files.has(pendingOf(STATE, 'tx-1'))).toBe(false);
    expect(fs.events).toContain(`unlink ${pendingOf(STATE, 'tx-1')}`);
  });

  it('stale staging files from a crashed write are inert and never read', async () => {
    const fs = new FakeFs();
    fs.files.set(pendingOf(STATE, 'stale-orphan'), 'half-written garbage');
    expect((await readJournal(STATE, fs)).kind).toBe('absent');
    const { deps } = makeDeps(['tx-new', 'tmp-new']);
    const result = await createJournal(STATE, fs, deps, makeJournalData());
    expect(result.kind).toBe('created');
    expect(fs.files.get(pendingOf(STATE, 'stale-orphan'))).toBe('half-written garbage');
    expect(fs.events.some((event) => event.includes('stale-orphan'))).toBe(false);
  });
});

describe('prepareTransaction ordering', () => {
  it('writes the prepared journal first, then creates the sentinel exclusively, then arms', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1', 'tmp-2']);
    const result = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(result.kind).toBe('armed');
    // Journal write+rename must precede the sentinel creation.
    const journalRename = fs.events.indexOf(`rename ${pendingOf(STATE, 'tx-1')} -> ${journalPath(STATE)}`);
    const sentinelWrite = fs.events.findIndex((event) => event === `write ${sentinelPath(STATE)}`);
    expect(journalRename).toBeGreaterThanOrEqual(0);
    expect(sentinelWrite).toBeGreaterThan(journalRename);
    // The sentinel is created exclusively with private mode.
    expect(fs.writeFlags.get(sentinelPath(STATE))).toBe('wx');
    expect(fs.writeModes.get(sentinelPath(STATE))).toBe(0o600);
    // The armed phase lands through a second atomic temp+rename.
    const secondRename = fs.events.findIndex((event) => event.startsWith(`rename ${pendingOf(STATE, 'tmp-2')}`));
    expect(secondRename).toBeGreaterThan(sentinelWrite);
    if (result.kind === 'armed') {
      expect(result.journal.phase).toBe('armed');
      expect(result.journal.transactionId).toBe('tx-1');
    }
    // Sentinel and journal both exist and match.
    expect((await readTransaction(STATE, fs)).kind).toBe('active');
    // Mutation is allowed only after arming: the prepared phase cannot advance directly.
    const mutate = await updateJournal(STATE, fs, deps, 'tx-1', 'prepared', { kind: 'phase', to: 'mutating' });
    expect(mutate.kind).toBe('refuse');
  });

  it('refuses when a sentinel already exists and discards only its own journal', async () => {
    const fs = new FakeFs();
    fs.files.set(sentinelPath(STATE), '{"transactionId":"other"}');
    const { deps } = makeDeps();
    const result = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(result).toEqual({ kind: 'refuse', reason: 'a transaction sentinel is already present' });
    expect(fs.files.has(journalPath(STATE))).toBe(false);
    // The pre-existing sentinel is untouched.
    expect(fs.files.get(sentinelPath(STATE))).toBe('{"transactionId":"other"}');
  });

  it('fails closed and cleans up when the sentinel cannot be created', async () => {
    const fs = new FakeFs();
    fs.writeErrors.set(sentinelPath(STATE), Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const { deps } = makeDeps();
    const result = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(result.kind).toBe('error');
    expect(fs.files.has(journalPath(STATE))).toBe(false);
    expect(fs.files.has(sentinelPath(STATE))).toBe(false);
  });
});

describe('journal phase updates', () => {
  async function armed(): Promise<{ fs: FakeFs; deps: ReturnType<typeof makeDeps>['deps']; transactionId: string }> {
    const fs = new FakeFs();
    const { deps } = makeDeps();
    const result = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(result.kind).toBe('armed');
    if (result.kind !== 'armed') throw new Error('unreachable');
    return { fs, deps, transactionId: result.journal.transactionId };
  }

  it('advances through the valid machine: armed -> mutating -> committed -> finalized', async () => {
    const { fs, deps, transactionId } = await armed();
    expect((await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'mutating' })).kind).toBe('updated');
    expect((await updateJournal(STATE, fs, deps, transactionId, 'mutating', { kind: 'phase', to: 'committed' })).kind).toBe('updated');
    expect((await updateJournal(STATE, fs, deps, transactionId, 'committed', { kind: 'phase', to: 'finalized' })).kind).toBe('updated');
  });

  it('supports the rollback path: mutating -> rolled_back -> finalized', async () => {
    const { fs, deps, transactionId } = await armed();
    await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'mutating' });
    expect((await updateJournal(STATE, fs, deps, transactionId, 'mutating', { kind: 'phase', to: 'rolled_back' })).kind).toBe('updated');
    expect((await updateJournal(STATE, fs, deps, transactionId, 'rolled_back', { kind: 'phase', to: 'finalized' })).kind).toBe('updated');
  });

  it('supports verified non-mutating completion: prepared -> finalized and armed -> finalized (terminal before sentinel clear)', async () => {
    const { fs, deps, transactionId } = await armed();
    expect((await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'finalized' })).kind).toBe('updated');
    const fs2 = new FakeFs();
    const { deps: deps2 } = makeDeps(['tx-a', 'tmp-b']);
    await createJournal(STATE, fs2, deps2, makeJournalData());
    expect((await updateJournal(STATE, fs2, deps2, 'tx-a', 'prepared', { kind: 'phase', to: 'finalized' })).kind).toBe('updated');
    // non-mutating phases still cannot skip into mutating or commit directly
    const jump = await updateJournal(STATE, fs2, deps2, 'tx-a', 'finalized', { kind: 'phase', to: 'mutating' });
    expect(jump.kind).toBe('refuse');
  });

  it('rejects backward transitions', async () => {
    const { fs, deps, transactionId } = await armed();
    await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'mutating' });
    const result = await updateJournal(STATE, fs, deps, transactionId, 'mutating', { kind: 'phase', to: 'armed' });
    expect(result.kind).toBe('refuse');
    if (result.kind === 'refuse') expect(result.reason).toContain('invalid phase transition');
  });

  it('rejects transitions out of the machine', async () => {
    const { fs, deps, transactionId } = await armed();
    const result = await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'prepared' });
    expect(result.kind).toBe('refuse');
    const skip = await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'committed' });
    expect(skip.kind).toBe('refuse');
  });

  it('rejects a wrong transaction id and a stale expected phase', async () => {
    const { fs, deps, transactionId } = await armed();
    const wrongId = await updateJournal(STATE, fs, deps, 'other-tx', 'armed', { kind: 'phase', to: 'mutating' });
    expect(wrongId.kind).toBe('refuse');
    if (wrongId.kind === 'refuse') expect(wrongId.reason).toContain('transaction id');
    const stalePhase = await updateJournal(STATE, fs, deps, transactionId, 'prepared', { kind: 'phase', to: 'mutating' });
    expect(stalePhase.kind).toBe('refuse');
  });

  it('is atomic: the journal is replaced by rename and unchanged on failure', async () => {
    const { fs, deps, transactionId } = await armed();
    const before = fs.files.get(journalPath(STATE))!;
    const parsedBefore = parseJournal(before);
    expect(parsedBefore.ok && parsedBefore.journal.phase).toBe('armed');
    fs.renameErrors.set(pendingOf(STATE, 'tmp-3'), Object.assign(new Error('EIO'), { code: 'EIO' }));
    const result = await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'mutating' });
    expect(result.kind).toBe('error');
    expect(fs.files.get(journalPath(STATE))).toBe(before);
    expect(fs.files.has(pendingOf(STATE, 'tmp-2'))).toBe(false);
    const reRead = await readJournal(STATE, fs);
    expect(reRead.kind === 'present' && reRead.journal.phase).toBe('armed');
  });

  it('records expected candidate manifest hashes only while mutating', async () => {
    const { fs, deps, transactionId } = await armed();
    const tooEarly = await updateJournal(STATE, fs, deps, transactionId, 'armed', {
      kind: 'candidate_manifests',
      packageJson: { content: 'candidate-pkg', sha256: sha256Hex('candidate-pkg') },
      packageLock: { content: 'candidate-lock', sha256: sha256Hex('candidate-lock') },
    });
    expect(tooEarly.kind).toBe('refuse');
    await updateJournal(STATE, fs, deps, transactionId, 'armed', { kind: 'phase', to: 'mutating' });
    const recorded = await updateJournal(STATE, fs, deps, transactionId, 'mutating', {
      kind: 'candidate_manifests',
      packageJson: { content: 'candidate-pkg', sha256: sha256Hex('candidate-pkg') },
      packageLock: { content: 'candidate-lock', sha256: sha256Hex('candidate-lock') },
    });
    expect(recorded.kind).toBe('updated');
    const current = await readJournal(STATE, fs);
    expect(current.kind).toBe('present');
    if (current.kind === 'present') {
      expect(current.journal.manifests.candidatePackageJson?.sha256).toBe(sha256Hex('candidate-pkg'));
      expect(current.journal.manifests.candidatePackageLock?.content).toBe('candidate-lock');
      // The phase is unchanged by the recording.
      expect(current.journal.phase).toBe('mutating');
    }
  });
});

describe('readTransaction state classification', () => {
  it('reports none for an empty state dir', async () => {
    expect(await readTransaction(STATE, new FakeFs())).toEqual({ kind: 'none' });
  });

  it('classifies a prepared journal without a sentinel as a non-mutating orphan', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1']);
    await createJournal(STATE, fs, deps, makeJournalData());
    const state = await readTransaction(STATE, fs);
    expect(state.kind).toBe('orphan_prepared');
    if (state.kind === 'orphan_prepared') {
      expect(state.journal.transactionId).toBe('tx-1');
      // The orphan is safe to discard: no sentinel, nothing mutated.
      expect(await removeJournal(STATE, fs, 'tx-1')).toBe('removed');
      expect(await readTransaction(STATE, fs)).toEqual({ kind: 'none' });
    }
  });

  it('classifies an armed journal without a sentinel as a non-mutating orphan', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1', 'tmp-2']);
    const prepared = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(prepared.kind).toBe('armed');
    fs.files.delete(sentinelPath(STATE));

    const state = await readTransaction(STATE, fs);

    expect(state.kind).toBe('orphan_prepared');
    if (state.kind === 'orphan_prepared') expect(state.journal.phase).toBe('armed');
  });

  it('fails closed when the sentinel exists but no journal is readable', async () => {
    const fs = new FakeFs();
    fs.files.set(sentinelPath(STATE), '{"transactionId":"tx-1"}');
    const state = await readTransaction(STATE, fs);
    expect(state.kind).toBe('failed_closed');
  });

  it('fails closed when the sentinel and journal transaction ids do not match', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1']);
    await createJournal(STATE, fs, deps, makeJournalData());
    fs.files.set(sentinelPath(STATE), '{"transactionId":"someone-else"}');
    const state = await readTransaction(STATE, fs);
    expect(state.kind).toBe('failed_closed');
    if (state.kind === 'failed_closed') expect(state.reason).toContain('does not match');
  });

  it('fails closed when the sentinel is unreadable or does not record a transaction id', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1']);
    await createJournal(STATE, fs, deps, makeJournalData());
    fs.files.set(sentinelPath(STATE), 'not json');
    expect((await readTransaction(STATE, fs)).kind).toBe('failed_closed');
    const fs2 = new FakeFs();
    const { deps: deps2 } = makeDeps(['tx-2']);
    await createJournal(STATE, fs2, deps2, makeJournalData());
    fs2.readErrors.set(sentinelPath(STATE), Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect((await readTransaction(STATE, fs2)).kind).toBe('failed_closed');
  });

  it('fails closed when the sentinel is missing mid-transaction', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1', 'tmp-2', 'tmp-3']);
    const prepared = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(prepared.kind).toBe('armed');
    if (prepared.kind === 'armed') {
      await updateJournal(STATE, fs, deps, prepared.journal.transactionId, 'armed', { kind: 'phase', to: 'mutating' });
    }
    fs.files.delete(sentinelPath(STATE));
    const state = await readTransaction(STATE, fs);
    expect(state.kind).toBe('failed_closed');
  });

  it('classifies a committed journal without a sentinel as completed cleanup_pending state', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1', 'tmp-2', 'tmp-3']);
    const prepared = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(prepared.kind).toBe('armed');
    if (prepared.kind === 'armed') {
      const tx = prepared.journal.transactionId;
      await updateJournal(STATE, fs, deps, tx, 'armed', { kind: 'phase', to: 'mutating' });
      await updateJournal(STATE, fs, deps, tx, 'mutating', { kind: 'phase', to: 'committed' });
      fs.files.delete(sentinelPath(STATE));
      expect((await readTransaction(STATE, fs)).kind).toBe('completed');
    }
  });

  it('reports active for a matching sentinel and journal at any phase', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1', 'tmp-2', 'tmp-3']);
    const prepared = await prepareTransaction(STATE, fs, deps, makeJournalData());
    expect(prepared.kind).toBe('armed');
    if (prepared.kind === 'armed') {
      await updateJournal(STATE, fs, deps, prepared.journal.transactionId, 'armed', { kind: 'phase', to: 'mutating' });
      const state = await readTransaction(STATE, fs);
      expect(state.kind).toBe('active');
      if (state.kind === 'active') expect(state.journal.phase).toBe('mutating');
    }
  });

  it('removeJournal refuses to delete evidence whose transaction id differs', async () => {
    const fs = new FakeFs();
    const { deps } = makeDeps(['tx-1']);
    await createJournal(STATE, fs, deps, makeJournalData());
    expect(await removeJournal(STATE, fs, 'not-ours')).toBe('mismatch');
    expect((await readJournal(STATE, fs)).kind).toBe('present');
  });
});

describe('journal on a real filesystem', () => {
  const realFs: JournalFs = {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile,
    rename,
    unlink,
  };

  it('creates private 0600 journal and sentinel, leaves no staging residue, and refuses a second transaction', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-journal-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true });
    try {
      const { deps } = makeDeps(['tx-real-1', 'tmp-real-2']);
      const result = await prepareTransaction(stateDir, realFs, deps, makeJournalData());
      expect(result.kind).toBe('armed');
      expect((await stat(journalPath(stateDir))).mode & 0o777).toBe(0o600);
      expect((await stat(sentinelPath(stateDir))).mode & 0o777).toBe(0o600);
      const entries = await readdir(stateDir);
      expect(entries).toEqual([JOURNAL_FILE, 'transaction.sentinel']);
      expect((await readTransaction(stateDir, realFs)).kind).toBe('active');
      const { deps: deps2 } = makeDeps(['tx-real-2']);
      expect((await prepareTransaction(stateDir, realFs, deps2, makeJournalData())).kind).toBe('refuse');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('ignores stale staging files left by a crashed write', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-stale-'));
    const stateDir = join(base, 'state');
    await mkdir(stateDir, { recursive: true });
    try {
      const stale = join(stateDir, 'pending-journal-crashed.json');
      await writeFile(stale, 'half-written garbage', { mode: 0o600 });
      const { deps } = makeDeps(['tx-real-3', 'tmp-real-4']);
      const result = await prepareTransaction(stateDir, realFs, deps, makeJournalData());
      expect(result.kind).toBe('armed');
      expect(await readFile(stale, 'utf8')).toBe('half-written garbage');
      expect(await readdir(stateDir)).toEqual([
        'pending-journal-crashed.json',
        JOURNAL_FILE,
        'transaction.sentinel',
      ]);
      const read = await readJournal(stateDir, realFs);
      expect(read.kind).toBe('present');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('journal constants', () => {
  it('uses stable file names and a validated phase set', () => {
    expect(JOURNAL_FILE).toMatch(/^[a-z0-9.-]+$/);
    expect(JOURNAL_PHASES).toContain('prepared');
    expect(JOURNAL_PHASES).toContain('armed');
    expect(JOURNAL_PHASES).toContain('mutating');
    expect(JOURNAL_PHASES).toContain('committed');
    expect(JOURNAL_PHASES).toContain('rolled_back');
    expect(JOURNAL_PHASES).toContain('finalized');
  });
});
