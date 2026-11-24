import { stat } from 'node:fs/promises';
import type { ProjectPaths } from './registry.ts';

/** Predicate for "this path exists and is a directory". Injectable for tests. */
export type IsDirectory = (path: string) => Promise<boolean>;

function productionDirectoryCheck(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isDirectory()).catch(() => false);
}

/**
 * Result of mapping a recorded session cwd onto the current disk layout:
 * `movedFrom` carries the original recorded cwd whenever it changed.
 */
export interface RemappedCwd {
  cwd: string;
  movedFrom?: string;
}

/**
 * Map a session's recorded cwd onto the current disk via the Leeboard
 * project-path index.
 *
 * Existing directories are returned unchanged — the mapping only exists for
 * paths left behind by a machine or disk move. Otherwise the *longest*
 * registered old path that is the cwd or a prefix of it wins, so nested old
 * paths (a repo registered both alone and inside a workspace) resolve to their
 * own project, not their parent's. A subfolder that survived the move keeps its
 * suffix under the project's current path; one that did not falls back to the
 * project root, which is still a better root for the chat than a dead path.
 * Null when nothing matches — the caller decides what "gone" means.
 */
export async function remapCwd(
  cwd: string,
  index: ProjectPaths[],
  isDirectory: IsDirectory = productionDirectoryCheck,
): Promise<RemappedCwd | null> {
  if (await isDirectory(cwd)) return { cwd };
  let best: { project: ProjectPaths; oldPath: string } | null = null;
  for (const project of index) {
    for (const oldPath of project.oldPaths) {
      const matched =
        cwd === oldPath || cwd.startsWith(oldPath + '/') ? oldPath.length : -1;
      if (matched > 0 && (!best || oldPath.length > best.oldPath.length)) {
        best = { project, oldPath };
      }
    }
  }
  if (!best) return null;
  const candidate = best.project.path + cwd.slice(best.oldPath.length);
  if (await isDirectory(candidate)) {
    return { cwd: candidate, movedFrom: cwd };
  }
  if (cwd !== best.oldPath) {
    // A vanished subfolder still has the project root to offer — a far better
    // root for the chat than its dead path.
    if (await isDirectory(best.project.path)) {
      return { cwd: best.project.path, movedFrom: cwd };
    }
  }
  return null;
}
