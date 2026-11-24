import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { HelmraiserLogEvent } from '@shared/transport/protocol.ts';
import { humaneError } from '@core/transport/humane-error.ts';
import { useService } from '@core/container/useService.ts';
import { ActionButton } from './ActionButton.tsx';
import { WORKFLOW } from './workflow.client.ts';
import { clockTime, summarize, verifyChecks } from './run-log.ts';

/**
 * A collapsed LOG toggle; opened, a run's recent ledger events as a compact
 * timeline. `actions` share the toggle's row (a wrapping flex row), so a row
 * has one line of buttons.
 */
export function RunLog({ runId, follow, actions }: {
  runId: string;
  /** A running run: keep reading new events while the log is open. */
  follow: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <ActionButton name="LOG" color="muted" disabled={false} expanded={open} onClick={() => setOpen((value) => !value)} />
      </div>
      {open && <RunLogBody runId={runId} follow={follow} />}
    </div>
  );
}

/** Pause between reads of a running run's log, counted from the end of the last. */
const POLL_MS = 3_000;
/** Events kept in the timeline: the last ones, which hold the failure. */
const KEEP_EVENTS = 200;

interface LogState {
  events: HelmraiserLogEvent[];
  truncated: boolean;
  error: string | null;
  loaded: boolean;
}

function RunLogBody({ runId, follow }: { runId: string; follow: boolean }) {
  const workflow = useService(WORKFLOW);
  const [log, setLog] = useState<LogState>({ events: [], truncated: false, error: null, loaded: false });
  // The newest events are the ones that matter, so the list sits at the bottom until the reader scrolls up.
  const list = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  useLayoutEffect(() => {
    const element = list.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [log.events]);
  useEffect(() => {
    let live = true;
    let timer: number | undefined;
    // The id of the last event seen: what the next read asks "after".
    let cursor: number | undefined;
    let loaded = false;
    let ended = false;

    const read = async () => {
      const sinceId = cursor;
      try {
        const result = sinceId === undefined ? await workflow.log(runId) : await workflow.log(runId, sinceId);
        if (!live) return;
        loaded = true;
        const last = result.events.at(-1);
        if (last) {
          cursor = last.id;
          ended = last.type === 'run_end';
        }
        setLog((prev) => {
          const merged = sinceId === undefined ? result.events : [...prev.events, ...result.events];
          const events = merged.slice(-KEEP_EVENTS);
          const truncated = (sinceId === undefined ? false : prev.truncated) || result.truncated || events.length < merged.length;
          return { events, truncated, error: null, loaded: true };
        });
      } catch (failure) {
        if (!live) return;
        // The sidecar words a failure as the command ("helmraiser log failed: …"); the log says what did not happen.
        const reason = humaneError(failure, 'the log could not be read').message.replace(/^helmraiser \S+ failed: /, '');
        setLog((prev) => ({ ...prev, error: `Log not loaded — ${reason}` }));
      }
      // One read at a time, a few seconds apart, while the run is going. A first read that failed is the owner's to retry.
      if (live && follow && loaded && !ended) timer = window.setTimeout(() => void read(), POLL_MS);
    };

    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [workflow, runId, follow]);

  return (
    <div className="mt-2 font-mono text-xs">
      {log.error && <p role="alert" className="mb-1 text-danger">⚠ {log.error}</p>}
      {!log.loaded && !log.error && <p role="status" className="text-muted">reading the log…</p>}
      {log.loaded && log.events.length === 0 && <p className="text-muted">no events yet</p>}
      {log.truncated && <p className="mb-1 text-muted">{log.events.length} most recent events · earlier ones not shown</p>}
      {log.events.length > 0 && (
        <ol
          ref={list}
          aria-label="Run log"
          onScroll={(event) => {
            const element = event.currentTarget;
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}
          className="max-h-80 overflow-y-auto rounded border border-border bg-bg p-2 select-text"
        >
          {log.events.map((event) => (
            <li key={event.id}>
              <div className="grid grid-cols-[4.5rem_5rem_11rem_minmax(0,1fr)] gap-x-2">
                <span className="text-muted">{clockTime(event.ts)}</span>
                <span className="text-info">{event.stage ?? ''}</span>
                <span className="text-text">{event.type}</span>
                <span className={`truncate ${tone(event)}`} title={summarize(event)}>{summarize(event)}</span>
              </div>
              <EventDetail event={event} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Failures read danger and a clean ending ok; everything else stays quiet. */
function tone(event: HelmraiserLogEvent): string {
  const { type, payload } = event;
  if (type === 'run_end') {
    if (payload.status === 'landed') return 'text-ok';
    // A run parked for approval also writes run_end; only a failure or an abort is a fault.
    return payload.status === 'failed' || payload.status === 'aborted' ? 'text-danger' : 'text-muted';
  }
  if (type === 'verify_result') return payload.passed === false ? 'text-danger' : 'text-ok';
  if (type === 'service_failed' || (type === 'tool_execution_end' && payload.isError === true)) return 'text-danger';
  return 'text-muted';
}

/**
 * What a row needs more room for than one line: each verify check. Why the run
 * ended is not repeated here; its row already says it above the log.
 */
function EventDetail({ event }: { event: HelmraiserLogEvent }) {
  if (event.type === 'verify_result') {
    return (
      <div role="group" aria-label="Verify checks" className="my-1 ml-4 space-y-1">
        {verifyChecks(event.payload).map((check, index) => (
          <Fragment key={index}>
            <p className={check.passed ? 'text-ok' : 'text-danger'}>{check.line}</p>
            {check.tail && (
              <pre className="whitespace-pre-wrap rounded border border-border p-2 text-text">{check.tail}</pre>
            )}
          </Fragment>
        ))}
      </div>
    );
  }
  return null;
}
