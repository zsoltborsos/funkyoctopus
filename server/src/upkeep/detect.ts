/**
 * Production stable-latest reader for embedded-SDK detection.
 *
 * Detection reads npm's stable `latest` dist-tag for the embedded SDK through
 * the bounded injectable command-runner seam. The production binding never
 * runs in default tests — tests inject a fake `readStableLatest`, and the
 * reader itself is tested hermetically with a fake spawn.
 */

import { nodeSpawn, runCommand, type RunCommandDeps } from './run-command.ts';

/** The embedded SDK package this repository pins in package.json. */
export const EMBEDDED_SDK_PACKAGE = '@earendil-works/pi-coding-agent';
/** Registry-read ceiling for the embedded upkeep command contract. */
export const STABLE_LATEST_READ_TIMEOUT_MS = 30_000;

/**
 * Parses `npm view <pkg> dist-tags.latest --json`, which prints the value as
 * a JSON string (`"0.85.0"`). Anything that is not a JSON string — unquoted,
 * malformed, or an object — is not a stable latest result.
 */
export function parseNpmLatestJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Bounded production reader: `npm view @earendil-works/pi-coding-agent
 * dist-tags.latest --json` with the configured ceiling. A nonzero exit, a
 * timeout/abort, a spawn error, or a non-JSON body all read as "no latest
 * result"; the caller's stable-latest evaluation decides what that means.
 */
export function readStableLatest(deps: RunCommandDeps): () => Promise<string | null> {
  return async () => {
    const outcome = await runCommand(deps, {
      command: 'npm',
      args: ['view', EMBEDDED_SDK_PACKAGE, 'dist-tags.latest', '--json'],
      timeoutMs: STABLE_LATEST_READ_TIMEOUT_MS,
    });
    if (outcome.kind !== 'exit' || outcome.code !== 0) return null;
    return parseNpmLatestJson(outcome.facts.stdout);
  };
}

/** Production binding over node's own spawn, for server wiring. */
export function productionReadStableLatest(): () => Promise<string | null> {
  return readStableLatest({ spawn: nodeSpawn });
}
