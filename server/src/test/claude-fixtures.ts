import { readFileSync } from 'node:fs';

/**
 * One recorded Claude Code turn (see `claude-code/fixtures/turn-*.json`):
 * the real SDK messages from `system/init` to `result`, plus what the CLI asked
 * the PreToolUse hook. `awaitInterruptAt` is the index of the first message
 * that only flowed once `interrupt()` had been called.
 */
export interface TurnFixture {
  description: string;
  /** The `uuid` of the prompt this recording answered, when it carried one; its stamps name it. */
  stampedWith?: string;
  /** False makes the fake play the turn unstamped, as a CLI that predates the stamps would. */
  stamp?: boolean;
  hookInputs: Record<string, unknown>[];
  awaitInterruptAt: number | null;
  messages: Record<string, unknown>[];
}

export type TurnName =
  | 'plain'
  | 'bash'
  | 'interrupted'
  | 'after-interrupt'
  | 'denied'
  | 'set-model'
  | 'auth-failed'
  | 'stamped'
  | 'background'
  | 'unsolicited'
  | 'compact';

export function turnFixture(name: TurnName): TurnFixture {
  const url = new URL(`../claude-code/fixtures/turn-${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as TurnFixture;
}

/** The id every recorded turn ran in (their `session_id`s, as redacted). */
export const RECORDED_SESSION = '11111111-1111-4111-8111-111111111111';

/** A recorded turn as if its process had reported `sessionId`, the way a fork reports the id of its copy. */
export function inSession(turn: TurnFixture, sessionId: string): TurnFixture {
  return JSON.parse(JSON.stringify(turn).replaceAll(RECORDED_SESSION, sessionId)) as TurnFixture;
}
