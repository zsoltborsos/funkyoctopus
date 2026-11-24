import { open, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

/** Maximum content read from any one Helmraiser run file (256 KiB). */
export const MAX_HELMRAISER_RUN_FILE_BYTES = 256 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const inside = (parent: string, child: string): boolean => {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !path.startsWith('/');
};

export interface HelmraiserRunFile {
  path: string;
  text: string;
  truncated: boolean;
}

/**
 * Resolve a run directory without allowing either the configured `runs`
 * directory or the UUID-named run directory to escape through a symlink.
 * The UUID check deliberately precedes every filesystem operation.
 */
export async function resolveHelmraiserRun(
  runId: string,
  dataDir: string,
): Promise<{ runsPath: string; runPath: string }> {
  if (!UUID.test(runId)) throw new Error('Helmraiser run reader requires a UUID runId');

  const runsPath = resolve(dataDir, 'runs');
  let canonicalRuns: string;
  try {
    canonicalRuns = await realpath(runsPath);
  } catch {
    throw new Error(`Helmraiser runs directory does not exist: ${runsPath}`);
  }
  if (canonicalRuns !== runsPath) {
    throw new Error('Helmraiser runs path escapes the configured data directory');
  }

  const submittedRun = resolve(runsPath, runId);
  let canonicalRun: string;
  try {
    canonicalRun = await realpath(submittedRun);
  } catch {
    throw new Error(`Helmraiser run does not exist: ${runId}`);
  }
  if (!inside(canonicalRuns, canonicalRun)) {
    throw new Error(`Helmraiser run path escapes the runs directory for run ${runId}`);
  }
  return { runsPath: canonicalRuns, runPath: canonicalRun };
}

/** Read a bounded run file. Optional files return null when absent. */
export async function readHelmraiserRunFile(
  run: { runsPath: string; runPath: string },
  runId: string,
  name: string,
  optional = false,
): Promise<HelmraiserRunFile | null> {
  const submitted = resolve(run.runPath, name);
  let canonical: string;
  try {
    canonical = await realpath(submitted);
  } catch {
    if (optional) return null;
    throw new Error(`Helmraiser ${name.replace(/\.md$/, '')} does not exist for run ${runId}`);
  }
  if (!inside(run.runsPath, canonical)) {
    throw new Error(`Helmraiser ${name.replace(/\.md$/, '')} path escapes the runs directory for run ${runId}`);
  }

  const handle = await open(canonical, 'r');
  try {
    const bytes = Buffer.alloc(MAX_HELMRAISER_RUN_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return {
      path: canonical,
      text: bytes.subarray(0, Math.min(bytesRead, MAX_HELMRAISER_RUN_FILE_BYTES)).toString('utf8'),
      truncated: bytesRead > MAX_HELMRAISER_RUN_FILE_BYTES,
    };
  } finally {
    await handle.close();
  }
}
