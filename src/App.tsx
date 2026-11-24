import { useEffect } from 'react';
import { clsx } from 'clsx';
import { ChatView } from '@features/chat/ChatView.tsx';
import { JobsPanel } from '@features/jobs/JobsPanel.tsx';
import { PromptsPanel } from '@features/prompts/PromptsPanel.tsx';
import { SettingsPanel } from '@features/settings/SettingsPanel.tsx';
import { StatusBar } from '@features/status/StatusBar.tsx';
import { usePreferences } from '@features/settings/usePreferences.ts';
import { useShell } from '@core/shell/useShell.ts';
import type { ShellView } from '@core/shell/shell.types.ts';
import { NAV } from '@core/shell/nav.ts';
import { ProjectSelector } from '@core/shell/ProjectSelector.tsx';
import { QuickSwitcher } from '@core/shell/QuickSwitcher.tsx';
import { useHelmraiserNotifications } from '@features/jobs/useHelmraiserNotifications.ts';
import { useService } from '@core/container/useService.ts';
import { CHAT_ATTENTION_NOTIFICATIONS } from '@features/chat/chat-attention-notifications.service.ts';
import { CHAT_SESSIONS } from '@features/chat/chat-sessions.service.ts';
import { useAwayDigestLifecycle } from '@features/chat/useAwayDigest.ts';

/**
 * The cockpit shell: a menu rail on one side, a single focused feature view on
 * the other. Only the selected feature is shown — progressive disclosure over
 * the old everything-at-once panel wall. The rail docks left by default, or
 * right per the sidebar preference.
 */
export function App() {
  const { view, setView } = useShell();
  const { preferences } = usePreferences();
  const chatAttention = useService(CHAT_ATTENTION_NOTIFICATIONS);
  const railRight = preferences.sidebarPosition === 'right';
  // Helmraiser events and away capture stay live in every view.
  useHelmraiserNotifications();
  const chatTabs = useService(CHAT_SESSIONS);
  // A notification's click shows the tab it came from.
  useEffect(
    () =>
      chatAttention.start((chatId) => {
        const switched = chatId !== chatTabs.getSnapshot().activeChatId && chatTabs.activate(chatId);
        setView('chat');
        return switched;
      }),
    [chatAttention, chatTabs, setView],
  );
  useAwayDigestLifecycle();

  // The font-size preference scales the whole rem-based UI from the root.
  useEffect(() => {
    document.documentElement.style.fontSize = `${preferences.fontSize}px`;
  }, [preferences.fontSize]);

  // index.html sets the stored theme before first paint; this follows changes.
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  return (
    <div className="flex h-screen flex-col">
      <div className={clsx('flex flex-1 overflow-hidden', railRight && 'flex-row-reverse')}>
        <NavRail />
        <main className="flex-1 overflow-hidden p-6">
          <div className="flex h-full w-full flex-col overflow-hidden">
            <ActiveView view={view} />
          </div>
        </main>
      </div>

      <StatusBar />
      <QuickSwitcher />
    </div>
  );
}

function NavRail() {
  const { view, setView } = useShell();
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-surface/30 p-3">
      {/* The wordmark lives in the rail (T1.4): the old 60 px header held
          nothing else and cost the transcript a line. */}
      <h1 className="mb-3 px-1 font-mono text-base font-bold tracking-widest text-accent">
        funky<span className="text-special">octopus</span>
      </h1>
      <ProjectSelector />
      {NAV.map((item) => {
        const active = view === item.view;
        return (
          <button
            key={item.view}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => setView(item.view)}
            className={clsx(
              'flex items-center gap-3 rounded border px-3 py-2 text-left font-mono text-sm transition-colors',
              active
                ? 'border-accent/50 bg-accent-soft text-accent shadow-glow-accent'
                : 'border-transparent text-muted hover:border-border hover:text-text',
            )}
          >
            <span className="w-5 text-center text-base">{item.glyph}</span>
            <span className="tracking-wide">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function ActiveView({ view }: { view: ShellView }) {
  switch (view) {
    case 'chat':
      return <ChatView />;
    case 'jobs':
      return <JobsPanel />;
    case 'prompts':
      return <PromptsPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}
