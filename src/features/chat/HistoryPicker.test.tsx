import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatSessionInfo } from '@shared/transport/protocol.ts';
import { HistoryPicker } from './HistoryPicker.tsx';

const base = (over: Partial<ChatSessionInfo>): ChatSessionInfo => ({
  path: '/sessions/a.jsonl', engine: 'pi',
  id: 'a',
  cwd: '/home/example/projects/helmraiser',
  title: 'an older chat',
  created: '2026-09-01T00:00:00.000Z',
  modified: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('HistoryPicker moved rows', () => {
  it('shows the mapped folder plus a dim moved-from hint with ~ for home', async () => {
    const user = userEvent.setup();
    render(
      <HistoryPicker
        sessions={[
          base({
            cwd: '/home/example/projects/helmraiser',
            movedFrom: '/home/example/Desktop/dev/helmraiser',
          }),
        ]}
        activePath={null}
        onOpen={() => undefined}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat history' }));

    const row = await screen.findByText('an older chat');
    expect(row.parentElement?.textContent).toContain('projects/helmraiser');
    expect(row.parentElement?.textContent).toContain('moved from ~/Desktop/dev/helmraiser');
    // The row is not dimmed — an unusual presentation that means unmappable.
    expect(row.closest('button')).not.toHaveClass('opacity-60');
  });

  it('dims a folder-gone row, labels it, and keeps it clickable', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <HistoryPicker
        sessions={[base({ cwd: '/dead/folder', folderGone: true, id: 'gone' })]}
        activePath={null}
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Chat history' }));

    const gone = await screen.findByText('an older chat');
    const button = gone.closest('button');
    expect(button).not.toBeNull();
    expect(button).toHaveClass('opacity-60');
    expect(button?.textContent).toContain('folder gone');

    // Still an enabled button that opens the session file where it lies.
    await user.click(gone);
    expect(onOpen).toHaveBeenCalledWith('/sessions/a.jsonl');
  });
});
