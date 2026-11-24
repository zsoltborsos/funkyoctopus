import type { HelmraiserLogEvent } from '@shared/transport/protocol.ts';

/** One timeline line is at most this long, whatever the payload held. */
const SUMMARY_CHARS = 160;
/** Lines of a failed check's output shown under it. */
const TAIL_LINES = 6;
/** Terminal colour and cursor sequences in a check's captured output. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

type Payload = Record<string, unknown>;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
const record = (value: unknown): Payload | undefined =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Payload : undefined);
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Whole seconds from ten up, a decimal below. */
const seconds = (n: number): string => `${n >= 10 ? Math.round(n) : n.toFixed(1)} s`;

/** Local `HH:MM:SS` of an event's epoch-seconds timestamp. */
export function clockTime(ts: number): string {
  const date = new Date(ts * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The text of a pi message: its text parts, or the content itself when it is a plain string. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
  }).join(' ');
}

function messageEnd(payload: Payload): string | undefined {
  const message = record(payload.message);
  const role = text(message?.role);
  if (!message || !role) return undefined;
  if (role === 'system') return 'system prompt';
  const body = oneLine(messageText(message.content));
  if (role === 'toolResult') return `toolResult ${text(message.toolName) ?? '?'}: ${body}`;
  if (body) return `${role}: ${body}`;
  const parts = Array.isArray(message.content) ? message.content.map(record) : [];
  const calls = parts.filter((part) => part?.type === 'toolCall').length;
  if (calls > 0) return `${role}: ${plural(calls, 'tool call')}`;
  return parts.some((part) => part?.type === 'thinking') ? `${role}: thinking` : `${role}:`;
}

function toolStart(payload: Payload): string | undefined {
  const name = text(payload.toolName);
  if (!name) return undefined;
  const args = Object.fromEntries(Object.entries(record(payload.args) ?? {}).filter(([, value]) => value !== null));
  return Object.keys(args).length > 0 ? `${name} ${JSON.stringify(args)}` : name;
}

/** Each type's one-liner; a payload that does not have the expected fields falls back to the excerpt. */
const SUMMARIES: Record<string, (payload: Payload) => string | undefined> = {
  run_start: (p) => (text(p.task_id) ? `task ${text(p.task_id)}${text(p.pi_version) ? ` · pi ${text(p.pi_version)}` : ''}` : undefined),
  routing: (p) => (text(p.lever) && text(p.reason) ? `${text(p.lever)}: ${text(p.reason)}` : undefined),
  preflight: (p) => (text(p.pi_version) ? `pi ${text(p.pi_version)} · auth ${text(p.auth) ?? '?'}` : undefined),
  base_sync: (p) => (text(p.status) ? `${text(p.status)}${text(p.reason) ? ` (${text(p.reason)})` : ''}` : undefined),
  worktree_created: (p) => text(p.branch),
  setup_start: (p) => (count(p.timeout) !== undefined ? `setup script, timeout ${count(p.timeout)} s` : 'setup script'),
  setup_result: (p) => (typeof p.ok === 'boolean'
    ? `${p.ok ? 'ok' : 'failed'} · exit ${count(p.exit_code) ?? '?'}${count(p.seconds) !== undefined ? ` · ${seconds(count(p.seconds) ?? 0)}` : ''}`
    : undefined),
  stage_start: (p) => text(p.stage),
  iteration_start: (p) => (count(p.n) !== undefined
    ? `iteration ${count(p.n)}, attempt ${count(p.attempt) ?? '?'}${text(p.model) ? ` · ${text(p.model)}` : ''}`
    : undefined),
  plan_written: (p) => (text(p.path) ? `${text(p.path)}${count(p.chars) !== undefined ? ` (${count(p.chars)} chars)` : ''}` : undefined),
  service_start: (p) => text(p.name),
  service_ready: (p) => (text(p.name) ? `${text(p.name)} ready${count(p.seconds) !== undefined ? ` in ${seconds(count(p.seconds) ?? 0)}` : ''}` : undefined),
  service_failed: (p) => (text(p.name) ? `${text(p.name)}${text(p.reason) ? `: ${text(p.reason)}` : ''}` : undefined),
  service_stop: (p) => (Array.isArray(p.removed) ? `removed ${plural(p.removed.length, 'container')}` : undefined),
  blocked_to_verify: (p) => text(p.reason),
  verify_result: (p) => {
    const failed = (Array.isArray(p.results) ? p.results : []).flatMap((item) => {
      const check = record(item);
      return check?.passed === false && text(check.name) ? [text(check.name) as string] : [];
    });
    if (failed.length > 0) return `failed: ${failed.join(', ')}`;
    if (p.passed === false) return 'failed';
    return Array.isArray(p.results) ? `passed: ${plural(p.results.length, 'check')}` : 'passed';
  },
  // The failure reason is long; the timeline prints it in full under the row.
  run_end: (p) => text(p.status),
  message_end: messageEnd,
  tool_execution_start: toolStart,
  tool_execution_end: (p) => (text(p.toolName) ? `${text(p.toolName)} ${p.isError === true ? 'error' : 'ok'}` : undefined),
  // The type column already says it.
  session: () => '',
  agent_start: () => '',
  agent_end: () => '',
  agent_settled: () => '',
  turn_start: () => '',
};

const cap = (line: string): string => (line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line);

/** A short excerpt of a payload no summary knows, so a type helmraiser adds later still shows something. */
const excerpt = (payload: Payload): string => (Object.keys(payload).length > 0 ? JSON.stringify(payload) : '');

/** The one line a timeline row shows for an event; never longer than {@link SUMMARY_CHARS}. */
export function summarize(event: HelmraiserLogEvent): string {
  return cap(oneLine(SUMMARIES[event.type]?.(event.payload) ?? excerpt(event.payload)));
}

/**
 * The last lines of a failed check's output, without terminal colours. Says how many earlier
 * lines were left out; empty when the check printed nothing.
 */
export function failedCheckTail(tail: string): string {
  const lines = tail.replace(ANSI, '').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (lines.length <= TAIL_LINES) return lines.join('\n');
  const omitted = lines.length - TAIL_LINES;
  return [`… ${plural(omitted, 'earlier line')}`, ...lines.slice(-TAIL_LINES)].join('\n');
}

/** One check of a `verify_result`, ready to list: its pass/fail line, and the tail when it failed. */
export interface VerifyCheck {
  line: string;
  passed: boolean;
  /** The last lines of a failed check's output; empty for a passing check. */
  tail: string;
}

export function verifyChecks(payload: Payload): VerifyCheck[] {
  return (Array.isArray(payload.results) ? payload.results : []).flatMap((item) => {
    const check = record(item);
    const name = text(check?.name);
    if (!check || !name) return [];
    const passed = check.passed === true;
    const exit = !passed && count(check.exit_code) !== undefined ? ` · exit ${count(check.exit_code)}` : '';
    const took = count(check.seconds) !== undefined ? ` · ${seconds(count(check.seconds) ?? 0)}` : '';
    return [{
      line: `${passed ? 'PASS' : 'FAIL'} ${name}${exit}${took}`,
      passed,
      tail: passed ? '' : failedCheckTail(text(check.tail) ?? ''),
    }];
  });
}
