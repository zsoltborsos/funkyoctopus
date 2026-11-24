/**
 * Pure exact-baseline validation.
 *
 * Promotion must not mutate a checkout whose package declaration, lockfile,
 * installed resolution, and `npm ls` do not all agree on one exact stable
 * SDK version. Validation here is pure: it takes already-parsed JSON (the
 * caller reads and parses the files) and returns either one agreed version
 * or a `needs_attention` issue list. It never repairs, guesses, or touches
 * the filesystem, registry, or package manager.
 */

import { exactStableString } from '../../server/src/upkeep/versions.ts';
import { recordOf } from './records.ts';

export type BaselineIssue =
  | { code: 'package_json_missing_dependency'; dependency: string }
  | { code: 'package_json_not_exact'; dependency: string; raw: string }
  | { code: 'package_lock_missing_dependency'; dependency: string }
  | { code: 'package_lock_not_exact'; dependency: string; raw: string }
  | { code: 'lockfile_installed_missing'; dependency: string }
  | { code: 'lockfile_installed_not_exact'; dependency: string; raw: string }
  | { code: 'version_agreement'; declared: string; lockfile: string; installed: string; npmLs: string }
  | { code: 'npm_ls_unparseable'; detail: string }
  | { code: 'npm_ls_sdk_missing'; dependency: string }
  | { code: 'npm_ls_version_mismatch'; dependency: string; expected: string; actual: string }
  | { code: 'npm_ls_problems'; problems: string[] };

export interface BaselineInput {
  /** Package name of the embedded SDK, e.g. `@earendil-works/pi-coding-agent`. */
  sdk: string;
  /** Parsed package.json. */
  packageJson: unknown;
  /** Parsed package-lock.json. */
  packageLock: unknown;
  /** Parsed `npm ls <sdk> --json` output. */
  npmLs: unknown;
}

export type BaselineResult =
  | { kind: 'ok'; version: string }
  | { kind: 'needs_attention'; issues: BaselineIssue[] };

/** One version field after extraction: absent, present but not exact, or exact. */
type VersionField =
  | { kind: 'absent' }
  | { kind: 'invalid'; raw: string }
  | { kind: 'exact'; version: string };

export function validateBaseline(input: BaselineInput): BaselineResult {
  const issues: BaselineIssue[] = [];
  const declared = declaredVersion(input);
  const lockfile = lockfileVersion(input);
  const installed = installedVersion(input);
  if (declared.kind === 'absent') {
    issues.push({ code: 'package_json_missing_dependency', dependency: input.sdk });
  } else if (declared.kind === 'invalid') {
    issues.push({ code: 'package_json_not_exact', dependency: input.sdk, raw: declared.raw });
  }
  if (lockfile.kind === 'absent') {
    issues.push({ code: 'package_lock_missing_dependency', dependency: input.sdk });
  } else if (lockfile.kind === 'invalid') {
    issues.push({ code: 'package_lock_not_exact', dependency: input.sdk, raw: lockfile.raw });
  }
  if (installed.kind === 'absent') {
    issues.push({ code: 'lockfile_installed_missing', dependency: input.sdk });
  } else if (installed.kind === 'invalid') {
    issues.push({ code: 'lockfile_installed_not_exact', dependency: input.sdk, raw: installed.raw });
  }

  const declaredExact = declared.kind === 'exact' ? declared.version : null;
  const lockfileExact = lockfile.kind === 'exact' ? lockfile.version : null;
  const installedExact = installed.kind === 'exact' ? installed.version : null;

  // npm ls must agree with the exact baseline. The expected version is the
  // first exact one found; when nothing is exact the agreement issue below
  // already explains the trouble.
  const expected = declaredExact ?? lockfileExact ?? installedExact;
  const npmLs = parseNpmLs(input.npmLs);
  if (npmLs.kind === 'unparseable') {
    issues.push({ code: 'npm_ls_unparseable', detail: npmLs.detail });
  } else {
    if (npmLs.tree.problems.length > 0) {
      issues.push({ code: 'npm_ls_problems', problems: npmLs.tree.problems });
    }
    const sdkNode = npmLs.tree.dependencies[input.sdk];
    if (sdkNode === undefined) {
      issues.push({ code: 'npm_ls_sdk_missing', dependency: input.sdk });
    } else if (expected !== null) {
      const actual = exactStableString(String(sdkNode.version));
      if (actual === null || actual !== expected) {
        issues.push({
          code: 'npm_ls_version_mismatch',
          dependency: input.sdk,
          expected,
          actual: String(sdkNode.version),
        });
      }
    }
  }

  // The three exact values must agree with each other.
  if (declaredExact !== null && lockfileExact !== null && installedExact !== null) {
    // In this branch `expected` equals `declaredExact` (the first exact one).
    if (declaredExact !== lockfileExact || lockfileExact !== installedExact || installedExact !== expected) {
      issues.push({
        code: 'version_agreement',
        declared: declaredExact,
        lockfile: lockfileExact,
        installed: installedExact,
        npmLs: declaredExact,
      });
    }
  }

  if (issues.length > 0) return { kind: 'needs_attention', issues };
  if (declaredExact !== null) return { kind: 'ok', version: declaredExact };
  // Unreachable: at least one field is missing or invalid whenever no exact
  // declared version exists, so issues is non-empty above.
  return { kind: 'needs_attention', issues };
}

function declaredVersion(input: BaselineInput): VersionField {
  const root = recordOf(input.packageJson);
  if (root === null) return { kind: 'absent' };
  const dependencies = recordOf(root['dependencies']);
  if (dependencies === null) return { kind: 'absent' };
  return versionFieldOf(dependencies[input.sdk]);
}

function lockfileVersion(input: BaselineInput): VersionField {
  const root = recordOf(input.packageLock);
  if (root === null) return { kind: 'absent' };
  const packages = recordOf(root['packages']);
  if (packages === null) return { kind: 'absent' };
  const rootPackage = recordOf(packages['']);
  if (rootPackage === null) return { kind: 'absent' };
  const dependencies = recordOf(rootPackage['dependencies']);
  if (dependencies === null) return { kind: 'absent' };
  return versionFieldOf(dependencies[input.sdk]);
}

function installedVersion(input: BaselineInput): VersionField {
  const root = recordOf(input.packageLock);
  if (root === null) return { kind: 'absent' };
  const packages = recordOf(root['packages']);
  if (packages === null) return { kind: 'absent' };
  const sdkPackage = recordOf(packages[`node_modules/${input.sdk}`]);
  if (sdkPackage === null) return { kind: 'absent' };
  return versionFieldOf(sdkPackage['version']);
}

function versionFieldOf(value: unknown): VersionField {
  if (typeof value !== 'string') {
    return value === undefined ? { kind: 'absent' } : { kind: 'invalid', raw: stringifyField(value) };
  }
  const exact = exactStableString(value);
  return exact === null ? { kind: 'invalid', raw: value } : { kind: 'exact', version: exact };
}

function stringifyField(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface NpmLsTree {
  problems: string[];
  dependencies: Record<string, { version?: unknown; problems?: unknown }>;
}

type ParsedNpmLs = { kind: 'unparseable'; detail: string } | { kind: 'tree'; tree: NpmLsTree };

function parseNpmLs(npmLs: unknown): ParsedNpmLs {
  const root = recordOf(npmLs);
  if (root === null) return { kind: 'unparseable', detail: 'npm ls result is not an object' };
  const rootProblems = stringArrayOf(root['problems']);
  if (rootProblems === null) return { kind: 'unparseable', detail: 'npm ls problems field is not a string array' };
  const dependenciesValue = root['dependencies'];
  if (dependenciesValue === undefined) {
    return { kind: 'tree', tree: { problems: rootProblems, dependencies: {} } };
  }
  const dependencies = recordOf(dependenciesValue);
  if (dependencies === null) return { kind: 'unparseable', detail: 'npm ls dependencies field is not an object' };
  // npm ls reports a broken tree through root problems; a dependency node may
  // carry its own problems too. Both are evidence of a tree that cannot be a
  // verified baseline.
  const problems = [...rootProblems];
  const sdkNodes: Record<string, { version?: unknown; problems?: unknown }> = {};
  for (const [name, node] of Object.entries(dependencies)) {
    const parsed = recordOf(node) ?? {};
    sdkNodes[name] = { version: parsed['version'], problems: parsed['problems'] };
    const nodeProblems = stringArrayOf(parsed['problems']);
    if (nodeProblems !== null) problems.push(...nodeProblems);
  }
  return { kind: 'tree', tree: { problems, dependencies: sdkNodes } };
}

function stringArrayOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    strings.push(entry);
  }
  return strings;
}
