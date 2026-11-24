import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from './preferences.service.ts';
import { CHAT_SHORTCUTS } from '@features/chat/shortcuts.ts';
import { SettingsPanel } from './SettingsPanel.tsx';
import { THEMES } from './themes.ts';

const renderPanel = () => {
  const storage = new MemoryStorageAdapter();
  const service = new PreferencesService(storage);
  const container = new Container();
  container.registerInstance(PREFERENCES, service);

  render(
    <ContainerProvider container={container}>
      <SettingsPanel />
    </ContainerProvider>,
  );
  return { service };
};

describe('SettingsPanel', () => {
  it('fills the view like the other tabs and scrolls inside its own card', () => {
    renderPanel();

    const card = screen.getByRole('heading', { name: 'SETTINGS' }).closest('section');
    // min-h-0 lets the card shrink to the viewport inside the flex column; overflow-y-auto scrolls it.
    expect(card).toHaveClass('h-full', 'w-full', 'min-h-0', 'overflow-y-auto');
    expect(card).not.toHaveClass('max-w-2xl');
  });

  it('reflects the service value and writes back through it', async () => {
    const user = userEvent.setup();
    const { service } = renderPanel();

    const timestamps = screen.getByRole('switch', { name: 'Show timestamps' });
    expect(timestamps).toHaveAttribute('aria-checked', 'true');

    await user.click(timestamps);

    expect(timestamps).toHaveAttribute('aria-checked', 'false');
    expect(service.get().showTimestamps).toBe(false);
  });

  it('switches sidebar position via the segmented control', async () => {
    const user = userEvent.setup();
    const { service } = renderPanel();

    await user.click(screen.getByRole('button', { name: /right/i }));
    expect(service.get().sidebarPosition).toBe('right');
  });

  it('lists every registered theme and switches through the service', async () => {
    const user = userEvent.setup();
    const { service } = renderPanel();

    for (const theme of THEMES) {
      expect(screen.getByRole('button', { name: theme.label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Brand' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Theme — follows the system light\/dark setting/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Matrix' }));
    expect(service.get().theme).toBe('matrix');
    expect(screen.getByRole('button', { name: 'Matrix' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('lists every chat shortcut the composer binds', () => {
    renderPanel();
    const list = screen.getByRole('region', { name: 'CHAT SHORTCUTS' });
    for (const shortcut of CHAT_SHORTCUTS) {
      expect(list).toHaveTextContent(shortcut.keys);
      expect(list).toHaveTextContent(shortcut.does);
    }
    expect(list).toHaveTextContent('Esc');
    expect(list).toHaveTextContent('Alt+N');
    expect(list).toHaveTextContent('Ctrl+K');
  });
});
