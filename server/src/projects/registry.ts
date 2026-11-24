import { stat } from 'node:fs/promises';
import { defaultLbRunner, LB_NOT_FOUND, type LbCliRunner } from '../leeboard/cli.ts';
import type { ProjectOption } from '../../../src/shared/transport/protocol.ts';

/** A project's current location plus every missing path Leeboard lists for it. */
export interface ProjectPaths {
  name: string;
  path: string;
  /** Missing paths, deduplicated, first listed first. */
  oldPaths: string[];
}

/** What `lb project list --json` returns; aliases and remotes are not used here. */
interface LbProjectEntry {
  name: string;
  paths: string[];
}

/** Parse defensively: CLI shape drift must not crash the selector or history. */
function parseEntry(raw: unknown): LbProjectEntry | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entry = raw as { name?: unknown; paths?: unknown };
  if (typeof entry.name !== 'string' || entry.name === '' || !Array.isArray(entry.paths)) return null;
  const paths = entry.paths.filter((path): path is string => typeof path === 'string' && path !== '');
  return paths.length ? { name: entry.name, paths } : null;
}

/** One defensive read of `lb project list --json`; empty array + warning on failure. */
async function readRegistry(run: LbCliRunner): Promise<ProjectPaths[]> {
  const result = await run(['project', 'list', '--json']).catch(() => null);
  // No `lb` is not a failure to report on every read: the runner says so once.
  if (result?.code === LB_NOT_FOUND) return [];
  if (!result || result.code !== 0) {
    console.warn('[projects] lb project list failed, treating as empty', String(result?.stderr ?? ''));
    return [];
  }
  let entries: unknown;
  try {
    entries = JSON.parse(result.stdout);
  } catch {
    console.warn('[projects] lb project list printed unparsable JSON');
    return [];
  }
  if (!Array.isArray(entries)) {
    console.warn('[projects] lb project list did not print an array');
    return [];
  }
  const projects: ProjectPaths[] = [];
  for (const raw of entries) {
    const entry = parseEntry(raw);
    if (!entry) {
      console.warn('[projects] lb project list contained a malformed entry');
      continue;
    }
    let folder: string | undefined;
    const oldPaths: string[] = [];
    for (const path of new Set(entry.paths)) {
      const info = await stat(path).catch(() => null);
      if (!info) oldPaths.push(path);
      else if (!folder && info.isDirectory()) folder = path;
    }
    if (folder) projects.push({ name: entry.name, path: folder, oldPaths });
  }
  return projects;
}

/** All listed Leeboard projects count as active; the first existing directory wins. */
export async function knownProjects(run: LbCliRunner = defaultLbRunner): Promise<ProjectOption[]> {
  const projects = await readRegistry(run);
  return projects.map((project) => ({
    id: project.path,
    name: project.name,
    path: project.path,
    envTier: 'normal',
  }));
}

/**
 * The working-folder mapping for chats recorded before a machine or disk move.
 * Leeboard must list the former paths; other existing directories are not old paths.
 */
export async function projectPathIndex(run: LbCliRunner = defaultLbRunner): Promise<ProjectPaths[]> {
  return readRegistry(run);
}
