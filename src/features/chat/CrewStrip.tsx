/**
 * Control-free live crew strip, rendered directly above the composer (inside
 * ChatPanel — never global). One compact row per active agent with client-side
 * elapsed time; an unread summary stays visible even with no active agents.
 * Hidden only when activeCrew is empty AND unread is zero.
 */

import { useNow } from '@core/clock/useNow.ts';
import { formatDuration } from './crew-audit.ts';
import type { LiveCrewAgent } from './crew-live.ts';

const ELAPSED_TICK_MS = 1000;

/** Human strip text: needs_input reads as words, not as a snake_case code. */
function statusText(status: LiveCrewAgent['status']): string {
  return status === 'needs_input' ? 'NEEDS INPUT' : status.toUpperCase();
}

function Row({ agent, now }: { agent: LiveCrewAgent; now: number }) {
  const waiting = agent.status === 'waiting' || agent.status === 'needs_input';
  const completed = agent.status === 'completed';
  const color = completed ? 'text-ok' : waiting ? 'text-attention' : 'text-accent';
  const glyph = completed ? '✅' : waiting ? '⏳' : '●';
  return (
    <div className="flex w-full min-w-0 items-center gap-2 font-mono text-xs">
      <span aria-hidden="true" className={color}>
        {glyph}
      </span>
      <span className={color}>
        {statusText(agent.status)}
      </span>
      <span className="min-w-0 truncate text-text">{agent.agentName}</span>
      {agent.task && <span className="min-w-0 truncate text-muted">{agent.task}</span>}
      {agent.agentId && <span className="min-w-0 truncate text-muted">{agent.agentId}</span>}
      {agent.lastActivity && (
        <span className="min-w-0 truncate text-muted">{agent.lastActivity}</span>
      )}
      <span
        aria-hidden="true"
        className="ml-auto shrink-0 text-muted"
      >
        {formatDuration(Math.max(0, now - agent.startedAt))}
      </span>
    </div>
  );
}

export function CrewStrip({ agents, unread }: { agents: LiveCrewAgent[]; unread: number }) {
  // The elapsed ticker runs only while rows exist: hidden and unread-only
  // states never create an interval or per-second rerenders.
  const now = useNow(ELAPSED_TICK_MS, agents.length > 0);

  if (agents.length === 0 && unread === 0) return null;

  return (
    <div
      role="region"
      aria-label="Active crew"
      aria-live="polite"
      className="flex w-full min-w-0 flex-col gap-1 wrap-anywhere"
    >
      {agents.map((agent) => (
        <Row key={agent.key} agent={agent} now={now} />
      ))}
      {unread > 0 && (
        <p
          aria-label="Unread crew updates"
          className="font-mono text-xs uppercase tracking-widest text-attention"
        >
          {unread} unread crew update{unread === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
}
