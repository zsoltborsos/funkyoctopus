/**
 * Compact, escaped, accessible crew audit card rendered at the original tool
 * step position inside the assistant turn. Only shows what parsing actually
 * produced — never session files or raw private paths, never a browser action.
 */

import type { CrewAuditModel } from './crew-audit.ts';

const ACTION_LABEL: Record<CrewAuditModel['kind'], string> = {
  spawn: 'CREW SPAWN',
  list: 'CREW LIST',
  status: 'CREW STATUS',
  abort: 'CREW ABORT',
  respond: 'CREW RESPOND',
  done: 'CREW DONE',
};

function auditTarget(audit: CrewAuditModel): string | undefined {
  if (audit.kind === 'spawn') return audit.agent;
  return 'target' in audit ? audit.target : undefined;
}

function auditLabel(audit: CrewAuditModel): string {
  const target = auditTarget(audit);
  return target ? `Crew ${audit.kind}: ${target}` : `Crew ${audit.kind}`;
}

export function CrewAuditCard({ audit }: { audit: CrewAuditModel }) {
  const target = auditTarget(audit);
  return (
    <article
      aria-label={auditLabel(audit)}
      className="flex w-full min-w-0 gap-3 border-l-2 border-special/60 pl-3 wrap-anywhere"
    >
      <span aria-hidden="true" className="pt-0.5 font-mono text-sm text-special">
        ⚙
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-xs tracking-widest text-muted">
          <span className="text-special">{ACTION_LABEL[audit.kind]}</span>
          {target ? ` · ${target}` : ''}
          {audit.kind === 'spawn' && audit.agentId ? ` · ${audit.agentId}` : ''}
          {audit.kind === 'spawn' && audit.status ? ' · unknown/interrupted' : ''}
        </span>
        {audit.kind === 'spawn' && audit.task && (
          <div className="max-w-[90ch] wrap-anywhere whitespace-pre-wrap font-mono text-xs text-text">
            {audit.task}
          </div>
        )}
        {audit.kind === 'respond' && audit.message && (
          <div className="max-w-[90ch] wrap-anywhere whitespace-pre-wrap font-mono text-xs text-text">
            {audit.message}
          </div>
        )}
        {audit.error && (
          <div className="max-w-[90ch] wrap-anywhere whitespace-pre-wrap font-mono text-xs text-danger">
            {audit.error}
          </div>
        )}
      </div>
    </article>
  );
}
