/**
 * Pure manifest-scope validation tests (test-first).
 *
 * A candidate promotion may change only the exact direct SDK dependency in
 * package.json; in package-lock.json the root declaration may change only the
 * SDK and every changed package entry must lie inside the old-or-new SDK
 * transitive dependency closure resolved through lockfile node_modules rules.
 * These validators are pure: raw manifest bytes in, typed verdict out.
 */

import { describe, expect, it } from 'vitest';
import {
  sdkDependencyClosure,
  validateLockScope,
  validatePackageJsonScope,
} from './manifest-scope.ts';

const SDK = '@earendil-works/pi-coding-agent';
const INSTALLED = '0.84.1';
const CANDIDATE = '0.85.0';

const OLD_PACKAGE_JSON = JSON.stringify({
  name: 'funkyoctopus',
  version: '0.1.0',
  dependencies: { [SDK]: INSTALLED, 'left-pad': '^1.3.0' },
});

function lockWith(packages: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'funkyoctopus',
    lockfileVersion: 3,
    packages: {
      '': { name: 'funkyoctopus', dependencies: { [SDK]: INSTALLED } },
      ...packages,
    },
  });
}

const OLD_LOCK = lockWith({
  [`node_modules/${SDK}`]: { version: INSTALLED, dependencies: { 'dep-a': '^1.0.0' } },
  'node_modules/dep-a': { version: '1.2.0' },
});

/** The same lock with the SDK promoted: root + SDK entry + closure only. */
function candidateLockWith(packages: Record<string, unknown>): string {
  return JSON.stringify({
    name: 'funkyoctopus',
    lockfileVersion: 3,
    packages: {
      '': { name: 'funkyoctopus', dependencies: { [SDK]: CANDIDATE } },
      ...packages,
    },
  });
}

const CANDIDATE_LOCK = candidateLockWith({
  [`node_modules/${SDK}`]: { version: CANDIDATE, dependencies: { 'dep-a': '^1.0.0' } },
  'node_modules/dep-a': { version: '1.2.0' },
});

describe('validatePackageJsonScope', () => {
  it('accepts a change of only the exact direct SDK dependency', () => {
    const candidate = JSON.stringify({
      name: 'funkyoctopus',
      version: '0.1.0',
      dependencies: { [SDK]: CANDIDATE, 'left-pad': '^1.3.0' },
    });
    expect(validatePackageJsonScope(OLD_PACKAGE_JSON, candidate, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
  });

  it('accepts when the old manifest had no dependencies key at all', () => {
    const oldPkg = JSON.stringify({ name: 'funkyoctopus' });
    const candidate = JSON.stringify({ name: 'funkyoctopus', dependencies: { [SDK]: CANDIDATE } });
    expect(validatePackageJsonScope(oldPkg, candidate, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
  });

  it('rejects a non-exact candidate declaration', () => {
    for (const declared of ['^0.85.0', '0.85.1', '~0.85.0', 'latest']) {
      const candidate = JSON.stringify({
        name: 'funkyoctopus',
        version: '0.1.0',
        dependencies: { [SDK]: declared, 'left-pad': '^1.3.0' },
      });
      const result = validatePackageJsonScope(OLD_PACKAGE_JSON, candidate, SDK, CANDIDATE);
      expect(result.kind).toBe('reject');
      if (result.kind === 'reject') {
        expect(result.issues).toContainEqual({
          code: 'package_json_sdk_not_exact',
          expected: CANDIDATE,
          actual: declared,
        });
      }
    }
  });

  it('rejects when the SDK dependency is missing entirely', () => {
    const candidate = JSON.stringify({ name: 'funkyoctopus', version: '0.1.0', dependencies: { 'left-pad': '^1.3.0' } });
    const result = validatePackageJsonScope(OLD_PACKAGE_JSON, candidate, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'package_json_sdk_not_exact', expected: CANDIDATE, actual: null });
    }
  });

  it('rejects when another dependency changed', () => {
    const candidate = JSON.stringify({
      name: 'funkyoctopus',
      version: '0.1.0',
      dependencies: { [SDK]: CANDIDATE, 'left-pad': '^2.0.0' },
    });
    const result = validatePackageJsonScope(OLD_PACKAGE_JSON, candidate, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'package_json_other_change', detail: expect.stringContaining('left-pad') });
    }
  });

  it('rejects when a non-dependency field changed', () => {
    const candidate = JSON.stringify({
      name: 'funkyoctopus',
      version: '0.1.0',
      scripts: { build: 'tsc -b && vite build' },
      dependencies: { [SDK]: CANDIDATE, 'left-pad': '^1.3.0' },
    });
    const result = validatePackageJsonScope(OLD_PACKAGE_JSON, candidate, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'package_json_other_change', detail: expect.stringContaining('scripts') });
    }
  });

  it('rejects unparseable input', () => {
    const result = validatePackageJsonScope('not json', OLD_PACKAGE_JSON, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'package_json_unparseable' });
    }
  });
});

describe('validateLockScope', () => {
  it('accepts a root declaration change plus SDK closure changes only', () => {
    expect(validateLockScope(OLD_LOCK, CANDIDATE_LOCK, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
  });

  it('accepts nested transitive entries inside the SDK closure', () => {
    const oldLock = lockWith({
      [`node_modules/${SDK}`]: { version: INSTALLED, dependencies: { 'dep-a': '^2.0.0' } },
      [`node_modules/${SDK}/node_modules/dep-a`]: { version: '2.0.0', dependencies: { 'dep-b': '^1.0.0' } },
      'node_modules/dep-b': { version: '1.0.0' },
    });
    const newLock = candidateLockWith({
      [`node_modules/${SDK}`]: { version: CANDIDATE, dependencies: { 'dep-a': '^2.0.0' } },
      [`node_modules/${SDK}/node_modules/dep-a`]: { version: '2.1.0', dependencies: { 'dep-b': '^1.0.0' } },
      'node_modules/dep-b': { version: '1.0.0' },
    });
    expect(validateLockScope(oldLock, newLock, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
  });

  it('rejects a changed entry outside the old-or-new closure', () => {
    const newLock = candidateLockWith({
      [`node_modules/${SDK}`]: { version: CANDIDATE, dependencies: { 'dep-a': '^1.0.0' } },
      'node_modules/dep-a': { version: '1.2.0' },
      'node_modules/unrelated': { version: '9.9.9' },
    });
    const result = validateLockScope(OLD_LOCK, newLock, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'lock_change_outside_closure', entry: 'node_modules/unrelated' });
    }
  });

  it('rejects a removed entry outside the closure', () => {
    const oldLock = lockWith({
      [`node_modules/${SDK}`]: { version: INSTALLED },
      'node_modules/dep-a': { version: '1.2.0' },
      'node_modules/vanished': { version: '1.0.0' },
    });
    const newLock = candidateLockWith({
      [`node_modules/${SDK}`]: { version: CANDIDATE },
      'node_modules/dep-a': { version: '1.2.0' },
    });
    const result = validateLockScope(oldLock, newLock, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'lock_change_outside_closure', entry: 'node_modules/vanished' });
    }
  });

  it('accepts a removed entry inside the old closure (SDK dependency pruned)', () => {
    const oldLock = lockWith({
      [`node_modules/${SDK}`]: { version: INSTALLED, dependencies: { 'dep-a': '^1.0.0' } },
      'node_modules/dep-a': { version: '1.2.0' },
    });
    const newLock = candidateLockWith({
      [`node_modules/${SDK}`]: { version: CANDIDATE },
    });
    expect(validateLockScope(oldLock, newLock, SDK, CANDIDATE)).toEqual({ kind: 'ok' });
  });

  it('rejects when the root SDK declaration is not the exact candidate', () => {
    const newLock = JSON.stringify({
      name: 'funkyoctopus',
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus', dependencies: { [SDK]: '^0.85.0' } },
        [`node_modules/${SDK}`]: { version: CANDIDATE },
      },
    });
    const result = validateLockScope(OLD_LOCK, newLock, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({
        code: 'lock_root_sdk_not_exact',
        expected: CANDIDATE,
        actual: '^0.85.0',
      });
    }
  });

  it('rejects when a non-SDK root declaration changed', () => {
    const newLock = JSON.stringify({
      name: 'funkyoctopus',
      lockfileVersion: 3,
      packages: {
        '': { name: 'funkyoctopus', dependencies: { [SDK]: CANDIDATE }, devDependencies: { 'eslint': '^9.0.0' } },
        [`node_modules/${SDK}`]: { version: CANDIDATE },
      },
    });
    const result = validateLockScope(OLD_LOCK, newLock, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'lock_root_other_change', detail: expect.stringContaining('devDependencies') });
    }
  });

  it('rejects unparseable lock input', () => {
    const result = validateLockScope('garbage', CANDIDATE_LOCK, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'lock_unparseable' });
    }
  });

  it('rejects a lock whose packages map is missing or not an object', () => {
    const result = validateLockScope(JSON.stringify({ lockfileVersion: 3 }), CANDIDATE_LOCK, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues).toContainEqual({ code: 'lock_unparseable' });
    }
  });

  it('rejects when the SDK entry is absent from the candidate lock', () => {
    const newLock = candidateLockWith({ 'node_modules/dep-a': { version: '1.2.0' } });
    const result = validateLockScope(OLD_LOCK, newLock, SDK, CANDIDATE);
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') {
      expect(result.issues.some((issue) => issue.code === 'lock_change_outside_closure')).toBe(true);
    }
  });
});

describe('sdkDependencyClosure', () => {
  it('resolves hoisted and nested dependencies through lockfile node_modules rules', () => {
    const packages: Record<string, unknown> = {
      [`node_modules/${SDK}`]: { version: '0.85.0', dependencies: { 'dep-a': '^2.0.0', 'dep-b': '^1.0.0' } },
      [`node_modules/${SDK}/node_modules/dep-a`]: { version: '2.1.0', dependencies: { 'dep-c': '^1.0.0' } },
      'node_modules/dep-b': { version: '1.5.0' },
      'node_modules/dep-c': { version: '1.0.0' },
      'node_modules/unrelated': { version: '0.0.1' },
    };
    const closure = sdkDependencyClosure(packages, SDK);
    expect(closure.has(`node_modules/${SDK}`)).toBe(true);
    expect(closure.has(`node_modules/${SDK}/node_modules/dep-a`)).toBe(true);
    expect(closure.has('node_modules/dep-b')).toBe(true);
    expect(closure.has('node_modules/dep-c')).toBe(true);
    expect(closure.has('node_modules/unrelated')).toBe(false);
  });

  it('follows optionalDependencies too', () => {
    const packages: Record<string, unknown> = {
      [`node_modules/${SDK}`]: { version: '0.85.0', optionalDependencies: { 'dep-opt': '^1.0.0' } },
      'node_modules/dep-opt': { version: '1.0.0' },
    };
    expect(sdkDependencyClosure(packages, SDK).has('node_modules/dep-opt')).toBe(true);
  });

  it('does not resolve a missing dependency into the closure', () => {
    const packages: Record<string, unknown> = {
      [`node_modules/${SDK}`]: { version: '0.85.0', dependencies: { 'missing': '^1.0.0' } },
    };
    expect(sdkDependencyClosure(packages, SDK).size).toBe(1);
  });
});
