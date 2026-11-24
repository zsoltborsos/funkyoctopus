/**
 * Pure parsing/preview helpers for crew timeline cards.
 *
 * Everything here is defensive: documented pi-crew detail fields are narrowed
 * from untrusted wire data, malformed documented types degrade to the safe
 * generic card (never throw, never fabricate), and previews are bounded. No
 * Phase 4 correlation (spawn task, duration) is invented here.
 */

import { FUNKYOCTOPUS_NOTE } from '@shared/transport/protocol.ts';
import type { ChatEventItem } from './chat.types.ts';

/** Documented pi-crew result statuses (1.0.34 + the permissive 1.0.28 stored shape).
 * Anything else is malformed → generic. */
export const CREW_STATUSES = [
  'running',
  'completed',
  'needs_input',
  'waiting',
  'done',
  'error',
  'aborted',
] as const;
export type CrewStatus = (typeof CREW_STATUSES)[number];

export type CrewStatusTone = 'waiting' | 'success' | 'error';

/** Status → icon, human label and visual tone (labels mirror pi-crew's own). */
export const CREW_STATUS_META: Record<
  CrewStatus,
  { icon: string; label: string; tone: CrewStatusTone }
> = {
  running: { icon: '⏳', label: 'running', tone: 'waiting' },
  completed: { icon: '✅', label: 'completed', tone: 'success' },
  needs_input: { icon: '⏳', label: 'needs input', tone: 'waiting' },
  waiting: { icon: '⏳', label: 'waiting for response', tone: 'waiting' },
  done: { icon: '✅', label: 'done', tone: 'success' },
  error: { icon: '❌', label: 'failed', tone: 'error' },
  aborted: { icon: '⏹️', label: 'aborted', tone: 'error' },
};

/** Waiting cards advise replying through the parent chat — never a control. */
export const CREW_WAITING_HINT = 'Reply through the parent chat to respond to this subagent.';

/** Narrowed 1.0.34 result payload: only its documented string fields survive. */
export interface CrewResultPayload {
  outcome: 'completed' | 'needs_input';
  report?: string;
  needs?: string;
}

/** Narrowed, untrusted crew-result details. Only `status` is required. */
export interface CrewResultDetails {
  status: CrewStatus;
  agentId?: string;
  agentName?: string;
  sessionFile?: string;
  /** pi-crew 1.0.34: structured success payload (report / needs). */
  result?: CrewResultPayload;
  /** pi-crew 1.0.34: terminal error text. */
  error?: string;
  /** pi-crew 1.0.28 stored shape: the human-readable body. */
  body?: string;
}

/** Validate/narrow untrusted crew-result details; null when malformed. */
export function crewResultDetails(details: unknown): CrewResultDetails | null {
  if (typeof details !== 'object' || details === null) return null;
  const record = details as Record<string, unknown>;
  if (typeof record.status !== 'string' || !CREW_STATUSES.includes(record.status as CrewStatus)) {
    return null;
  }
  const narrowed: CrewResultDetails = { status: record.status as CrewStatus };
  if (typeof record.agentId === 'string') narrowed.agentId = record.agentId;
  if (typeof record.agentName === 'string') narrowed.agentName = record.agentName;
  if (typeof record.sessionFile === 'string') narrowed.sessionFile = record.sessionFile;
  if (typeof record.body === 'string') narrowed.body = record.body;
  if (typeof record.error === 'string') narrowed.error = record.error;
  // The nested 1.0.34 result payload is narrowed defensively: an otherwise
  // valid status is never rejected because optional fields are malformed.
  const result = record.result;
  if (typeof result === 'object' && result !== null) {
    const payload = result as Record<string, unknown>;
    if (payload.outcome === 'completed' || payload.outcome === 'needs_input') {
      const out: CrewResultPayload = { outcome: payload.outcome };
      if (typeof payload.report === 'string') out.report = payload.report;
      if (typeof payload.needs === 'string') out.needs = payload.needs;
      narrowed.result = out;
    }
  }
  return narrowed;
}

/**
 * Time of day, plus the date once the message is not from today. A rehydrated
 * chat can be days old, and a bare "13:43" on yesterday's conversation reads as
 * the wrong time rather than as an old one. Locale and zone are the browser's.
 * Shared by crew timeline cards and assistant bubbles so timestamps render
 * identically everywhere.
 */
export const formatTime = (ms: number): string => {
  const when = new Date(ms);
  const clock = when.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const sameDay = when.toDateString() === new Date().toDateString();
  return sameDay ? clock : `${when.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${clock}`;
};

/** Collapsed preview bounds: the first five lines, capped at 800 characters. */
export const CREW_PREVIEW_LINES = 5;
export const CREW_PREVIEW_CHARS = 800;

/**
 * Strip the documented internal top-level `sessionFile` from drifted
 * crew-result details before they render as a generic card. Other JSON-safe
 * fields are preserved for diagnostics. Only crew-result details are
 * sanitised — the generic transport stays generic, so unrelated custom types
 * are never touched.
 */
export function stripCrewSessionFile(details: unknown): unknown {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return details;
  const record = { ...(details as Record<string, unknown>) };
  delete record.sessionFile;
  return record;
}

/** The collapsed preview: first five lines AND the character cap. */
export function crewPreview(text: string): string {
  if (!isPreviewTruncated(text)) return text;
  return text.split('\n').slice(0, CREW_PREVIEW_LINES).join('\n').slice(0, CREW_PREVIEW_CHARS);
}

/** True when the text exceeds either preview bound (lines or characters). */
export function isPreviewTruncated(text: string): boolean {
  return text.length > CREW_PREVIEW_CHARS || text.split('\n').length > CREW_PREVIEW_LINES;
}

/** Safe pretty JSON for structured details (the wire already guarantees JSON-safe). */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** The discriminated card model for a custom timeline event. */
export type CustomCardModel =
  | {
      kind: 'crew-result';
      id: string;
      timestamp: number;
      /** Raw event content, so a body-less result can still render its text. */
      content: string;
      details: CrewResultDetails;
    }
  | { kind: 'crew-list-warning'; id: string; timestamp: number; content: string }
  /** A note the engine put in the timeline itself, shown plainly and without its internal type. */
  | { kind: 'note'; id: string; timestamp: number; content: string }
  | {
      kind: 'generic';
      id: string;
      customType: string;
      timestamp: number;
      content: string;
      details: unknown;
    };

/**
 * Map a custom timeline event to its card model. A malformed documented type
 * (e.g. crew-result with an unknown status) degrades to the safe generic card,
 * carrying the raw content and JSON-safe details — never throwing, never
 * fabricating status/identity/task/duration fields.
 */
export function customCardModel(event: ChatEventItem): CustomCardModel {
  if (event.customType === FUNKYOCTOPUS_NOTE) {
    return { kind: 'note', id: event.id, timestamp: event.timestamp, content: event.content };
  }
  if (event.customType === 'crew-result') {
    const details = crewResultDetails(event.details);
    if (details) {
      return {
        kind: 'crew-result',
        id: event.id,
        timestamp: event.timestamp,
        content: event.content,
        details,
      };
    }
    // Drifted/malformed crew-result → safe generic card, but the documented
    // internal sessionFile path must never leak through the escaped JSON.
    return {
      kind: 'generic',
      id: event.id,
      customType: event.customType,
      timestamp: event.timestamp,
      content: event.content,
      details: stripCrewSessionFile(event.details),
    };
  }
  if (event.customType === 'crew-list-warning') {
    return {
      kind: 'crew-list-warning',
      id: event.id,
      timestamp: event.timestamp,
      content: event.content,
    };
  }
  return {
    kind: 'generic',
    id: event.id,
    customType: event.customType,
    timestamp: event.timestamp,
    content: event.content,
    details: event.details,
  };
}
