/**
 * Module-cache ordering regression fixture for the live canary.
 *
 * Runs under tsx with `track-sdk.mjs` preloaded; that tracker records every
 * resolved specifier inside the embedded SDK package. This fixture imports
 * the promotion, preflight, recovery, and canary entry modules, constructs
 * the production bindings, and asserts the SDK was not evaluated — then
 * invokes the production canary's `createChat` (the gate step after the
 * candidate install/build/audit) and asserts the SDK loaded exactly there.
 *
 * `createChat` constructs the inert ModelCatalog/PiChat objects only: no
 * runtime, no session, no model or network call. The isolated canary temp
 * root `createTempRoot` builds is removed best-effort in `finally` and its
 * absence asserted — the probe never leaks a /tmp root, exactly like the
 * canary's own cleanup contract. Exit codes are asserted by the vitest suite;
 * anything other than 0 fails the regression.
 */
import { productionCanaryDeps } from '../canary.ts';
import { runUpkeepCommand } from '../cli.ts';
import { productionPromote } from '../promote.ts';
import { runPreflight } from '../preflight.ts';
import { runRecovery } from '../recover.ts';
import { productionUpkeepDeps } from '../upkeep-cli.ts';
import type { CanaryTempRoot } from '../canary.ts';

const sdkLoads = (globalThis as unknown as { __sdkLoads: string[] }).__sdkLoads;
const deps = productionCanaryDeps();
// The CLI entry's static graph (cli.ts + upkeep-cli.ts) must also stay
// SDK-free: constructing the production command deps is inert.
const cliDeps = productionUpkeepDeps(['--promote'], {});

let tempRoot: CanaryTempRoot | null = null;
try {
  // Static imports plus production-binding construction must stay SDK-free: the
  // promotion transaction imports these before the candidate npm install, and a
  // cached pre-install SDK would be the one the canary later reused.
  const promote = productionPromote({
    runCanary: () => Promise.resolve({ kind: 'ok' }),
    skipCanary: false,
  });
  if (typeof promote !== 'function' || typeof deps.createTempRoot !== 'function') {
    console.error('[probe] FAIL: production bindings are structurally incomplete');
    process.exitCode = 2;
    throw new Error('binding check failed');
  }
  if (typeof runPreflight !== 'function' || typeof runRecovery !== 'function') {
    console.error('[probe] FAIL: preflight/recovery entry exports are missing');
    process.exitCode = 2;
    throw new Error('entry check failed');
  }
  if (
    typeof runUpkeepCommand !== 'function' ||
    typeof cliDeps.runPreflight !== 'function' ||
    typeof cliDeps.runPromote !== 'function' ||
    typeof cliDeps.runRecover !== 'function' ||
    typeof cliDeps.runGitTopLevel !== 'function'
  ) {
    console.error('[probe] FAIL: CLI coordinator/production entry are structurally incomplete');
    process.exitCode = 2;
    throw new Error('cli check failed');
  }
  if (sdkLoads.length > 0) {
    console.error(`[probe] FAIL: SDK evaluated before canary invocation: ${sdkLoads[0]}`);
    process.exitCode = 2;
    throw new Error('sdk order check failed');
  }

  // Invoking createChat is the first and only point the embedded SDK may load.
  tempRoot = await deps.createTempRoot();
  const chat = await deps.createChat(tempRoot);
  if (typeof chat.send !== 'function' || typeof chat.liveSession !== 'function') {
    console.error('[probe] FAIL: createChat returned a structurally incomplete chat');
    process.exitCode = 3;
    throw new Error('chat shape check failed');
  }
  if (sdkLoads.length === 0) {
    console.error('[probe] FAIL: createChat did not load the embedded SDK');
    process.exitCode = 3;
    throw new Error('sdk load check failed');
  }
  console.log(`[probe] OK: ${sdkLoads.length} SDK modules loaded only inside createChat`);
} catch (error) {
  if (process.exitCode === 0) {
    console.error(`[probe] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
} finally {
  // Best-effort removal of the exact temp root, verified absent: the canary's
  // cleanup contract applies to the probe too. Never touches any other /tmp
  // directory.
  if (tempRoot !== null) {
    try {
      await deps.fs.rm(tempRoot.root, { recursive: true });
      if (await deps.fs.exists(tempRoot.root)) {
        console.error(`[probe] FAIL: canary temp root still present after probe cleanup: ${tempRoot.root}`);
        process.exitCode = 4;
      }
    } catch (error) {
      console.error(
        `[probe] FAIL: canary temp root cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 4;
    }
  }
}
