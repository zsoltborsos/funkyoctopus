import { WireCallError } from '../../../src/shared/transport/errors.ts';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import { isRecord } from '../util/records.ts';

export const CLAUDE_NOT_LOGGED_IN = 'claude_not_logged_in';
/** What the owner is told when Claude Code has no login; the fix is theirs, in a terminal. */
export const NOT_LOGGED_IN_MESSAGE = 'Claude Code is not logged in — run `claude`, then /login, in a terminal';
export const CLAUDE_RATE_LIMITED = 'claude_rate_limited';
export const CLAUDE_TURN_ERROR = 'claude_turn_error';

/** What one SDK message did to the turn: chunks to stream, and whether the turn is over. */
export interface MapStep {
  chunks: ChatChunk[];
  /** Set by the turn's `result`; `error` is the failure the browser should see. */
  end?: { error?: Error };
}

const KEEP_GOING: MapStep = { chunks: [] };

/** The input side of one API request, as the assistant message reports it. */
interface RequestUsage {
  model: string;
  tokens: number;
}

/** The most recent `rate_limit_event`: Claude Code sends one every turn, and a rejection names its reset. */
interface RateLimit {
  status: unknown;
  resetsAt: unknown;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');

/** `Sat 18:30` in the sidecar's local time; the five-hour and weekly windows reset on different days. */
function resetTime(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  return `${DAYS[at.getDay()]} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The humane failure for an assistant message's `error`; the CLI's own wording is not shown. */
function assistantFailure(error: string, rateLimit: RateLimit | null): WireCallError {
  if (error === 'authentication_failed') {
    return new WireCallError(NOT_LOGGED_IN_MESSAGE, CLAUDE_NOT_LOGGED_IN);
  }
  if (error === 'rate_limit') {
    const reset =
      rateLimit?.status === 'rejected' && typeof rateLimit.resetsAt === 'number'
        ? ` — resets at ${resetTime(rateLimit.resetsAt)}`
        : '';
    return new WireCallError(`Claude Code hit its usage limit${reset}`, CLAUDE_RATE_LIMITED);
  }
  return new WireCallError(`Claude Code could not finish the turn (${error})`, CLAUDE_TURN_ERROR);
}

/** An error `result` that no assistant message explained, in its own words. */
function resultFailure(result: Record<string, unknown>): WireCallError {
  const errors: unknown[] = Array.isArray(result.errors) ? result.errors : [];
  const own = typeof result.result === 'string' && result.result !== '' ? result.result : errors[0];
  const subtype = typeof result.subtype === 'string' ? result.subtype : 'error';
  return new WireCallError(
    typeof own === 'string' && own !== '' ? own : `Claude Code ended the turn (${subtype})`,
    CLAUDE_TURN_ERROR,
  );
}

const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Claude Code already caps what its tools return; this bounds the wire frame regardless. */
const TOOL_OUTPUT_LIMIT = 30_000;
const SUMMARY_LIMIT = 120;

/** The input field that names what a tool is working on, for the one-line step label. */
const SUMMARY_FIELD: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
};

/** `Bash: <first line of the command>`; a tool without a known field is just its name. */
export function toolSummary(tool: string, input: unknown): string {
  const field = SUMMARY_FIELD[tool];
  const value = field !== undefined && isRecord(input) ? input[field] : undefined;
  if (typeof value !== 'string') return tool;
  const line = value.split('\n')[0]?.trim() ?? '';
  if (line === '') return tool;
  return `${tool}: ${line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line}`;
}

/** A tool result's text: a plain string, or the text parts of a block list; undefined when empty. */
function resultOutput(content: unknown): string | undefined {
  const text = Array.isArray(content)
    ? content
        .flatMap((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
        .join('\n')
    : typeof content === 'string'
      ? content
      : '';
  if (text === '') return undefined;
  return text.length > TOOL_OUTPUT_LIMIT
    ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… [${text.length - TOOL_OUTPUT_LIMIT} more characters not shown]`
    : text;
}

function textOf(block: unknown): ChatChunk[] {
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text !== ''
    ? [{ kind: 'text', delta: block.text }]
    : [];
}

export function toolResultChunk(block: unknown): ChatChunk[] {
  if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return [];
  const output = resultOutput(block.content);
  const chunk: ChatChunk = { kind: 'tool-result', callId: block.tool_use_id, ok: block.is_error !== true };
  if (block.is_error === true) chunk.error = output ?? 'Tool execution failed';
  else if (output !== undefined) chunk.output = output;
  return [chunk];
}

/**
 * Maps the Agent SDK's message stream onto the wire's chunk vocabulary. Pure:
 * no I/O, no throwing — a message it does not recognise maps to nothing, so a
 * newer `claude` that adds message types cannot break a turn. One mapper lives
 * as long as a Claude Code session and carries the per-turn state between
 * messages; `result` closes the turn and clears it.
 */
export class ChunkMapper {
  /** API message ids whose text and thinking already streamed as deltas. */
  private streamed = new Set<string>();
  private currentMessageId: string | null = null;
  private lastRequest: RequestUsage | null = null;
  private toolUses = new Set<string>();
  private rateLimit: RateLimit | null = null;
  private failure: Error | null = null;

  map(message: unknown): MapStep {
    if (!isRecord(message)) return KEEP_GOING;
    // Subagent traffic is not this conversation (yet).
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return KEEP_GOING;
    switch (message.type) {
      case 'stream_event':
        return this.streamEvent(message.event);
      case 'assistant':
        return this.assistant(message);
      case 'user':
        return this.user(message);
      case 'rate_limit_event':
        if (isRecord(message.rate_limit_info)) {
          const { status, resetsAt } = message.rate_limit_info;
          this.rateLimit = { status, resetsAt };
        }
        return KEEP_GOING;
      case 'system':
        if (message.subtype === 'compact_boundary') return this.compaction(message);
        if (message.subtype === 'local_command_output' || message.subtype === 'informational') return this.note(message);
        return KEEP_GOING;
      case 'result':
        return this.result(message);
      default:
        return KEEP_GOING;
    }
  }

  /**
   * What a local command printed (`/context`, `/rename`, …), or a banner the
   * CLI shows (a hook's feedback, a notice): shown as the turn's own text, as
   * the CLI shows it in its transcript. It stands apart from any text around
   * it. An `info` banner is left out: the CLI shows those only in its verbose
   * transcript mode.
   */
  private note(message: Record<string, unknown>): MapStep {
    if (typeof message.content !== 'string' || message.content.trim() === '') return KEEP_GOING;
    if (message.subtype === 'informational' && message.level === 'info') return KEEP_GOING;
    return { chunks: [{ kind: 'text', delta: `\n\n${message.content.trim()}\n\n` }] };
  }

  /** The context was compacted; a boundary without a trigger and a size says nothing worth showing. */
  private compaction(message: Record<string, unknown>): MapStep {
    const meta = message.compact_metadata;
    if (!isRecord(meta) || (meta.trigger !== 'manual' && meta.trigger !== 'auto')) return KEEP_GOING;
    if (typeof meta.pre_tokens !== 'number') return KEEP_GOING;
    return {
      chunks: [{
        kind: 'compaction',
        trigger: meta.trigger,
        preTokens: meta.pre_tokens,
        ...(typeof meta.post_tokens === 'number' ? { postTokens: meta.post_tokens } : {}),
      }],
    };
  }

  private streamEvent(event: unknown): MapStep {
    if (!isRecord(event)) return KEEP_GOING;
    if (event.type === 'message_start' && isRecord(event.message)) {
      this.currentMessageId = typeof event.message.id === 'string' ? event.message.id : null;
      return KEEP_GOING;
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return KEEP_GOING;
    if (this.currentMessageId !== null) this.streamed.add(this.currentMessageId);
    const { delta } = event;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      return { chunks: [{ kind: 'text', delta: delta.text }] };
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
      return { chunks: [{ kind: 'thinking', delta: delta.thinking }] };
    }
    return KEEP_GOING;
  }

  private assistant(message: Record<string, unknown>): MapStep {
    const body = message.message;
    if (!isRecord(body)) return KEEP_GOING;
    // The turn does not end here: the error `result` follows, and carries this failure out.
    if (typeof message.error === 'string') this.failure ??= assistantFailure(message.error, this.rateLimit);
    const usage = isRecord(body.usage) ? body.usage : null;
    if (usage && typeof body.model === 'string' && body.model !== '<synthetic>') {
      this.lastRequest = {
        model: body.model,
        tokens:
          count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
      };
    }
    const content = Array.isArray(body.content) ? body.content : [];
    // Deltas already carried the text of a streamed message; a reply that never
    // streamed (a local command's synthetic one) is shown whole. An error
    // message's text is the failure itself, which the stream reports instead.
    const streamed = typeof body.id === 'string' && this.streamed.has(body.id);
    const whole = streamed || message.error !== undefined ? [] : content.flatMap(textOf);
    return { chunks: [...whole, ...content.flatMap((block) => this.toolCall(block))] };
  }

  /** A tool call is complete only in the whole `assistant` message; the stream carries it as JSON fragments. */
  private toolCall(block: unknown): ChatChunk[] {
    if (!isRecord(block) || block.type !== 'tool_use') return [];
    if (typeof block.id !== 'string' || typeof block.name !== 'string') return [];
    if (this.toolUses.has(block.id)) return [];
    this.toolUses.add(block.id);
    return [{
      kind: 'tool-call',
      callId: block.id,
      tool: block.name,
      summary: toolSummary(block.name, block.input),
      args: block.input,
    }];
  }

  private user(message: Record<string, unknown>): MapStep {
    const body = message.message;
    // Plain-string content is a local command's echo (`setModel` writes one), not a tool result.
    const content = isRecord(body) && Array.isArray(body.content) ? body.content : [];
    return { chunks: content.flatMap(toolResultChunk) };
  }

  private result(message: Record<string, unknown>): MapStep {
    const chunks: ChatChunk[] = [];
    const request = this.lastRequest;
    const usage = isRecord(message.modelUsage) && request ? message.modelUsage[request.model] : undefined;
    const contextWindow = isRecord(usage) ? usage.contextWindow : undefined;
    if (request && typeof contextWindow === 'number' && contextWindow > 0) {
      chunks.push({
        kind: 'usage',
        tokens: request.tokens,
        contextWindow,
        percent: (request.tokens / contextWindow) * 100,
      });
    }
    // `interrupt()` ends the turn as an error result whose terminal reason says it
    // was aborted; the owner asked for that, so it is not shown as a failure.
    const stopped = typeof message.terminal_reason === 'string' && message.terminal_reason.startsWith('aborted');
    const error = this.failure ?? (message.is_error === true && !stopped ? resultFailure(message) : null);
    this.streamed = new Set();
    this.toolUses = new Set();
    this.currentMessageId = null;
    this.lastRequest = null;
    this.failure = null;
    return { chunks, end: error ? { error } : {} };
  }
}
