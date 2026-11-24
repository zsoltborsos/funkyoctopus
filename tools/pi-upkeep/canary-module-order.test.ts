/**
 * Module-cache ordering regression.
 *
 * The live canary must run against the *newly installed* candidate embedded
 * SDK, never a pre-install cached copy. The promotion transaction imports the
 * promotion engine (promote.ts) before the candidate npm install, so that
 * static graph — plus canary.ts and the construction of the production
 * bindings — must not evaluate `@earendil-works/pi-coding-agent` at import
 * time. The embedded SDK is allowed to load only when the production
 * canary's `createChat` is invoked, at the gate step after install/build/
 * audit.
 *
 * This suite proves that ordering in a fresh child process (the orchestrator
 * scenario) by preloading a module-hook tracker that records every resolved
 * specifier inside the SDK package, then asserting the record is empty across
 * the static imports and binding construction, and populated after
 * `createChat`. No model or network call is made: `createChat` only
 * constructs the inert ModelCatalog/PiChat objects, and the suite's child
 * exits before any turn could start.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The tools project runs under the node environment, so import.meta.dirname is the real file location.
const repoRoot = resolve(import.meta.dirname, '..', '..');
const tracker = join(repoRoot, 'tools', 'pi-upkeep', '__fixtures__', 'track-sdk.mjs');
const probe = join(
  repoRoot,
  'tools',
  'pi-upkeep',
  '__fixtures__',
  'canary-module-order.probe.ts',
);

/** Every canary temp root currently on the system temp dir, sorted. */
async function canaryTempRoots(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries
    .filter((entry) => entry.startsWith('funkyoctopus-canary-'))
    .sort();
}

function runProbe(): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // `node --import tsx` rather than the tsx CLI: the CLI opens a Unix-socket IPC
    // server, which Helmraiser's sandbox blocks (srt seccomp), and the loader order is
    // the same (tsx first, then the tracker).
    execFile(
      process.execPath,
      ['--import', 'tsx', '--import', tracker, probe],
      // Below the it()-level ceiling so a stalled probe is killed before vitest gives up on it.
      { cwd: repoRoot, timeout: 50_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? -1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('canary — module-cache ordering', () => {
  it('does not evaluate the embedded SDK until production createChat is invoked', async () => {
    const before = await canaryTempRoots();
    const result = await runProbe();
    expect(result.code, `probe failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(
      0,
    );
    expect(result.stdout).toContain('[probe] OK');
    // The probe's isolated temp root must be gone: the canary cleanup contract
    // (remove the exact root, verify absent) applies to the probe too. Only new
    // roots count — unrelated pre-existing /tmp dirs are never touched.
    const after = await canaryTempRoots();
    expect(after).toEqual(before);
  }, 60_000);
});
