import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { ClaudeCodeChat, type ClaudeCodeChatDeps } from '../claude-code/chat.ts';
import type { ToolGuard } from '../pi/pi-chat.ts';
import { FakeClaude, MAX_ACCOUNT, type ScriptItem } from './fake-claude-query.ts';
import { FakeSessions } from './fake-claude-sessions.ts';
import { turnFixture, type TurnName } from './claude-fixtures.ts';

export const ROOT = '/home/example/project';
export const NOBODY_BLOCKED: ToolGuard = { guard: () => Promise.resolve(undefined) };

/** The idle timer, by hand: the engine schedules into it and a test decides when it fires. */
export class ManualTimers {
  private readonly items: { run: () => void; ms: number; live: boolean }[] = [];

  readonly schedule = (run: () => void, ms: number): (() => void) => {
    const item = { run, ms, live: true };
    this.items.push(item);
    return () => {
      item.live = false;
    };
  };

  /** Timers set and not yet fired or cancelled. */
  pending(): { ms: number }[] {
    return this.items.filter((item) => item.live).map(({ ms }) => ({ ms }));
  }

  /** Fires the newest pending timer, as its delay running out would. */
  fire(): void {
    const item = [...this.items].reverse().find((candidate) => candidate.live);
    if (!item) throw new Error('ManualTimers: nothing is scheduled');
    item.live = false;
    item.run();
  }
}

/** An engine over a scripted `claude` and scripted stored sessions: the named recorded turns answer its sends, in order. */
export function harness(
  turns: (TurnName | ScriptItem)[],
  // `guard: null` leaves the engine to build its own Vault guard (from `vaultPath`).
  overrides: Omit<Partial<ClaudeCodeChatDeps>, 'guardFactory'> & { guard?: ToolGuard | null } = {},
  models: unknown[] | Error = [],
  account: ConstructorParameters<typeof FakeClaude>[2] = MAX_ACCOUNT,
) {
  const { guard = NOBODY_BLOCKED, ...rest } = overrides;
  const fake = new FakeClaude(
    turns.map((turn) => (typeof turn === 'string' ? turnFixture(turn) : turn)),
    models,
    account,
  );
  const sessions = new FakeSessions();
  const timers = new ManualTimers();
  const chat = new ClaudeCodeChat({
    query: fake.query,
    bin: 'claude',
    version: '9.9.9',
    root: ROOT,
    env: { PATH: '/usr/bin', HOME: '/home/example', ANTHROPIC_API_KEY: 'sk-leak', CLAUDECODE: '1' },
    resolveBin: () => Promise.resolve('/opt/claude/bin/claude'),
    sessions,
    folderExists: () => Promise.resolve(true),
    scheduleIdle: timers.schedule,
    ...(guard ? { guardFactory: () => Promise.resolve(guard) } : {}),
    ...rest,
  });
  return { chat, fake, sessions, timers };
}

export async function drain(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

export const send = (chat: ClaudeCodeChat, text: string, opts = {}) =>
  drain(chat.send(text, new AbortController().signal, opts));

export const textOf = (chunks: ChatChunk[]): string =>
  chunks.flatMap((chunk) => (chunk.kind === 'text' ? [chunk.delta] : [])).join('');

/** Collects what a client following the shared session sees, until `end`. */
export function follow(chat: ClaudeCodeChat) {
  const stop = new AbortController();
  const seen: ChatChunk[] = [];
  const done = (async () => {
    for await (const chunk of chat.observe(stop.signal)) seen.push(chunk);
  })();
  return { seen, done, end: () => { stop.abort(); return done; } };
}
