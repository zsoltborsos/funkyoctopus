/**
 * Readers for pi's tool-call arguments and tool-result payloads.
 *
 * Shared by the two places that turn pi tool activity into chat steps: the live
 * event stream (`pi-chat.ts`) and the stored-transcript projection
 * (`session-transcript.ts`). A live `tool_execution_end` event's `result` and a
 * persisted `ToolResultMessage` carry the same `{ content, details }` shape, so
 * both call sites read them the same way — and a rehydrated transcript renders
 * identically to the stream it came from.
 */

import { recordOf } from '../util/records.ts';
import { jsonSafeDetails } from './custom-message.ts';

export function record(value: unknown): Record<string, unknown> | null {
  return recordOf(value);
}

/** A one-line label for a tool call: the tool, plus its most identifying argument. */
export function toolSummary(tool: string, args: unknown): string {
  const input = record(args);
  const key = input?.path ?? input?.command ?? input?.query;
  return typeof key === 'string' && key ? `${tool}: ${key}` : tool;
}

/** The text parts of a tool result, joined; undefined when there is no text. */
export function resultText(result: unknown): string | undefined {
  const content = record(result)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => record(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part?.text as string)
    .join('\n');
  return text || undefined;
}

/** The unified diff an edit-style tool reports in `details`, when present. */
export function resultDiff(result: unknown): string | undefined {
  const details = record(record(result)?.details);
  return typeof details?.diff === 'string' ? details.diff : undefined;
}

/** JSON-safe tool-result details; undefined when the result carries none. */
export function resultDetails(result: unknown): unknown {
  const details = record(result)?.details;
  return details === undefined ? undefined : jsonSafeDetails(details);
}
