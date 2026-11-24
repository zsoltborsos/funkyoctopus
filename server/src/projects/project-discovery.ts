import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ProjectOption } from '../../../src/shared/transport/protocol.ts';

/** Expands a leading `~` to the sidecar's home directory; other paths pass through. */
export function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function option(path: string): ProjectOption {
  return { id: path, name: basename(path) || path, path, envTier: 'normal' };
}

/** Returns roots, immediate directories, and repository grandchildren under non-repo children. */
export async function discoverProjects(workspaceRoots: string[]): Promise<ProjectOption[]> {
  const paths = new Set<string>();
  for (const configuredRoot of workspaceRoots) {
    const root = await realpath(expandHome(configuredRoot)).catch(() => null);
    if (!root) continue;
    paths.add(root);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(root, entry.name);
      const resolved = await realpath(child).catch(() => child);
      if (!(await stat(resolved).catch(() => null))?.isDirectory()) continue;
      paths.add(resolved);
      const git = await stat(join(resolved, '.git')).catch(() => null);
      if (git?.isDirectory() || git?.isFile()) continue;

      const grandchildren = await readdir(resolved, { withFileTypes: true }).catch(() => []);
      for (const grandchild of grandchildren) {
        if (!grandchild.isDirectory()) continue;
        const nested = join(resolved, grandchild.name);
        const resolvedNested = await realpath(nested).catch(() => nested);
        if (!(await stat(resolvedNested).catch(() => null))?.isDirectory()) continue;
        const nestedGit = await stat(join(resolvedNested, '.git')).catch(() => null);
        if (nestedGit?.isDirectory() || nestedGit?.isFile()) paths.add(resolvedNested);
      }
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b)).map(option);
}
