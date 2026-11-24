/**
 * Pure exact-stable semver core for embedded-SDK upkeep.
 *
 * The embedded-baseline validator and the stable-latest evaluator agree on
 * one notion of an exact version: `major.minor.patch` with no leading `v`,
 * no prerelease, and no build metadata. Ranges, tags, and anything else are
 * not exact versions and can never be promoted or treated as a verified pin.
 */

export interface StableVersion {
  major: number;
  minor: number;
  patch: number;
}

// Semver numeric form: `0` or a nonzero-leading digit sequence. Leading zeros
// and unsafe (non-safe-integer) components are not exact versions — they are
// rejected, never canonically rewritten.
const EXACT_STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Parses an exact stable `x.y.z` version, or null when it is not one. */
export function parseExactStableVersion(version: string): StableVersion | null {
  const match = EXACT_STABLE.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]!);
  const minor = Number(match[2]!);
  const patch = Number(match[3]!);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * The canonical exact-stable form of a version string, or null when it is
 * not exact stable. Surrounding whitespace (a trailing newline from CLI
 * output) is tolerated.
 */
export function exactStableString(version: string): string | null {
  const parsed = parseExactStableVersion(version);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Numeric comparison of two exact stable versions: -1, 0, or 1, or null when
 * either side is not exact stable. Numeric, never lexicographic:
 * `0.84.10` sorts after `0.84.9`.
 */
export function compareStableVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseExactStableVersion(a);
  const pb = parseExactStableVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}
