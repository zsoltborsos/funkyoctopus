import type { HelmraiserLogEvent, HelmraiserLogResult } from '../../../src/shared/transport/protocol.ts';

/** Events kept per read: the last ones, which are where a failure shows. */
export const HELMRAISER_LOG_LIMIT = 200;

/** A string field longer than this keeps its two ends; one pi message can run to 100 KB. */
const FIELD_LIMIT = 4_000;
const KEEP_HEAD = 1_500;
const KEEP_TAIL = 2_500;

/** Both ends survive: the head says what it is, the tail (a check's output) says how it ended. */
function clamp(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= FIELD_LIMIT
      ? value
      : `${value.slice(0, KEEP_HEAD)}\n… [${value.length - KEEP_HEAD - KEEP_TAIL} characters omitted] …\n${value.slice(-KEEP_TAIL)}`;
  }
  if (Array.isArray(value)) return value.map(clamp);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clamp(inner)]));
  }
  return value;
}

function parseEvent(line: string): HelmraiserLogEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { id, ts, type, source, stage, payload } = raw as Record<string, unknown>;
  if (typeof id !== 'number' || typeof ts !== 'number' || typeof type !== 'string') return null;
  return {
    id,
    ts,
    source: typeof source === 'string' ? source : '',
    stage: typeof stage === 'string' ? stage : null,
    type,
    payload: typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? clamp(payload) as Record<string, unknown>
      : {},
  };
}

/**
 * Turns the retained `helmraiser log --json` lines into events, skipping any line
 * that is not a ledger event. `total` is how many lines helmraiser printed in all,
 * so `truncated` says earlier ones were left out.
 */
export function parseHelmraiserLog(lines: string[], total: number): HelmraiserLogResult {
  const events = lines.flatMap((line) => parseEvent(line) ?? []);
  return { events, truncated: total > lines.length };
}
