import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatEventItem } from './chat.types.ts';
import { CREW_STATUSES, CREW_STATUS_META, CREW_WAITING_HINT } from './crew-card.ts';
import { CrewCard } from './CrewCard.tsx';

const event = (overrides: Partial<ChatEventItem> = {}): ChatEventItem => ({
  kind: 'custom-message',
  id: 'e1',
  customType: 'crew-result',
  display: true,
  content: 'content',
  details: { status: 'done', agentName: 'scout' },
  timestamp: 1000,
  ...overrides,
});

const sixLines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];

describe('CrewCard crew-result', () => {
  it('renders every documented status with its label, icon and aria-label', () => {
    for (const status of CREW_STATUSES) {
      const { unmount } = render(
        <CrewCard event={event({ details: { status, agentName: 'scout' } })} showTimestamp={false} />,
      );
      const card = screen.getByLabelText(`Crew result: ${status}`);
      expect(card).toBeInTheDocument();
      expect(screen.getByText(CREW_STATUS_META[status].label)).toBeInTheDocument();
      expect(screen.getByText(CREW_STATUS_META[status].icon)).toBeInTheDocument();
      unmount();
    }
  });

  it('shows agent identity when present and omits it when absent', () => {
    const { unmount } = render(
      <CrewCard
        event={event({ details: { status: 'done', agentName: 'scout', agentId: 'scout-1' } })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Crew result: done');
    expect(card.textContent).toContain('scout');
    expect(card.textContent).toContain('scout-1');
    unmount();

    render(<CrewCard event={event({ details: { status: 'done' } })} showTimestamp={false} />);
    const anonymous = screen.getByLabelText('Crew result: done');
    expect(anonymous.textContent).not.toContain('scout');
  });

  it('never exposes the raw session file path', () => {
    render(
      <CrewCard
        event={event({ details: { status: 'done', sessionFile: '/s/secret.jsonl' } })}
        showTimestamp={false}
      />,
    );
    expect(screen.queryByText('/s/secret.jsonl')).not.toBeInTheDocument();
  });

  it('renders the raw content for body-less results (running and done)', () => {
    for (const status of ['running', 'done'] as const) {
      const { unmount } = render(
        <CrewCard
          event={event({ content: 'the result content', details: { status } })}
          showTimestamp={false}
        />,
      );
      expect(screen.getByLabelText(`Crew result: ${status}`).textContent).toContain(
        'the result content',
      );
      unmount();
    }
  });

  it('prefers details.body without duplicating the raw content', () => {
    render(
      <CrewCard
        event={event({ content: 'the raw content', details: { status: 'done', body: 'the body' } })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Crew result: done');
    expect(card.textContent).toContain('the body');
    expect(card.textContent).not.toContain('the raw content');
  });

  it('renders the pi-crew 1.0.34 completed report instead of the raw JSON content', () => {
    render(
      <CrewCard
        event={event({
          content: '{"subagent_id":"scout-1","result":{"outcome":"completed","report":"probe-a: x"}}',
          details: {
            status: 'completed',
            agentId: 'scout-1',
            result: { outcome: 'completed', report: 'probe-a: x' },
          },
        })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Crew result: completed');
    expect(card.textContent).toContain('probe-a: x');
    expect(card.textContent).not.toContain('subagent_id');
  });

  it('renders the pi-crew 1.0.34 needs_input report, Needs line and hint', () => {
    render(
      <CrewCard
        event={event({
          details: {
            status: 'needs_input',
            agentId: 'scout-1',
            result: { outcome: 'needs_input', report: 'progress so far', needs: 'Which port?' },
          },
        })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Crew result: needs_input');
    expect(card.textContent).toContain('progress so far');
    expect(card.textContent).toContain('Needs: Which port?');
    expect(screen.getByText(CREW_WAITING_HINT)).toBeInTheDocument();
  });

  it('renders the pi-crew 1.0.34 error text for an error result', () => {
    render(
      <CrewCard
        event={event({ details: { status: 'error', agentId: 'scout-1', error: 'boom' } })}
        showTimestamp={false}
      />,
    );
    expect(screen.getByLabelText('Crew result: error').textContent).toContain('boom');
  });

  it('previews and expands a long needs_input report like any body', async () => {
    const user = userEvent.setup();
    const long = 'word '.repeat(400).trim();
    render(
      <CrewCard
        event={event({
          details: {
            status: 'needs_input',
            result: { outcome: 'needs_input', report: long, needs: 'Which port?' },
          },
        })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Crew result: needs_input');
    expect(card.textContent).toContain('Needs: Which port?');
    await user.click(screen.getByRole('button', { name: 'EXPAND' }));
    expect(card.textContent).toContain(long);
  });

  it('collapses a long single-line result and expands to the exact full text', async () => {
    const user = userEvent.setup();
    const long = 'word '.repeat(400).trim();
    render(
      <CrewCard
        event={event({ content: 'x', details: { status: 'done', body: long } })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Crew result: done');
    // Collapsed: bounded preview only.
    expect(card.textContent).toContain(long.slice(0, 100));
    expect(card.textContent).not.toContain(long.slice(900));
    const expand = screen.getByRole('button', { name: 'EXPAND' });
    await user.click(expand);
    expect(card.textContent).toContain(long);
    await user.click(screen.getByRole('button', { name: 'COLLAPSE' }));
    expect(card.textContent).not.toContain(long.slice(900));
  });

  it('previews five lines and expands/collapses to the full escaped content', async () => {
    const user = userEvent.setup();
    render(
      <CrewCard event={event({ details: { status: 'done', body: sixLines.join('\n') } })} showTimestamp={false} />,
    );

    const card = screen.getByLabelText('Crew result: done');
    // Preview: the first five lines only.
    expect(card.textContent).toContain('l1');
    expect(card.textContent).not.toContain('l6');

    const expand = screen.getByRole('button', { name: 'EXPAND' });
    await user.click(expand);
    expect(card.textContent).toContain('l6');
    expect(screen.getByRole('button', { name: 'COLLAPSE' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'COLLAPSE' }));
    expect(card.textContent).not.toContain('l6');
  });

  it('offers no expand button for short bodies', () => {
    render(
      <CrewCard event={event({ details: { status: 'done', body: 'short' } })} showTimestamp={false} />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('toggles expansion with the keyboard (Enter)', async () => {
    const user = userEvent.setup();
    render(
      <CrewCard event={event({ details: { status: 'done', body: sixLines.join('\n') } })} showTimestamp={false} />,
    );
    const expand = screen.getByRole('button', { name: 'EXPAND' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expand.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Crew result: done').textContent).toContain('l6');
    expect(screen.getByRole('button', { name: 'COLLAPSE' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the waiting question and the reply-through-the-parent-chat hint', () => {
    render(
      <CrewCard
        event={event({ details: { status: 'waiting', body: 'Which branch should I use?' } })}
        showTimestamp={false}
      />,
    );
    expect(screen.getByText('Which branch should I use?')).toBeInTheDocument();
    expect(screen.getByText(CREW_WAITING_HINT)).toBeInTheDocument();
  });

  it('shows the timestamp when enabled', () => {
    render(
      <CrewCard event={event({ details: { status: 'done' } })} showTimestamp={true} />,
    );
    // Timestamp for epoch 1000 renders as a localised clock; just prove the
    // meta line carries a time rather than being empty.
    expect(screen.getByLabelText('Crew result: done').textContent).not.toBe('');
  });
});

describe('CrewCard correlated result', () => {
  it('shows the spawn task and formatted duration when correlated', () => {
    render(
      <CrewCard
        event={event({ details: { status: 'done', body: 'the body' } })}
        showTimestamp={false}
        enrichment={{ task: 'read probe', durationMs: 83_000 }}
      />,
    );
    const card = screen.getByLabelText('Crew result: done');
    expect(card.textContent).toContain('read probe');
    expect(card.textContent).toContain('1m 23s');
  });

  it('never overrides agent identity from the spawn (result keeps its own)', () => {
    render(
      <CrewCard
        event={event({ details: { status: 'done', agentName: 'scout', agentId: 'scout-1' } })}
        showTimestamp={false}
        enrichment={{ task: 'read probe', durationMs: 5000 }}
      />,
    );
    const card = screen.getByLabelText('Crew result: done');
    expect(card.textContent).toContain('scout');
    expect(card.textContent).toContain('scout-1');
  });
});

describe('CrewCard crew-list-warning', () => {
  it('renders the warning content as its own card', () => {
    render(
      <CrewCard
        event={event({ customType: 'crew-list-warning', content: '⚠ Active subagents detected.' })}
        showTimestamp={false}
      />,
    );
    expect(screen.getByLabelText('Crew warning')).toBeInTheDocument();
    expect(screen.getByText('⚠ Active subagents detected.')).toBeInTheDocument();
  });
});

describe('CrewCard FunkyOctopus note', () => {
  const note = event({
    customType: 'funkyoctopus-note',
    content: "opened as a fork: this session is live in Claude Code 'alpha-a' (/w); your terminal session is untouched",
    details: null,
  });

  it('shows the engine\'s own note as a plain note, not as a custom message with an internal type', () => {
    render(<CrewCard event={note} showTimestamp={false} />);

    const card = screen.getByLabelText('FunkyOctopus note');
    expect(card.textContent).toContain('NOTE');
    expect(card.textContent).toContain("opened as a fork: this session is live in Claude Code 'alpha-a' (/w); your terminal session is untouched");
    expect(card.textContent).not.toContain('CUSTOM');
    expect(card.textContent).not.toContain('funkyoctopus-note');
    expect(card.querySelector('pre')).toBeNull();
  });

  it('keeps a note out of the crew-coloured glyphs: neutral border and dim glyph', () => {
    render(<CrewCard event={note} showTimestamp={false} />);

    const card = screen.getByLabelText('FunkyOctopus note');
    expect(card.className).toContain('border-border');
    expect(card.className).not.toMatch(/border-(special|attention|danger|ok|accent)/);
    expect(card.querySelector('[aria-hidden="true"]')?.className).toContain('text-muted');
  });

  it('shows the time when timestamps are on, like every other card', () => {
    render(<CrewCard event={note} showTimestamp />);

    expect(screen.getByLabelText('FunkyOctopus note').textContent).toMatch(/\d/);
  });
});

describe('CrewCard generic and hidden events', () => {
  it('renders unknown display:true custom types as a safe generic card with escaped JSON', () => {
    render(
      <CrewCard
        event={event({ customType: 'custom-thing', content: 'hello', details: { a: 1 } })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Custom message: custom-thing');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('hello');
    expect(card.querySelector('pre')?.textContent).toBe('{\n  "a": 1\n}');
  });

  it('never exposes sessionFile from a drifted crew-result, but keeps other details', () => {
    render(
      <CrewCard
        event={event({ details: { status: 'wat', sessionFile: '/s/secret.jsonl', body: 'drifted' } })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Custom message: crew-result');
    const json = card.querySelector('pre')?.textContent ?? '';
    expect(json).toContain('"status"');
    expect(json).toContain('"body"');
    expect(card.textContent).not.toContain('/s/secret.jsonl');
  });

  it('keeps a sessionFile-shaped field on unrelated custom types', () => {
    render(
      <CrewCard
        event={event({
          customType: 'custom-thing',
          content: 'x',
          details: { sessionFile: '/s/other.jsonl', note: 'kept' },
        })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Custom message: custom-thing');
    expect(card.querySelector('pre')?.textContent).toContain('/s/other.jsonl');
  });

  it('degrades a malformed crew-result to the generic card instead of throwing', () => {
    render(
      <CrewCard event={event({ details: { status: 'wat' } })} showTimestamp={false} />,
    );
    const card = screen.getByLabelText('Custom message: crew-result');
    expect(card).toBeInTheDocument();
    expect(card.querySelector('pre')?.textContent).toBe('{\n  "status": "wat"\n}');
  });

  it('renders nothing for display:false events', () => {
    const { container } = render(
      <CrewCard event={event({ display: false })} showTimestamp={false} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('keeps hostile-looking HTML literal — no script or element is created', () => {
    const hostile = '<script>alert("xss")</script><b>bold</b>';
    render(
      <CrewCard
        event={event({ customType: 'custom-thing', content: hostile, details: null })}
        showTimestamp={false}
      />,
    );
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('collapses long generic content with the one affordance and expands exactly', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(5000);
    render(
      <CrewCard
        event={event({ customType: 'custom-thing', content: long, details: null })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Custom message: custom-thing');
    // Long single-line generic content collapses too; the layout stays
    // contained (min-w-0 + wrap-anywhere).
    expect(card.className).toContain('min-w-0');
    expect(card.className).toContain('wrap-anywhere');
    expect(card.textContent).not.toContain(long.slice(900));
    await user.click(screen.getByRole('button', { name: 'EXPAND' }));
    expect(card.textContent).toContain(long);
  });

  it('bounds generic JSON details and expands them with the one affordance', async () => {
    const user = userEvent.setup();
    const details = { data: 'x'.repeat(1200) };
    render(
      <CrewCard
        event={event({ customType: 'custom-thing', content: 'short', details })}
        showTimestamp={false}
      />,
    );
    const card = screen.getByLabelText('Custom message: custom-thing');
    const pre = (): HTMLPreElement | null => card.querySelector('pre');
    // Collapsed: the JSON preview uses the same safe bound (800 chars).
    expect(pre()?.textContent).toHaveLength(800);
    await user.click(screen.getByRole('button', { name: 'EXPAND' }));
    expect(pre()?.textContent).toBe(JSON.stringify(details, null, 2));
  });
});
