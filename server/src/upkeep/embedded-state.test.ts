import { describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile as readFileReal, readdir, rename as renameReal, rm, stat, unlink as unlinkReal, writeFile as writeFileReal } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBEDDED_STATE_FILE,
  defaultEmbeddedState,
  embeddedInfoOf,
  loadEmbeddedState,
  parseEmbeddedState,
  persistedOf,
  saveEmbeddedState,
  type EmbeddedStateFs,
  type PersistedEmbeddedState,
} from './embedded-state.ts';
import { ensureStateDir } from './state-path.ts';

/** Real-fs adapter for the state seams, mirroring the production binding. */
const realFs: EmbeddedStateFs = {
  mkdir: (path, options) => mkdir(path, options),
  chmod: (path, mode) => chmod(path, mode),
  readFile: (path) => readFileReal(path, 'utf8'),
  writeFile: (path, data, options) => writeFileReal(path, data, options),
  rename: renameReal,
  unlink: unlinkReal,
};

function validState(): PersistedEmbeddedState {
  const state = defaultEmbeddedState();
  return {
    ...state,
    installedVersion: '0.84.1',
    latestVersion: '0.85.0',
    verifiedVersion: '0.84.1',
    verificationLevel: 'deterministic_only',
    status: 'available',
    lastCheckAt: 1000,
    lastPromotionAttemptAt: 900,
    lastPromotionResult: 'gate failed',
    lastRecoveryAttemptAt: null,
    lastRecoveryResult: null,
  };
}

describe('parseEmbeddedState', () => {
  it('accepts a valid persisted state and canonicalizes exact versions', () => {
    const parsed = parseEmbeddedState(JSON.stringify(validState()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.state.latestVersion).toBe('0.85.0');
      expect(parsed.state.verificationLevel).toBe('deterministic_only');
      expect(parsed.state.status).toBe('available');
      expect(parsed.state.lastPromotionResult).toBe('gate failed');
    }
  });

  it('accepts null optional fields', () => {
    const parsed = parseEmbeddedState(JSON.stringify(defaultEmbeddedState()));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state.status).toBe('unknown');
  });

  it('rejects non-JSON and non-object roots', () => {
    expect(parseEmbeddedState('not json').ok).toBe(false);
    expect(parseEmbeddedState('[]').ok).toBe(false);
    expect(parseEmbeddedState('"str"').ok).toBe(false);
  });

  it('rejects an unsupported schema version', () => {
    const parsed = parseEmbeddedState(JSON.stringify({ ...validState(), schemaVersion: 2 }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain('schema version');
  });

  it('rejects invalid status and verification-level values', () => {
    const badStatus = parseEmbeddedState(JSON.stringify({ ...validState(), status: 'promoting' }));
    expect(badStatus.ok).toBe(false);
    const badLevel = parseEmbeddedState(JSON.stringify({ ...validState(), verificationLevel: 'partial' }));
    expect(badLevel.ok).toBe(false);
  });

  it('rejects non-exact or non-string versions', () => {
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), latestVersion: '^0.85.0' })).ok).toBe(false);
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), installedVersion: 0.84 })).ok).toBe(false);
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), verifiedVersion: 'nightly' })).ok).toBe(false);
  });

  it('rejects non-finite timestamps and non-string results', () => {
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), lastCheckAt: 'later' })).ok).toBe(false);
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), lastPromotionResult: 7 })).ok).toBe(false);
    // 1e999 parses to Infinity (JSON has no NaN/Infinity literal), so only a
    // raw string can carry a non-finite timestamp onto the validator.
    const raw = JSON.stringify(validState()).replace('"lastCheckAt":1000', '"lastCheckAt":1e999');
    expect(parseEmbeddedState(raw).ok).toBe(false);
  });

  it('rejects negative epoch-ms timestamps', () => {
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), lastCheckAt: -1 })).ok).toBe(false);
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), lastPromotionAttemptAt: -1 })).ok).toBe(false);
    expect(parseEmbeddedState(JSON.stringify({ ...validState(), lastRecoveryAttemptAt: -1 })).ok).toBe(false);
  });
});

describe('loadEmbeddedState', () => {
  it('reports absent when no state file exists and fails closed to the default', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-load-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    const loaded = await loadEmbeddedState(stateDir, realFs);
    expect(loaded.kind).toBe('absent');
    await rm(base, { recursive: true, force: true });
  });

  it('reports invalid on corrupt content without throwing', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-corrupt-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    await writeFileReal(join(stateDir, EMBEDDED_STATE_FILE), '{ broken', { mode: 0o600 });
    const loaded = await loadEmbeddedState(stateDir, realFs);
    expect(loaded.kind).toBe('invalid');
    if (loaded.kind === 'invalid') expect(loaded.reason).toContain('JSON');
    await rm(base, { recursive: true, force: true });
  });

  it('loads a valid persisted state written by an external CLI', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-valid-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    await saveEmbeddedState(stateDir, realFs, validState());
    const loaded = await loadEmbeddedState(stateDir, realFs);
    expect(loaded.kind).toBe('loaded');
    if (loaded.kind === 'loaded') {
      expect(loaded.state.status).toBe('available');
      expect(loaded.state.verifiedVersion).toBe('0.84.1');
    }
    await rm(base, { recursive: true, force: true });
  });

  it('normalizes a stale persisted checking status to unknown on load', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-checking-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    await saveEmbeddedState(stateDir, realFs, { ...validState(), status: 'checking' });
    const loaded = await loadEmbeddedState(stateDir, realFs);
    expect(loaded.kind).toBe('loaded');
    if (loaded.kind === 'loaded') expect(loaded.state.status).toBe('unknown');
    await rm(base, { recursive: true, force: true });
  });
});

describe('saveEmbeddedState', () => {
  it('writes atomically with private mode and leaves no staging files', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-save-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    await saveEmbeddedState(stateDir, realFs, validState());
    const path = join(stateDir, EMBEDDED_STATE_FILE);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const parsed = parseEmbeddedState(await readFileReal(path, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.state.latestVersion).toBe('0.85.0');
    // no staging files survive a successful save
    const entries = await readdir(stateDir);
    expect(entries.filter((entry) => entry.startsWith('pending-state-'))).toEqual([]);
    // a second save overwrites atomically
    await saveEmbeddedState(stateDir, realFs, { ...validState(), latestVersion: '0.86.0' });
    const reloaded = parseEmbeddedState(await readFileReal(path, 'utf8'));
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.state.latestVersion).toBe('0.86.0');
    await rm(base, { recursive: true, force: true });
  });

  it('propagates write errors and leaves no staging files behind', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-fail-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    const broken: EmbeddedStateFs = {
      ...realFs,
      rename: () => Promise.reject(new Error('rename failed')),
    };
    await expect(saveEmbeddedState(stateDir, broken, validState())).rejects.toThrow('rename failed');
    const entries = await readdir(stateDir);
    expect(entries.filter((entry) => entry.startsWith('pending-state-'))).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });

  it('rejects any state parseEmbeddedState would reject, without publishing or overwriting last-good state', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-reject-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    await saveEmbeddedState(stateDir, realFs, validState());
    // each invalid field must be refused — never staged, never renamed over the good file
    await expect(
      saveEmbeddedState(stateDir, realFs, { ...validState(), installedVersion: '^0.84.1' }),
    ).rejects.toThrow('invalid');
    await expect(
      saveEmbeddedState(stateDir, realFs, { ...validState(), latestVersion: '0.85.0-beta.1' }),
    ).rejects.toThrow('invalid');
    await expect(
      saveEmbeddedState(stateDir, realFs, { ...validState(), lastCheckAt: 'later' } as unknown as PersistedEmbeddedState),
    ).rejects.toThrow('invalid');
    await expect(
      saveEmbeddedState(stateDir, realFs, { ...validState(), lastPromotionAttemptAt: 'later' } as unknown as PersistedEmbeddedState),
    ).rejects.toThrow('invalid');
    await expect(
      saveEmbeddedState(stateDir, realFs, { ...validState(), status: 'promoting' } as unknown as PersistedEmbeddedState),
    ).rejects.toThrow('invalid');
    await expect(
      saveEmbeddedState(stateDir, realFs, { ...validState(), verificationLevel: 'partial' } as unknown as PersistedEmbeddedState),
    ).rejects.toThrow('invalid');
    // the last-good state is intact and no staging files were left behind
    const loaded = await loadEmbeddedState(stateDir, realFs);
    expect(loaded.kind).toBe('loaded');
    if (loaded.kind === 'loaded') {
      expect(loaded.state.latestVersion).toBe('0.85.0');
      expect(loaded.state.status).toBe('available');
    }
    const entries = await readdir(stateDir);
    expect(entries.filter((entry) => entry.startsWith('pending-state-'))).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });

  it('rejects NaN, ±Infinity, and negative timestamps before any write, leaving last-good untouched', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fo-embedded-nonfinite-'));
    const stateDir = join(base, 'state');
    await ensureStateDir(stateDir, realFs);
    await saveEmbeddedState(stateDir, realFs, validState());
    // Non-finite numbers survive the typed in-memory state but not
    // JSON.stringify (they would silently become null) — the writer must
    // refuse them before serializing, never publish null in their place.
    const invalid = [NaN, Infinity, -Infinity, -1] as const;
    for (const field of ['lastCheckAt', 'lastPromotionAttemptAt', 'lastRecoveryAttemptAt'] as const) {
      for (const timestamp of invalid) {
        await expect(
          saveEmbeddedState(stateDir, realFs, { ...validState(), [field]: timestamp }),
        ).rejects.toThrow('invalid');
      }
    }
    // the last-good state is intact and nothing was staged or renamed
    const loaded = await loadEmbeddedState(stateDir, realFs);
    expect(loaded.kind).toBe('loaded');
    if (loaded.kind === 'loaded') {
      expect(loaded.state.lastCheckAt).toBe(1000);
      expect(loaded.state.lastPromotionAttemptAt).toBe(900);
      expect(loaded.state.lastRecoveryAttemptAt).toBeNull();
    }
    const entries = await readdir(stateDir);
    expect(entries.filter((entry) => entry.startsWith('pending-state-'))).toEqual([]);
    await rm(base, { recursive: true, force: true });
  });
});

describe('persistedOf / embeddedInfoOf round-trip', () => {
  it('adds and strips the schema version without losing fields', () => {
    const persisted = persistedOf({
      installedVersion: '0.84.1',
      latestVersion: '0.85.0',
      verifiedVersion: null,
      verificationLevel: 'unknown',
      status: 'available',
      lastCheckAt: 5,
      lastPromotionAttemptAt: null,
      lastPromotionResult: null,
      lastRecoveryAttemptAt: null,
      lastRecoveryResult: null,
    });
    expect(persisted.schemaVersion).toBe(1);
    expect(embeddedInfoOf(persisted)).toEqual({
      installedVersion: '0.84.1',
      latestVersion: '0.85.0',
      verifiedVersion: null,
      verificationLevel: 'unknown',
      status: 'available',
      lastCheckAt: 5,
      lastPromotionAttemptAt: null,
      lastPromotionResult: null,
      lastRecoveryAttemptAt: null,
      lastRecoveryResult: null,
    });
  });
});
