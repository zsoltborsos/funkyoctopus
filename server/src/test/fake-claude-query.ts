import type { AccountInfo, Options, SDKMessage, SDKUserMessage, SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeQuery, ClaudeQueryFn } from '../claude-code/chat.ts';
import { AsyncQueue } from '../util/async-queue.ts';
import type { TurnFixture } from './claude-fixtures.ts';

type SetModel = (model?: string) => Promise<void>;
type ApplyFlagSettings = (settings: { effortLevel?: string | null }) => Promise<void>;
type Message = Record<string, unknown>;

/** A prompt the fake accepts but does not start (as one queued behind a running turn), until it is cancelled or `startHeld()`. */
export interface HeldPrompt {
  held: TurnFixture;
}
export const held = (turn: TurnFixture): HeldPrompt => ({ held: turn });
export type ScriptItem = TurnFixture | HeldPrompt;

/** The login shape measured on the owner's Max plan (2026-10-17), minus the account itself. */
export const MAX_ACCOUNT: AccountInfo = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' };

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * What the CLI stamps on a turn that answers a prompt carrying a `uuid`:
 * `user_message_uuid(s)` on its `system/init`, `system/status` and `result`. A
 * turn the CLI starts on its own carries none (measured on 2.1.302, 2026-10-17).
 * Recordings made with a stamp get the prompt's uuid swapped in; unstamped ones
 * (recorded before prompts carried a uuid) get stamps in those three places.
 */
function stamped(turn: TurnFixture, uuid: string | undefined): Message[] {
  // A CLI that predates the stamps also predates `msg_lifecycle_v1`: it reports capabilities, without that one.
  if (turn.stamp === false) {
    return turn.messages.map((message) =>
      message.type === 'system' && message.subtype === 'init' ? { ...message, capabilities: ['interrupt_receipt_v1'] } : message,
    );
  }
  if (uuid === undefined) return turn.messages;
  if (turn.stampedWith !== undefined) {
    return JSON.parse(JSON.stringify(turn.messages).replaceAll(turn.stampedWith, uuid)) as Message[];
  }
  return turn.messages.map((message) =>
    message.type === 'result' || (message.type === 'system' && (message.subtype === 'init' || message.subtype === 'status'))
      ? { ...message, user_message_uuid: uuid, user_message_uuids: [uuid] }
      : message,
  );
}

/** One turn being played: it can be stopped by `interrupt()`, and held back at a message. */
interface Playback {
  interrupted: boolean;
  wake?: (() => void) | undefined;
}

/**
 * A scripted stand-in for the `claude` process behind the Agent SDK's `query()`.
 * It is the boundary the engine is tested at: every user message pushed into the
 * input stream is answered with the next recorded turn, and the control calls
 * the engine makes (interrupt, setModel, …) are recorded. Nothing is spawned.
 *
 * Like the CLI it runs one turn at a time: a prompt that arrives while a turn is
 * playing waits its turn. It also plays the CLI's part in tool use: when a
 * recorded turn announces a tool call it asks the registered PreToolUse hooks
 * first, with the input the CLI really sent (`hookInputs`), and only then lets
 * the recorded result through. `startUnsolicited` plays a turn nobody asked for.
 */
export class FakeQuery implements ClaudeQuery {
  /** Every user message the engine pushed, in order. */
  readonly inputs: SDKUserMessage[] = [];
  /** Control calls in order, e.g. `interrupt`, `setModel:sonnet`, `close`. */
  readonly calls: string[] = [];
  readonly effortSettings: unknown[] = [];
  /** What each PreToolUse hook answered, in call order. */
  readonly hookAnswers: unknown[] = [];
  /** How many times the engine asked which models the process supports. */
  supportedModelsAsked = 0;
  /** True makes `interrupt()` a no-op on the running turn, as when the CLI ignores it. */
  ignoreInterrupts = false;
  /** True makes `close()` leave the process running, as when it is slow to die. */
  survivesClose = false;
  private readonly out = new AsyncQueue<SDKMessage>();
  private cli: Promise<void> = Promise.resolve();
  private current: Playback | null = null;
  private readonly parked: { uuid: string | undefined; turn: TurnFixture }[] = [];
  /** False makes `interrupt({ cancelQueued })` behave as on a CLI that ignores the option. */
  honourCancelQueued = true;

  constructor(
    readonly params: { prompt: AsyncIterable<SDKUserMessage>; options: Options },
    private readonly script: ScriptItem[],
    private readonly models: unknown[] | Error,
    private readonly account: () => Promise<AccountInfo>,
  ) {
    void this.drive();
  }

  get options(): Options {
    return this.params.options;
  }

  /** The CLI runs one turn at a time; later turns queue behind it. */
  private exclusive(run: () => Promise<void>): Promise<void> {
    const turn = this.cli.then(run);
    this.cli = turn.catch(() => undefined);
    return turn;
  }

  private async drive(): Promise<void> {
    for await (const input of this.params.prompt) {
      this.inputs.push(input);
      this.calls.push('input');
      const item = this.script.shift();
      if (item === undefined) throw new Error('FakeQuery: a user message arrived with no recorded turn left');
      if ('held' in item) {
        this.parked.push({ uuid: input.uuid, turn: item.held });
        continue;
      }
      void this.exclusive(() => this.play(item, stamped(item, input.uuid), item.awaitInterruptAt, input.uuid));
    }
  }

  /** The CLI gets round to the prompts it was holding: each now plays, stamped with its own uuid. */
  startHeld(): Promise<void> {
    const prompts = this.parked.splice(0);
    return Promise.all(
      prompts.map(({ uuid, turn }) => this.exclusive(() => this.play(turn, stamped(turn, uuid), turn.awaitInterruptAt, uuid))),
    ).then(() => undefined);
  }

  /**
   * The CLI drops the prompts it was holding without ever starting them, saying
   * only so in a `command_lifecycle` frame (its error path emits no `init`).
   */
  dropHeld(state: 'cancelled' | 'completed' = 'cancelled'): void {
    for (const { uuid } of this.parked.splice(0)) {
      this.out.push({ type: 'command_lifecycle', command_uuid: uuid, state } as unknown as SDKMessage);
    }
  }

  /**
   * Plays a turn the CLI started by itself (a background task finishing, a cron
   * firing): no prompt, so no stamps. `holdAt` parks it before that message
   * until `release()`; an interrupt ends it with an aborted result.
   */
  startUnsolicited(turn: TurnFixture, { holdAt }: { holdAt?: number } = {}): { release(): void; done: Promise<void> } {
    const playback: Playback = { interrupted: false };
    const done = this.exclusive(() => this.play(turn, turn.messages, null, undefined, playback, holdAt));
    return { release: () => playback.wake?.(), done };
  }

  private async play(
    turn: TurnFixture,
    messages: Message[],
    awaitInterruptAt: number | null,
    /** The prompt this turn answers: an aborted turn's result names it, as the CLI's does. */
    prompt?: string,
    playback: Playback = { interrupted: false },
    holdAt?: number,
  ): Promise<void> {
    this.current = playback;
    for (const [index, message] of messages.entries()) {
      if (index === holdAt) await new Promise<void>((resolve) => { playback.wake = resolve; });
      if (index === awaitInterruptAt && !playback.interrupted) {
        await new Promise<void>((resolve) => { playback.wake = resolve; });
      }
      // A recorded interrupt replays its own aborted tail; any other turn is cut short.
      if (playback.interrupted && awaitInterruptAt === null) {
        this.out.push({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          terminal_reason: 'aborted_streaming',
          ...(prompt !== undefined && turn.stamp !== false ? { user_message_uuid: prompt, user_message_uuids: [prompt] } : {}),
        } as unknown as SDKMessage);
        break;
      }
      this.out.push(message as unknown as SDKMessage);
      if (message.type === 'assistant') await this.askHooks(turn, message);
      await nextTurn();
    }
    this.current = null;
  }

  private async askHooks(turn: TurnFixture, message: Message): Promise<void> {
    const content = (message.message as { content?: { type: string; id?: string; name?: string; input?: unknown }[] }).content ?? [];
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const recorded = turn.hookInputs.find((input) => input.tool_use_id === block.id);
      const input = recorded ?? { hook_event_name: 'PreToolUse', tool_name: block.name, tool_input: block.input, tool_use_id: block.id };
      for (const matcher of this.options.hooks?.PreToolUse ?? []) {
        for (const hook of matcher.hooks) {
          this.hookAnswers.push(await hook(input as never, block.id, { signal: new AbortController().signal }));
        }
      }
    }
  }

  /** Simulates the process dying: the message stream just ends. */
  exit(): void {
    this.out.close();
  }

  interrupt: ClaudeQuery['interrupt'] = (options) => {
    const cancelQueued = options?.cancelQueued === true;
    this.calls.push(cancelQueued ? 'interrupt:cancelQueued' : 'interrupt');
    if (!this.ignoreInterrupts && this.current) {
      this.current.interrupted = true;
      this.current.wake?.();
    }
    const uuids = this.parked.flatMap(({ uuid }) => (uuid === undefined ? [] : [uuid]));
    if (!cancelQueued || !this.honourCancelQueued) return Promise.resolve({ still_queued: uuids });
    this.parked.length = 0;
    for (const uuid of uuids) {
      this.out.push({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' } as unknown as SDKMessage);
    }
    return Promise.resolve({ still_queued: [], cancelled: uuids });
  };

  setModel: SetModel = (model) => {
    this.calls.push(`setModel:${model ?? ''}`);
    return Promise.resolve();
  };

  applyFlagSettings: ApplyFlagSettings = (settings) => {
    this.calls.push(`applyFlagSettings:${JSON.stringify(settings)}`);
    this.effortSettings.push(settings);
    return Promise.resolve();
  };

  /** What `supportedCommands()` answers; an Error rejects it. */
  commands: SlashCommand[] | Error = [];
  /** How many times the engine asked which commands the process has. */
  supportedCommandsAsked = 0;

  supportedCommands = (): ReturnType<ClaudeQuery['supportedCommands']> => {
    this.supportedCommandsAsked += 1;
    return this.commands instanceof Error ? Promise.reject(this.commands) : Promise.resolve(this.commands);
  };

  /** A frame the CLI sends outside any turn (e.g. `system/commands_changed`). */
  emit(message: Message): void {
    this.out.push(message as unknown as SDKMessage);
  }

  supportedModels = (): ReturnType<ClaudeQuery['supportedModels']> => {
    this.supportedModelsAsked += 1;
    return this.models instanceof Error
      ? Promise.reject(this.models)
      : Promise.resolve(this.models as Awaited<ReturnType<ClaudeQuery['supportedModels']>>);
  };

  accountInfo = (): ReturnType<ClaudeQuery['accountInfo']> => {
    this.calls.push('accountInfo');
    return this.account();
  };

  /** The CLI finally gets round to the interrupt it was ignoring: a stopped turn plays out its tail. */
  releaseStopped(): void {
    if (!this.current) return;
    this.current.interrupted = true;
    this.current.wake?.();
  }

  close(): void {
    this.calls.push('close');
    if (this.survivesClose) return;
    this.current?.wake?.();
    this.out.close();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void> {
    return this.out[Symbol.asyncIterator]() as AsyncIterator<SDKMessage, void>;
  }
}

/** The injected `query`: hands out one {@link FakeQuery} per call, all drawing on one shared script. */
export class FakeClaude {
  readonly queries: FakeQuery[] = [];
  /** Called with each process as it is created, before the engine has sent anything to it. */
  onStart: ((query: FakeQuery) => void) | undefined;
  private readonly account: (attempt: number) => Promise<AccountInfo>;

  /** `account` answers `accountInfo()` for the process started at that attempt (0 for the first). */
  constructor(
    private readonly script: ScriptItem[],
    private readonly models: unknown[] | Error = [],
    account: AccountInfo | Error | ((attempt: number) => Promise<AccountInfo>) = MAX_ACCOUNT,
  ) {
    this.account =
      typeof account === 'function'
        ? account
        : () => (account instanceof Error ? Promise.reject(account) : Promise.resolve(account));
  }

  readonly query: ClaudeQueryFn = (params) => {
    const attempt = this.queries.length;
    const query = new FakeQuery(params, this.script, this.models, () => this.account(attempt));
    this.queries.push(query);
    this.onStart?.(query);
    return query;
  };
}
