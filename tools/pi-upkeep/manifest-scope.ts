/**
 * Pure manifest-scope validation.
 *
 * A candidate promotion may change only the exact direct SDK dependency in
 * package.json; in package-lock.json the root declaration may change only the
 * SDK and every changed package entry must lie inside the old-or-new SDK
 * transitive dependency closure resolved through lockfile `node_modules`
 * rules. These validators are pure: raw manifest bytes in, typed verdict
 * out — they never touch the filesystem, the package manager, or the
 * registry. The engine rejects unrelated lock changes before any gate runs.
 */

import { recordOf } from './records.ts';

export type ManifestScopeIssue =
  | { code: 'package_json_unparseable' }
  | { code: 'package_json_sdk_not_exact'; expected: string; actual: string | null }
  | { code: 'package_json_other_change'; detail: string }
  | { code: 'lock_unparseable' }
  | { code: 'lock_root_sdk_not_exact'; expected: string; actual: string | null }
  | { code: 'lock_root_other_change'; detail: string }
  | { code: 'lock_change_outside_closure'; entry: string };

export type ManifestScopeResult =
  | { kind: 'ok' }
  | { kind: 'reject'; issues: ManifestScopeIssue[] };

/**
 * Validates that a candidate package.json differs from the original only in
 * the direct SDK dependency, which must be declared as exactly the candidate
 * version (npm's `--save-exact` contract — never a range).
 */
export function validatePackageJsonScope(
  oldRaw: string,
  newRaw: string,
  sdk: string,
  candidate: string,
): ManifestScopeResult {
  const oldPkg = parseRecord(oldRaw);
  const newPkg = parseRecord(newRaw);
  if (oldPkg === null || newPkg === null) {
    return { kind: 'reject', issues: [{ code: 'package_json_unparseable' }] };
  }
  const oldDeps = recordOf(oldPkg['dependencies']) ?? {};
  const newDeps = recordOf(newPkg['dependencies']) ?? {};
  const actual = newDeps[sdk];
  if (typeof actual !== 'string' || actual !== candidate) {
    return {
      kind: 'reject',
      issues: [
        {
          code: 'package_json_sdk_not_exact',
          expected: candidate,
          actual: typeof actual === 'string' ? actual : null,
        },
      ],
    };
  }
  // Everything except dependencies[sdk] must be identical: substitute the new
  // SDK declaration into the old manifest and require canonical equality.
  const adjustedOld: Record<string, unknown> = { ...oldPkg, dependencies: { ...oldDeps, [sdk]: actual } };
  const changed = describePackageJsonDifference(adjustedOld, newPkg);
  if (changed !== null) {
    return { kind: 'reject', issues: [{ code: 'package_json_other_change', detail: changed }] };
  }
  return { kind: 'ok' };
}

/**
 * Validates that a candidate package-lock.json differs from the original only
 * in (a) the root `packages['']` SDK declaration — which must be exactly the
 * candidate — and (b) package entries inside the old-or-new SDK transitive
 * dependency closure.
 */
export function validateLockScope(
  oldRaw: string,
  newRaw: string,
  sdk: string,
  candidate: string,
): ManifestScopeResult {
  const oldLock = parseRecord(oldRaw);
  const newLock = parseRecord(newRaw);
  if (oldLock === null || newLock === null) {
    return { kind: 'reject', issues: [{ code: 'lock_unparseable' }] };
  }
  const oldPackages = recordOf(oldLock['packages']);
  const newPackages = recordOf(newLock['packages']);
  if (oldPackages === null || newPackages === null) {
    return { kind: 'reject', issues: [{ code: 'lock_unparseable' }] };
  }
  const oldRoot = recordOf(oldPackages['']);
  const newRoot = recordOf(newPackages['']);
  if (oldRoot === null || newRoot === null) {
    return { kind: 'reject', issues: [{ code: 'lock_unparseable' }] };
  }
  const newRootDeps = recordOf(newRoot['dependencies']) ?? {};
  const actual = newRootDeps[sdk];
  if (typeof actual !== 'string' || actual !== candidate) {
    return {
      kind: 'reject',
      issues: [
        {
          code: 'lock_root_sdk_not_exact',
          expected: candidate,
          actual: typeof actual === 'string' ? actual : null,
        },
      ],
    };
  }
  // The root node may change only its SDK dependency.
  const adjustedOldRoot: Record<string, unknown> = {
    ...oldRoot,
    dependencies: { ...(recordOf(oldRoot['dependencies']) ?? {}), [sdk]: actual },
  };
  const rootChanged = firstDifference(adjustedOldRoot, newRoot);
  if (rootChanged !== null) {
    const detail =
      rootChanged === 'dependencies'
        ? 'root dependencies beyond the SDK differ'
        : `root field ${rootChanged} differs`;
    return { kind: 'reject', issues: [{ code: 'lock_root_other_change', detail }] };
  }

  // The SDK itself is a direct dependency: its installed entry must exist in
  // the candidate lock. Its disappearance is an out-of-scope lock change.
  if (!Object.prototype.hasOwnProperty.call(newPackages, `node_modules/${sdk}`)) {
    return {
      kind: 'reject',
      issues: [{ code: 'lock_change_outside_closure', entry: `node_modules/${sdk}` }],
    };
  }

  // Every added, removed, or changed package entry must be inside the
  // old-or-new SDK closure; anything else is an unrelated lock change.
  const union = new Set([
    ...sdkDependencyClosure(oldPackages, sdk),
    ...sdkDependencyClosure(newPackages, sdk),
  ]);
  const issues: ManifestScopeIssue[] = [];
  const allKeys = new Set([...Object.keys(oldPackages), ...Object.keys(newPackages)]);
  for (const key of allKeys) {
    if (key === '') continue;
    const oldEntry = oldPackages[key];
    const newEntry = newPackages[key];
    const removed = oldEntry !== undefined && newEntry === undefined;
    const added = oldEntry === undefined && newEntry !== undefined;
    const changed =
      oldEntry !== undefined && newEntry !== undefined && canonicalJson(oldEntry) !== canonicalJson(newEntry);
    if ((removed || added || changed) && !union.has(key)) {
      issues.push({ code: 'lock_change_outside_closure', entry: key });
    }
  }
  return issues.length > 0 ? { kind: 'reject', issues } : { kind: 'ok' };
}

/**
 * The SDK's transitive dependency closure through one lockfile's `packages`
 * map, resolved by real npm `node_modules` rules: a package at an entry path
 * resolves each dependency to the closest `.../node_modules/<name>` walking
 * up from its own directory. Includes the SDK entry itself and follows
 * `dependencies` and `optionalDependencies`.
 */
export function sdkDependencyClosure(packages: Record<string, unknown>, sdk: string): Set<string> {
  const closure = new Set<string>();
  const stack: string[] = [`node_modules/${sdk}`];
  while (stack.length > 0) {
    const entryPath = stack.pop()!;
    if (closure.has(entryPath)) continue;
    const entry = recordOf(packages[entryPath]);
    if (entry === null) continue;
    closure.add(entryPath);
    for (const field of ['dependencies', 'optionalDependencies']) {
      const dependencies = recordOf(entry[field]);
      if (dependencies === null) continue;
      for (const name of Object.keys(dependencies)) {
        const resolved = resolveDependencyPath(packages, entryPath, name);
        if (resolved !== null) stack.push(resolved);
      }
    }
  }
  return closure;
}

/** Walks up from `entryPath` looking for the nearest `node_modules/<name>`. */
function resolveDependencyPath(
  packages: Record<string, unknown>,
  entryPath: string,
  name: string,
): string | null {
  // Real npm node_modules resolution: probe `entryPath/node_modules/<name>`, then
  // each ancestor's `node_modules/<name>`, ending at the bare root entry. Walking
  // up through `node_modules/@scope/pkg` must terminate with `node_modules/<name>`,
  // never `node_modules/node_modules/<name>`.
  let dir = entryPath;
  for (;;) {
    const candidate = dir === 'node_modules' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    const index = dir.lastIndexOf('/');
    if (index < 0) break;
    dir = dir.slice(0, index);
  }
  return null;
}

/** The first differing top-level key between two records, or null. */
function firstDifference(a: Record<string, unknown>, b: Record<string, unknown>): string | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (canonicalJson(a[key]) !== canonicalJson(b[key])) return key;
  }
  return null;
}

/** Human description of where a package.json differs from the SDK-only change. */
function describePackageJsonDifference(
  adjustedOld: Record<string, unknown>,
  newPkg: Record<string, unknown>,
): string | null {
  const changed = firstDifference(adjustedOld, newPkg);
  if (changed === null) return null;
  if (changed === 'dependencies') {
    const oldDeps = recordOf(adjustedOld['dependencies']) ?? {};
    const newDeps = recordOf(newPkg['dependencies']) ?? {};
    const depChanged = firstDifference(oldDeps, newDeps);
    if (depChanged !== null) return `dependency ${depChanged} differs`;
  }
  return `top-level field ${changed} differs`;
}

/** Recursively key-sorted stable serialization; `undefined` is preserved. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value)) ?? 'undefined';
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortDeep(entry));
  const record = recordOf(value);
  if (record === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = sortDeep(record[key]);
  return sorted;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    return recordOf(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
