/**
 * Upkeep state path derivation.
 *
 * Persisted updater state lives under
 * `${XDG_STATE_HOME:-~/.local/state}/funkyoctopus/upkeep/<repository-path-hash>/`
 * where the hash is a deterministic digest of the repository's canonical
 * realpath, so aliases (symlinks, bind mounts) of one repository resolve to
 * exactly one state directory. Derivation stays exported here so the later
 * promotion/recovery CLI uses the same paths as startup.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HashFn = (input: string) => string;

/** Deterministic sha256 hex digest of an exact canonical path string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable per-repository hash: the sha256 of the canonical path. */
export function repositoryPathHash(canonicalPath: string, hash: HashFn = sha256Hex): string {
  return hash(canonicalPath);
}

/**
 * Default state root: `${XDG_STATE_HOME:-~/.local/state}`. `homeDir` is
 * injected so the default stays deterministic in tests. An empty or unset
 * `XDG_STATE_HOME` falls back (the `:-` form treats the empty string like
 * unset) so the state root is never a relative in-repo path.
 */
export function defaultStateRoot(
  xdgStateHome: string | undefined,
  homeDir: () => string,
): string {
  if (xdgStateHome) return xdgStateHome;
  return join(homeDir(), '.local', 'state');
}

/** Full state directory for one canonical repository path. */
export function stateDirFor(canonicalPath: string, stateRoot: string, hash: HashFn = sha256Hex): string {
  return join(stateRoot, 'funkyoctopus', 'upkeep', repositoryPathHash(canonicalPath, hash));
}

/**
 * Minimal stat metadata the lock needs for incomplete-claim age decisions:
 * the last-modification time in epoch milliseconds (`node:fs` `Stats.mtimeMs`).
 */
export interface CoordinationStat {
  mtimeMs: number;
}

/**
 * Minimal filesystem surface the coordination modules need. All operations
 * are injected so lock/sentinel/guard behavior is deterministic in tests;
 * the production binding lives in `server/src/entrypoint.ts`.
 */
export interface CoordinationFsOps {
  /** `recursive` is explicit so node's mkdir binds without overload friction. */
  mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<unknown>;
  readFile(path: string): Promise<string>;
  /**
   * `flag` is passed through to node's writeFile so the journal and sentinel
   * can write unique staging files and create the blocking sentinel
   * exclusively (`'wx'`). Real `node:fs/promises` writeFile accepts both.
   */
  writeFile(path: string, data: string, options: { mode?: number; flag?: string }): Promise<void>;
  realpath(path: string): Promise<string>;
  /** Lists entry names (not full paths), as `node:fs/promises` `readdir` does. */
  readdir(path: string): Promise<string[]>;
  chmod(path: string, mode: number): Promise<void>;
  /** Metadata used to age incomplete claims (`Stats.mtimeMs`). */
  stat(path: string): Promise<CoordinationStat>;
  /** Atomically moves a fully-written pending owner file into the lock directory. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Removes a single file; rejects with ENOENT when absent. */
  unlink(path: string): Promise<void>;
  /** Removes an empty directory only; rejects with ENOTEMPTY when not empty. */
  rmdir(path: string): Promise<void>;
}

/** Resolves the state dir for a repo, hashing its canonical realpath. */
export async function repositoryStateDir(
  repoPath: string,
  deps: { fs: Pick<CoordinationFsOps, 'realpath'>; stateRoot?: string; hash?: HashFn },
): Promise<string> {
  const canonical = await deps.fs.realpath(repoPath);
  const stateRoot = deps.stateRoot ?? defaultStateRoot(process.env.XDG_STATE_HOME, defaultHomeDir);
  return stateDirFor(canonical, stateRoot, deps.hash);
}

/**
 * Creates the state chain with private permissions. A 0o700 mode survives any
 * umask (only owner bits are set), so the directory is never group/world
 * readable. mkdir's mode applies only to newly created directories, so an
 * existing state leaf is chmod'd explicitly to enforce 0o700 there too.
 */
export async function ensureStateDir(
  stateDir: string,
  fs: Pick<CoordinationFsOps, 'mkdir' | 'chmod'>,
): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);
}

function defaultHomeDir(): string {
  return homedir();
}
