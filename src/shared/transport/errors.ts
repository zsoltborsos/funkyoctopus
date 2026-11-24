/**
 * Typed error codes that survive the WebSocket wire in both directions.
 *
 * Shared by the sidecar and the browser: seams throw a `WireCallError` with a
 * code, the transport copies the code into the wire envelope, and the client
 * rejects with the same typed error — so the browser can say something humane
 * about *which* backend is missing instead of surfacing a raw message.
 */

/** Codes a seam raises when its backend is not running. Browser copy maps each to one humane line. */
export const UNAVAILABLE_CODES = {
  helmraiser: 'helmraiser_unavailable',
  // the Leeboard seam's in-band code: `lb` could not be run (server/src/leeboard/reads.ts)
  leeboard: 'leeboard_unavailable',
} as const;

export type UnavailableCode = (typeof UNAVAILABLE_CODES)[keyof typeof UNAVAILABLE_CODES];

/** `projects.resolve`: the path is missing or not a directory (not a transport failure). */
export const FOLDER_NOT_FOUND = 'folder_not_found';

/** `helmraiser.draft`: the project is not one of the projects Leeboard lists. */
export const BAD_PROJECT = 'bad_project';

/** `helmraiser.propose`/`helmraiser.queue`: the path is not a task file under a known project. */
export const BAD_TASK_PATH = 'bad_task_path';

/** `chat.open`: the path is not a pi session file inside pi's session store. */
export const BAD_SESSION_PATH = 'bad_session_path';

/** `chat.send`: another client turn is already running on the shared session. */
export const TURN_IN_PROGRESS = 'turn_in_progress';

/**
 * `chat.send` (Claude Code engine): the conversation is also open in another Claude
 * Code, so the engine stopped rather than fork it. A next send continues as a fork.
 */
export const CLAUDE_LIVE_ELSEWHERE = 'claude_live_elsewhere';

/**
 * `chat.send` (Claude Code engine): starting another `claude` process would pass
 * the cap on running Claude processes across chat slots. Nothing was started.
 */
export const CLAUDE_CAP_REACHED = 'claude_cap_reached';

/** Chat slots: the slot cap is reached, so no slot was created. */
export const CHAT_CAP_REACHED = 'chat_cap_reached';

/** Chat slots: no slot has that id. */
export const CHAT_NOT_FOUND = 'chat_not_found';

/** Chat slots: `main` always exists and is never closed. */
export const CHAT_PERMANENT = 'chat_permanent';

/** Chat slots: the sidecar is shutting down, so no slot is created. */
export const SHUTTING_DOWN = 'shutting_down';

/** `chat.send`: the chat was closed (a forced `chat.close`, or shutdown) while the turn ran. */
export const CHAT_CLOSED = 'chat_closed';

/** Chat slots: a session of one engine cannot be opened in a slot of the other. */
export const CHAT_ENGINE_MISMATCH = 'engine_mismatch';

/** An Error that carries a wire code. Thrown by seams server-side; rejected with client-side. */
export class WireCallError extends Error {
  // `| undefined` is required by exactOptionalPropertyTypes: the constructor may
  // be handed an undefined code, and the property stays optional for readers.
  readonly code?: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WireCallError';
    this.code = code;
  }
}

/** The code on any thrown value, or undefined. Accepts WireCallError and any Error with a string `code`. */
export function wireErrorCode(e: unknown): string | undefined {
  if (!(e instanceof Error)) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
