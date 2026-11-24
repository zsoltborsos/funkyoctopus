import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CrewAuditCard } from './CrewAuditCard.tsx';
import { crewAuditModel } from './crew-audit.ts';

type ToolCallStep = Extract<import('./chat.types.ts').ChatStep, { kind: 'tool-call' }>;
type ToolResultStep = Extract<import('./chat.types.ts').ChatStep, { kind: 'tool-result' }>;

const toolCall = (callId: string, tool: string, args?: unknown): ToolCallStep => ({
  kind: 'tool-call',
  callId,
  tool,
  summary: `${tool}: x`,
  ...(args !== undefined ? { args } : {}),
});

const toolResult = (
  callId: string,
  output?: string,
  details?: unknown,
  ok = true,
  error?: string,
): ToolResultStep => ({
  kind: 'tool-result',
  callId,
  ok,
  ...(output !== undefined ? { output } : {}),
  ...(details !== undefined ? { details } : {}),
  ...(error !== undefined ? { error } : {}),
});

describe('CrewAuditCard', () => {
  it('renders a spawn audit with action, agent, id, task and interrupted status', () => {
    render(
      <CrewAuditCard
        audit={{
          kind: 'spawn',
          callId: 'c1',
          agent: 'scout',
          agentId: 'scout-1',
          task: 'read probe',
          status: 'interrupted',
        }}
      />,
    );
    expect(screen.getByLabelText('Crew spawn: scout')).toBeInTheDocument();
    expect(screen.getByText('CREW SPAWN')).toBeInTheDocument();
    const card = screen.getByLabelText('Crew spawn: scout');
    expect(card.textContent).toContain('scout-1');
    expect(card.textContent).toContain('read probe');
    // The literal uncertainty label, never an active/running claim.
    expect(card.textContent).toContain('unknown/interrupted');
  });

  it('renders abort, respond and done targets', () => {
    render(<CrewAuditCard audit={{ kind: 'abort', callId: 'c3', target: 'scout-1' }} />);
    expect(screen.getByLabelText('Crew abort: scout-1')).toBeInTheDocument();
    render(<CrewAuditCard audit={{ kind: 'respond', callId: 'c4', target: 'scout-1', message: 'go on' }} />);
    expect(screen.getByLabelText('Crew respond: scout-1')).toBeInTheDocument();
    expect(screen.getByText('CREW RESPOND')).toBeInTheDocument();
    render(<CrewAuditCard audit={{ kind: 'done', callId: 'c5', target: 'scout-1' }} />);
    expect(screen.getByLabelText('Crew done: scout-1')).toBeInTheDocument();
  });

  it('shows a failed tool error and never a session file path', () => {
    render(<CrewAuditCard audit={{ kind: 'spawn', callId: 'c1', agent: 'scout', error: 'boom exploded' }} />);
    expect(screen.getByLabelText('Crew spawn: scout').textContent).toContain('boom exploded');
    expect(screen.getByLabelText('Crew spawn: scout').textContent).not.toContain('/s/');
  });

  it('keeps hostile-looking task text literal', () => {
    const hostile = '<script>alert("xss")</script>';
    render(<CrewAuditCard audit={{ kind: 'spawn', callId: 'c1', agent: 'scout', task: hostile }} />);
    expect(screen.getByLabelText('Crew spawn: scout').textContent).toContain(hostile);
    expect(document.querySelector('script')).toBeNull();
  });

  it('contains long unbroken payloads without widening the layout', () => {
    const long = 'x'.repeat(5000);
    render(<CrewAuditCard audit={{ kind: 'spawn', callId: 'c1', agent: 'scout', task: long }} />);
    const card = screen.getByLabelText('Crew spawn: scout');
    expect(card.textContent).toContain(long);
    expect(card.className).toContain('min-w-0');
    expect(card.className).toContain('wrap-anywhere');
  });

  it('renders models parsed from raw pi-crew 1.0.34 tool-result fixtures', () => {
    const respond = crewAuditModel(
      toolCall('c4', 'crew_respond', { subagent_id: 'scout-1', message: 'go' }),
      toolResult('c4', '{"subagent_id":"scout-1"}'),
    );
    render(<CrewAuditCard audit={respond!} />);
    expect(screen.getByLabelText('Crew respond: scout-1')).toBeInTheDocument();
    expect(screen.getByText('go')).toBeInTheDocument();

    const done = crewAuditModel(
      toolCall('c5', 'crew_done', { subagent_id: 'scout-1' }),
      toolResult('c5', '{"subagent_id":"scout-1"}'),
    );
    render(<CrewAuditCard audit={done!} />);
    expect(screen.getByLabelText('Crew done: scout-1')).toBeInTheDocument();

    const abort = crewAuditModel(
      toolCall('c3', 'crew_abort', { subagent_ids: ['scout-1'] }),
      toolResult('c3', '{"aborted_ids":["scout-1"],"missing_ids":[],"foreign_ids":[]}'),
    );
    render(<CrewAuditCard audit={abort!} />);
    expect(screen.getByLabelText('Crew abort: scout-1')).toBeInTheDocument();

    const multi = crewAuditModel(
      toolCall('c3b', 'crew_abort', { subagent_ids: ['a', 'b'] }),
      toolResult('c3b', '{"aborted_ids":["a-1","b-2"]}'),
    );
    render(<CrewAuditCard audit={multi!} />);
    expect(screen.getByLabelText('Crew abort: 2 ids')).toBeInTheDocument();

    const failure = crewAuditModel(
      toolCall('c5b', 'crew_done', { subagent_id: 'scout-1' }),
      toolResult('c5b', '{"error":"agent not found"}', undefined, false),
    );
    render(<CrewAuditCard audit={failure!} />);
    expect(screen.getByText('agent not found')).toBeInTheDocument();
  });
});
