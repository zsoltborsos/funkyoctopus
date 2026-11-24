import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';
import type { PiChat } from '../pi/pi-chat.ts';
import type { VaultRule } from '../security/vault.ts';

const execFileAsync = promisify(execFile);
const cleanupPaths = new Set<string>();

/**
 * Every live runtime chat, tracked so failure-safe teardown is possible.
 *
 * A `PiChat` holds a live pi AgentSession (subscribers, in-flight work). The
 * suite must dispose every one of them even when a test or scenario fails
 * before its own cleanup ran — that is what the registry guarantees: anything
 * constructed through `trackRuntimeChat` is disposed exactly once, either by
 * the scenario's eager `afterAll` or by the file-level teardown.
 */
const trackedChats = new Set<PiChat>();
let chatsConstructed = 0;
let chatsDisposed = 0;
let sessionsDisposed = 0;

/**
 * Register a chat for guaranteed teardown. Idempotent per instance: tracking
 * the same chat twice counts as one construction.
 */
export function trackRuntimeChat(chat: PiChat): PiChat {
  if (!trackedChats.has(chat)) {
    trackedChats.add(chat);
    chatsConstructed += 1;
  }
  return chat;
}

/**
 * Teardown-process a tracked chat exactly once: remove it from the registry,
 * then dispose its live session when one exists (a never-built chat has no
 * session to dispose, but it was still teardown-processed). Returns whether
 * this call did the work; a second call is a no-op.
 */
export async function disposeRuntimeChat(chat: PiChat): Promise<boolean> {
  if (!trackedChats.delete(chat)) return false;
  chatsDisposed += 1;
  // Teardown through PiChat's host only: disposeLiveSession is idempotent and
  // non-constructing, and streaming abort before disposal is PiChat's own job
  // (disposeHost aborts a streaming session before host.dispose emits
  // session_shutdown). No raw session.dispose() or abort bypass here.
  if (await chat.disposeLiveSession()) sessionsDisposed += 1;
  return true;
}

/** Dispose every still-tracked chat. Safe to call repeatedly. */
export async function disposeAllRuntimeChats(): Promise<void> {
  for (const chat of [...trackedChats]) {
    await disposeRuntimeChat(chat);
  }
}

/** Honest construction/disposal accounting for the suite report. */
export function runtimeChatCounts(): {
  constructed: number;
  /** Tracked chats teardown-processed (registry removals). */
  disposed: number;
  /** Of those, how many actually disposed a live session. */
  sessionsDisposed: number;
  tracked: number;
} {
  return {
    constructed: chatsConstructed,
    disposed: chatsDisposed,
    sessionsDisposed,
    tracked: trackedChats.size,
  };
}

/**
 * Run a compaction with a bounded deadline, always clearing the deadline timer
 * and aborting the compaction only when the deadline actually expires.
 *
 * A plain `Promise.race` leaks the timeout: when the compaction wins, the timer
 * stays armed and can later fire against an already-disposed session.
 */
export async function withCompactionTimeout<T>(
  run: () => Promise<T>,
  abort: () => void,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort();
      reject(new Error(`compaction timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function createRuntimeTempDirectory(
  prefix = 'funkyoctopus-runtime-',
): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.add(path);
  return path;
}

export async function createRuntimeGitRepository(): Promise<string> {
  const path = await createRuntimeTempDirectory('funkyoctopus-runtime-git-');
  await execFileAsync('git', ['init', '--quiet'], { cwd: path });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=FunkyOctopus Runtime',
      '-c',
      'user.email=runtime@funkyoctopus.test',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Initial commit',
    ],
    { cwd: path },
  );
  return path;
}

export async function createRuntimeSessionDirectory(): Promise<string> {
  const root = await createRuntimeTempDirectory('funkyoctopus-runtime-sessions-');
  const path = join(root, 'sessions');
  await mkdir(path);
  return path;
}

export async function createRuntimeVaultFile(rules: readonly VaultRule[] = []): Promise<string> {
  const root = await createRuntimeTempDirectory('funkyoctopus-runtime-vault-');
  const path = join(root, 'vault.json');
  await writeFile(path, `${JSON.stringify(rules, null, 2)}\n`);
  return path;
}

export async function cleanupRuntimeEnvironment(): Promise<void> {
  // Live sessions must be disposed before their temp fixtures are removed.
  await disposeAllRuntimeChats();
  const paths = [...cleanupPaths];
  cleanupPaths.clear();
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

afterAll(cleanupRuntimeEnvironment);
