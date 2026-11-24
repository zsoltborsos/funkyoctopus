import type { HelmraiserHold, HelmraiserNeverStartable } from '@shared/transport/protocol.ts';

/** What the holding run is doing, as the thing the queued task waits for. */
function waitingFor(hold: HelmraiserHold & { run_id: string }): string {
  const who = hold.other_task_id ?? `run ${hold.run_id.slice(0, 8)}`;
  if (hold.pending === 'merge') return `the merge of ${who}`;
  if (hold.pending === 'plan') return `the plan approval of ${who}`;
  if (hold.pending === 'scope') return `the scope approval of ${who}`;
  if (hold.pending) return `the ${hold.pending} approval of ${who}`;
  if (hold.status === 'resuming') return `${who} to resume and finish`;
  return `${who} to finish`;
}

/** The part after the dash: helmraiser's reason code in plain words, or the raw code if unknown. */
function qualifier(hold: HelmraiserHold): string | null {
  switch (hold.reason) {
    case undefined: return null;
    case 'paths_overlap': return 'same files';
    case 'project_busy': return hold.detail ? `the project is busy: ${hold.detail}` : 'the project is busy';
    // The unmet list says it, below.
    case 'depends_on': return null;
    default: return hold.reason;
  }
}

/** Helmraiser's own words for each unmet dependency, `<id>: <why>`. */
const unmetText = (hold: HelmraiserHold): string | null =>
  hold.reason === 'depends_on' && hold.unmet?.length
    ? `depends on ${hold.unmet.map((item) => item.text).join('; ')}`
    : null;

/**
 * One line saying why a queued task is held, e.g. "waits for the merge of
 * access-policy — same files". Helmraiser owns the hold logic; this only words
 * its codes. An unknown `reason` shows as the raw code.
 */
export function holdText(hold: HelmraiserHold): string {
  const run = hold.run_id === undefined ? null : waitingFor({ ...hold, run_id: hold.run_id });
  const why = qualifier(hold);
  const waits = run === null ? null : `waits for ${run}${why ? ` — ${why}` : ''}`;
  const depends = unmetText(hold);
  if (waits && depends) return `${waits}; ${depends}`;
  return waits ?? depends ?? (why ? `held — ${why}` : 'held');
}

/**
 * One line saying a queued task can never start, and why. Helmraiser's `text`
 * leads with "will never start:"; that lead-in becomes our "cannot start". With
 * no text (older output) the raw reason code stands in.
 */
export function neverStartableText(row: HelmraiserNeverStartable): string {
  const why = row.text?.replace(/^will never start:\s*/, '') ?? row.reason;
  return `cannot start — ${why}`;
}
