/**
 * Pure stable-latest evaluation.
 *
 * Promotion installs only the current stable npm `latest` dist-tag and
 * nothing else: V1 has no arbitrary `--version`, prerelease, downgrade, or
 * alternate dist-tag option. This module is pure — it decides from the raw
 * npm `latest` result string and the installed version, and never touches
 * the registry. A registry result alone never means a candidate was
 * accepted.
 */

import { compareStableVersions, exactStableString } from './versions.ts';

export type LatestDecision =
  | { kind: 'noop'; installed: string; latest: string }
  | { kind: 'promotable'; installed: string; candidate: string }
  | { kind: 'reject'; installed: string; raw: string | null; reason: string };

/**
 * Decides whether the npm `latest` result can promote the installed version.
 *
 * The raw result must be one exact stable `x.y.z`; prerelease, build
 * metadata, ranges, tags, and malformed output are rejected, never promoted.
 * Equality is a no-op and only a strictly greater exact stable version is
 * promotable; a downgrade is rejected.
 */
export function evaluateLatest(raw: string | null, installed: string): LatestDecision {
  if (raw === null) {
    return { kind: 'reject', installed, raw: null, reason: 'no latest result' };
  }
  const latest = exactStableString(raw);
  if (latest === null) {
    return {
      kind: 'reject',
      installed,
      raw,
      reason: `npm latest result is not an exact stable version: ${JSON.stringify(raw)}`,
    };
  }
  const comparison = compareStableVersions(installed, latest);
  if (comparison === null) {
    return {
      kind: 'reject',
      installed,
      raw,
      reason: `installed version is not an exact stable version: ${JSON.stringify(installed)}`,
    };
  }
  if (comparison === 0) {
    return { kind: 'noop', installed, latest };
  }
  if (comparison > 0) {
    return {
      kind: 'reject',
      installed,
      raw,
      reason: `latest ${latest} is a downgrade from installed ${installed}`,
    };
  }
  return { kind: 'promotable', installed, candidate: latest };
}
