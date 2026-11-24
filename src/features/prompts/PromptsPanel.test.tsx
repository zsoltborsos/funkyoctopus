import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { useShell } from '@core/shell/useShell.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PROMPT_LIBRARY, PromptLibraryService } from './prompt-library.service.ts';
import { PromptsPanel } from './PromptsPanel.tsx';

/** Surfaces the shell draft + view so the test can assert the quick-select. */
function DraftProbe() {
  const { chatDraft, view } = useShell();
  return <div data-testid="probe">{`${view}:${chatDraft}`}</div>;
}

function renderPanel() {
  const service = new PromptLibraryService(new MemoryStorageAdapter());
  service.add({ title: 'Reviewer', body: 'Review this diff for bugs.' });

  const container = new Container();
  container.registerInstance(PROMPT_LIBRARY, service);

  render(
    <ContainerProvider container={container}>
      <ShellProvider>
        <PromptsPanel />
        <DraftProbe />
      </ShellProvider>
    </ContainerProvider>,
  );
}

describe('PromptsPanel', () => {
  it('loads a picked template into the chat composer and switches to chat', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByText('Reviewer'));

    expect(screen.getByTestId('probe')).toHaveTextContent('chat:Review this diff for bugs.');
  });
});
