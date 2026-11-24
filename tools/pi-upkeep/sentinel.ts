/**
 * Blocking transaction sentinel.
 *
 * The sentinel file marks an in-flight (or unresolved) promotion/recovery
 * transaction. Its presence — or the inability to prove its absence — blocks
 * the next promotion until explicit recovery resolves it; only a definite
 * ENOENT lets a promotion proceed. Disabled upkeep is never consulted here:
 * the sentinel is non-bypassable. (The sidecar itself no longer reads it —
 * it boots directly; the promotion tool refuses while a sidecar answers on
 * the configured port instead.)
 */

import { join } from 'node:path';
import type { CoordinationFsOps } from '../../server/src/upkeep/state-path.ts';

export const SENTINEL_FILE = 'transaction.sentinel';

export type SentinelStatus = 'absent' | 'present' | 'unreadable';

export function sentinelPath(stateDir: string): string {
  return join(stateDir, SENTINEL_FILE);
}

export async function sentinelStatus(
  stateDir: string,
  fs: Pick<CoordinationFsOps, 'readFile'>,
): Promise<SentinelStatus> {
  const path = sentinelPath(stateDir);
  try {
    await fs.readFile(path);
    return 'present';
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return 'absent';
    }
    return 'unreadable';
  }
}

export type CreateSentinelResult = 'created' | 'exists' | 'error';

/**
 * Atomically and exclusively creates the blocking sentinel with private
 * permissions. `flag: 'wx'` makes the create fail with EEXIST when the file
 * already exists, so two transactions can never both believe they own the
 * sentinel; the caller decides whether an existing sentinel is a refusal.
 */
export async function createSentinel(
  stateDir: string,
  fs: Pick<CoordinationFsOps, 'writeFile'>,
  content: string,
): Promise<CreateSentinelResult> {
  try {
    await fs.writeFile(sentinelPath(stateDir), content, { mode: 0o600, flag: 'wx' });
    return 'created';
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') {
      return 'exists';
    }
    return 'error';
  }
}

/** Removes the blocking sentinel; a missing sentinel is a no-op, never an error. */
export async function clearSentinel(
  stateDir: string,
  fs: Pick<CoordinationFsOps, 'unlink'>,
): Promise<void> {
  try {
    await fs.unlink(sentinelPath(stateDir));
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code !== 'ENOENT') {
      throw error;
    }
  }
}
