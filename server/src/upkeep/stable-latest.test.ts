import { describe, expect, it } from 'vitest';
import { compareStableVersions, exactStableString, parseExactStableVersion } from './versions.ts';
import { evaluateLatest } from './stable-latest.ts';

describe('exact stable version core', () => {
  it('parses exact x.y.z versions', () => {
    expect(parseExactStableVersion('0.84.1')).toEqual({ major: 0, minor: 84, patch: 1 });
    expect(exactStableString('0.85.0')).toBe('0.85.0');
  });

  it('rejects ranges, prereleases, build metadata, v-prefixes, and malformed input', () => {
    for (const bad of ['^0.84.1', '~0.84.1', '0.84.1-beta.1', '0.84.1+linux', 'v0.84.1', '0.84', '0.84.1.2', 'latest', '']) {
      expect(parseExactStableVersion(bad)).toBeNull();
      expect(exactStableString(bad)).toBeNull();
    }
  });

  it('tolerates surrounding whitespace from CLI output', () => {
    expect(exactStableString('0.85.0\n')).toBe('0.85.0');
    expect(exactStableString('  0.84.1  ')).toBe('0.84.1');
  });

  it('compares numerically, never lexicographically', () => {
    expect(compareStableVersions('0.84.10', '0.84.9')).toBe(1);
    expect(compareStableVersions('0.84.9', '0.84.10')).toBe(-1);
    expect(compareStableVersions('0.84.1', '0.84.1')).toBe(0);
    expect(compareStableVersions('0.85.0', '0.84.1')).toBe(1);
  });

  it('returns null when either side is not exact stable', () => {
    expect(compareStableVersions('^0.85.0', '0.84.1')).toBeNull();
    expect(compareStableVersions('0.85.0', '0.84.1-beta')).toBeNull();
  });
});

describe('evaluateLatest', () => {
  it('promotes only a strictly greater exact stable version', () => {
    expect(evaluateLatest('0.85.0', '0.84.1')).toEqual({
      kind: 'promotable',
      installed: '0.84.1',
      candidate: '0.85.0',
    });
  });

  it('treats equality as a no-op', () => {
    expect(evaluateLatest('0.84.1', '0.84.1')).toEqual({
      kind: 'noop',
      installed: '0.84.1',
      latest: '0.84.1',
    });
  });

  it('rejects a downgrade even though the latest tag is exact stable', () => {
    const decision = evaluateLatest('0.83.0', '0.84.1');
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') expect(decision.reason).toContain('downgrade');
  });

  it('rejects prerelease and build-metadata latest tags', () => {
    for (const raw of ['0.85.0-beta.1', '0.85.0+build']) {
      const decision = evaluateLatest(raw, '0.84.1');
      expect(decision.kind).toBe('reject');
      if (decision.kind === 'reject') expect(decision.reason).toContain('not an exact stable version');
    }
  });

  it('rejects ranges, tags, and malformed output as latest', () => {
    for (const raw of ['^0.85.0', '~0.85.0', 'latest', 'v0.85.0', '0.85', '0.85.0.1', '']) {
      expect(evaluateLatest(raw, '0.84.1').kind).toBe('reject');
    }
  });

  it('rejects a missing latest result', () => {
    const decision = evaluateLatest(null, '0.84.1');
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') expect(decision.reason).toContain('no latest result');
  });

  it('rejects when the installed version itself is not exact stable', () => {
    const decision = evaluateLatest('0.85.0', '^0.84.1');
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') expect(decision.reason).toContain('installed version');
  });

  it('rejects leading-zero and unsafe-precision versions in latest and installed', () => {
    expect(evaluateLatest('0.84.01', '0.84.1').kind).toBe('reject');
    expect(evaluateLatest('0.85.0', '0.84.01').kind).toBe('reject');
    expect(evaluateLatest('0.9007199254740992.0', '0.84.1').kind).toBe('reject');
    expect(evaluateLatest('999999999999999999999999999999.0.0', '0.84.1').kind).toBe('reject');
  });

  it('accepts trailing newline from real npm output', () => {
    expect(evaluateLatest('0.85.0\n', '0.84.1').kind).toBe('promotable');
  });
});
