/**
 * pi contract — every *private* pi surface FunkyOctopus relies on, pinned
 * against the installed SDK so an embedded-pi bump fails here, in `verify`,
 * rather than in production (CURRENT_STATE.md decision 1; TASKS.md T1.1).
 *
 * "Private" means: not part of `@earendil-works/pi-coding-agent`'s package
 * entry contract, yet observable behaviour FO mirrors or assumes. Each surface
 * gets one focused assertion against the real installed code — no mocks of
 * pi here, by design. The public API is pinned by the type-checker already.
 *
 * Surfaces (and where FO relies on them):
 *   1. crew tool names            — src/shared/transport/protocol.ts CREW_TOOLS
 *   2. thinking-level ladder      — server/src/pi/model-catalog.ts thinkingLevelsFor
 *   3. custom_message entry shape — server/src/pi/custom-message.ts (reopen path)
 *   4. (retired 2026-10-19 with the transcript provenance stamp, T3 L1)
 *   5. session file layout        — server/src/pi/session-index.ts (head reader)
 *   6. default session root       — server/src/pi/session-index.ts SESSION_ROOT
 *   7. replacement-factory path   — server/src/pi/session-host.ts
 *   8. teardown parity + reasons  — server/src/pi/session-host.ts (RuntimeSessionHost.dispose)
 *   9. pi-crew runtime read/abort — server/src/pi/crew.ts (crewActiveFor, crewAbortOwned)
 *  10. pi-crew binding mode       — server/src/chat-registry.ts (crew in one pi slot)
 *
 * Surfaces 1, 9 and 10 are pi-crew's, not pi's: pi-crew is wherever pi's own
 * package manager resolves it from the owner's settings (the global store
 * `~/.pi/agent/npm` today, or a local path), not this repository's
 * node_modules. They are checked against that install when present and skipped
 * (visibly) when absent. Everything else reads only this repository's
 * node_modules.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import {
  AgentSessionRuntime,
  DefaultPackageManager,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type AgentSessionServices,
  type SessionShutdownEvent,
} from '@earendil-works/pi-coding-agent';
import { CREW_TOOLS } from '../../../src/shared/transport/protocol.ts';
import { CREW_RUNTIME_KEY } from './crew.ts';
import { customMessageChunkFromEntry } from './custom-message.ts';
import { thinkingLevelsFor } from './model-catalog.ts';
import { unreachableSessionReplacementFactory, type TeardownReason } from './session-host.ts';

// ---------------------------------------------------------------------------
// Locating installed code without going through package `exports` (which hide
// package.json and pi-ai's compat module from a plain import by name).
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const SDK_DIR = join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');

/** pi-ai as pi-coding-agent resolves it: nested first, hoisted second. */
function piAiDir(): string {
  const nested = join(SDK_DIR, 'node_modules', '@earendil-works', 'pi-ai');
  const hoisted = join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-ai');
  if (existsSync(join(nested, 'package.json'))) return nested;
  if (existsSync(join(hoisted, 'package.json'))) return hoisted;
  throw new Error('pi-ai not found next to or above the embedded pi-coding-agent');
}

const PI_CREW = '@melihmucuk/pi-crew';

/** The name in the nearest package.json at or above `path`, or null. */
function packageNameAbove(path: string): string | null {
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) return (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ?? null;
  }
  return null;
}

/**
 * pi-crew's extension directory as pi itself resolves it from the owner's
 * settings — the same resolution a session's resource loader makes — or null
 * when no enabled extension belongs to pi-crew. Read-only: the settings file is
 * read into memory (pi's file storage would take a lock in the agent dir), and
 * a package that is missing is skipped, never installed.
 */
async function piCrewExtensionDir(): Promise<string | null> {
  const agentDir = getAgentDir();
  const file = join(agentDir, 'settings.json');
  if (!existsSync(file)) return null;
  const settingsManager = SettingsManager.inMemory(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>);
  const packages = new DefaultPackageManager({ cwd: REPO_ROOT, agentDir, settingsManager });
  const resolved = await packages.resolve(() => Promise.resolve('skip'));
  const entry = resolved.extensions.find((resource) => resource.enabled && packageNameAbove(resource.path) === PI_CREW);
  return entry ? dirname(entry.path) : null;
}

const crewDir = await piCrewExtensionDir();
/** One file of the resolved pi-crew extension, or null when there is none. */
function piCrewSource(file: string): string | null {
  if (crewDir === null) return null;
  const path = join(crewDir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fo-pi-contract-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('pi contract (installed SDK)', () => {
  const crewSource = piCrewSource('tools.ts');
  const crewRuntimeSource = piCrewSource('crew.ts');

  it.skipIf(crewSource === null)(
    '1. crew tool names: CREW_TOOLS is exactly the set pi-crew registers (where pi resolves it)',
    () => {
      const registered = [...(crewSource ?? '').matchAll(/^\s*name:\s*["'](crew_[a-z_]+)["']/gm)].map((m) => m[1]);
      expect([...registered].sort()).toEqual([...CREW_TOOLS].sort());
    },
  );

  it('2. thinking-level ladder: thinkingLevelsFor mirrors pi-ai getSupportedThinkingLevels for reasoning models', async () => {
    const pkg = JSON.parse(readFileSync(join(piAiDir(), 'package.json'), 'utf8')) as {
      exports?: Record<string, { import?: string }>;
    };
    const compatEntry = pkg.exports?.['./compat']?.import;
    if (!compatEntry) throw new Error('pi-ai no longer exports ./compat');
    const compat = (await import(pathToFileURL(join(piAiDir(), compatEntry)).href)) as {
      getSupportedThinkingLevels: (model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }) => string[];
    };
    const fixtures = [
      { reasoning: true },
      { reasoning: true, thinkingLevelMap: { xhigh: 'xhigh' } },
      { reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } },
      { reasoning: true, thinkingLevelMap: { minimal: null, low: null } },
      { reasoning: true, thinkingLevelMap: { off: null, max: 'max' } },
      { reasoning: true, thinkingLevelMap: { minimal: 'low', xhigh: null } },
    ];
    expect(fixtures.map(thinkingLevelsFor)).toEqual(fixtures.map(compat.getSupportedThinkingLevels));
    // The one deliberate divergence: pi says ["off"] for a model without a
    // reasoning knob; FO's picker wants "no knob" and says [] instead.
    expect(compat.getSupportedThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(thinkingLevelsFor({ reasoning: false })).toEqual([]);
  });

  it('3. custom_message entries: appendCustomMessageEntry persists the fields the reopen path reads, with an ISO timestamp', () => {
    const manager = SessionManager.inMemory(process.cwd());
    const id = manager.appendCustomMessageEntry('crew-result', 'done', true, { agent: 'scout', nested: { n: 1 } });
    const entry = manager.getEntries().find((candidate) => candidate.id === id);
    if (!entry || entry.type !== 'custom_message') throw new Error('custom_message entry not persisted');
    expect(customMessageChunkFromEntry(entry)).toEqual({
      kind: 'custom-message',
      id,
      customType: 'crew-result',
      display: true,
      content: 'done',
      details: { agent: 'scout', nested: { n: 1 } },
      timestamp: Date.parse(entry.timestamp),
    });
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  });

  it('5. session file layout: <dir>/<timestamp>_<id>.jsonl, line 1 a "session" header with id/cwd/timestamp, messages after', () => {
    const dir = tempDir();
    const cwd = tempDir();
    const manager = SessionManager.create(cwd, dir);
    manager.appendMessage({ role: 'user', content: 'hello pi', timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'anthropic-messages',
      provider: 'p',
      model: 'm',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile();
    if (!file) throw new Error('persisted session has no file');
    expect(dirname(file)).toBe(dir);
    expect(file).toMatch(new RegExp(`_${manager.getSessionId()}\\.jsonl$`));
    const [header, first] = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(header).toMatchObject({ type: 'session', id: manager.getSessionId(), cwd });
    expect(typeof header?.timestamp).toBe('string');
    expect(first).toMatchObject({ type: 'message', message: { role: 'user', content: 'hello pi' } });
  });

  it('6. default session root: pi keeps per-cwd session dirs under <agentDir>/sessions', () => {
    // A throwaway agent dir, so nothing is created under the real ~/.pi.
    const agentDir = tempDir();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const manager = SessionManager.create(process.cwd());
      expect(dirname(manager.getSessionDir())).toBe(join(getAgentDir(), 'sessions'));
      expect(getAgentDir()).toBe(agentDir);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it('7. replacement factory: AgentSessionRuntime.newSession reaches the injected factory, so the unreachable factory fails loudly', async () => {
    // A minimal stand-in for the surface pi's runtime touches on the way to the
    // factory when no extension handles session_before_switch/session_shutdown.
    let disposed = 0;
    const fakeSession = {
      sessionFile: undefined,
      sessionManager: SessionManager.inMemory(process.cwd()),
      extensionRunner: { hasHandlers: () => false, emit: () => Promise.resolve(undefined) },
      abort: () => Promise.resolve(),
      dispose: () => {
        disposed += 1;
      },
    } as unknown as AgentSession;
    const services = { cwd: process.cwd(), agentDir: tempDir() } as unknown as AgentSessionServices;
    const runtime = new AgentSessionRuntime(fakeSession, services, unreachableSessionReplacementFactory());
    await expect(runtime.newSession()).rejects.toThrow(/replacement factory is unreachable/);
    // pi tears the current session down *before* asking the factory — which is
    // exactly why FO must never let this path run: a rejection here leaves no
    // live session behind, so the failure has to be loud, not silent.
    expect(disposed).toBe(1);
  });

  it('8. teardown parity: AgentSessionRuntime.dispose() aborts, emits exactly session_shutdown{quit}, disposes, then settles credential writes', async () => {
    const recorded: unknown[] = [];
    const fakeSession = {
      abort: () => {
        recorded.push(['abort']);
        return Promise.resolve();
      },
      extensionRunner: {
        hasHandlers: () => true,
        emit: (event: unknown) => {
          recorded.push(['emit', event]);
          return Promise.resolve(undefined);
        },
      },
      dispose: () => {
        recorded.push(['dispose']);
      },
    } as unknown as AgentSession;
    const services = {
      cwd: process.cwd(),
      agentDir: tempDir(),
      modelRuntime: {
        settleCredentialWrites: () => {
          recorded.push(['settleCredentialWrites']);
          return Promise.resolve();
        },
      },
    } as unknown as AgentSessionServices;
    await new AgentSessionRuntime(fakeSession, services, unreachableSessionReplacementFactory()).dispose();
    // RuntimeSessionHost does exactly this for `quit`, and mirrors it with another
    // reason for new/resume; a pi that adds a step here must be mirrored there.
    // The abort is mirrored by PiChat.disposeHost (aborts a streaming session
    // before any teardown); settleCredentialWrites is quit-only in pi too
    // (teardownCurrent does not call it), so new/resume need no mirror (pi 1.5.2).
    expect(recorded).toEqual([
      ['abort'],
      ['emit', { type: 'session_shutdown', reason: 'quit' }],
      ['dispose'],
      ['settleCredentialWrites'],
    ]);
  });

  it('8b. shutdown reasons: pi\'s union still has new, resume and quit (checked at compile time)', () => {
    expectTypeOf<'new' | 'resume' | 'quit'>().toExtend<SessionShutdownEvent['reason']>();
    expectTypeOf<TeardownReason>().toEqualTypeOf<'new' | 'resume' | 'quit'>();
  });

  it.skipIf(crewRuntimeSource === null)(
    '9. pi-crew runtime read: the process runtime sits under Symbol.for("pi-crew.runtime") with getActiveSummariesForOwner(ownerSessionId) (status "running" in flight) and abortAllOwned(callerSessionId, {reason})',
    () => {
      const source = crewRuntimeSource ?? '';
      expect(source).toContain(`Symbol.for("${CREW_RUNTIME_KEY.description ?? ''}")`);
      expect(source).toMatch(/^\s*getActiveSummariesForOwner\(ownerSessionId: string\): ActiveAgentSummary\[\] \{/m);
      // The owner-scoped abort a closing crew slot uses (crewAbortOwned), with its options shape.
      expect(source).toMatch(/^\s*abortAllOwned\(callerSessionId: string, opts: AbortOptions\): string\[\] \{/m);
      expect(source).toMatch(/interface AbortOptions \{\s*reason: string;\s*\}/);
      // A summary spreads the lifecycle, whose in-flight status is the literal "running".
      expect(source).toMatch(/^\s*\.\.\.state\.lifecycle,$/m);
      const status = piCrewSource('subagent-status.ts') ?? '';
      expect(status).toMatch(/^\s*running: "running",$/m);
      expect(status).toMatch(/\[SUBAGENT_STATUS\.running\]: "in-flight"/);
    },
  );

  // Decision 13: pi-crew in at most one pi slot until it binds per session.
  const binding =
    crewRuntimeSource === null
      ? null
      : /\bprivate activeBinding\b/.test(crewRuntimeSource)
        ? 'single'
        : /\bbindings = new Map\b/.test(crewRuntimeSource)
          ? 'per-session'
          : 'unknown';

  it.skipIf(binding !== 'single')(
    '10. crew capability: the installed pi-crew binds one session per process, so crew stays in one pi slot',
    () => {
      expect(binding).toBe('single');
    },
  );

  it.skipIf(binding !== 'per-session')(
    '10b. crew capability: the installed pi-crew binds per session — crew could load in every pi slot (revisit decision 13)',
    () => {
      expect(binding).toBe('per-session');
    },
  );
});
