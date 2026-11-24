import type { EngineKind } from '@shared/transport/protocol.ts';
import type { ChatTab } from './chat-sessions.service.ts';

export const ENGINES: Record<EngineKind, { glyph: string; label: string; tone: string }> = {
  pi: { glyph: 'π', label: 'pi', tone: 'text-accent' },
  'claude-code': { glyph: '✻', label: 'Claude', tone: 'text-special' },
};

/** The glyphs sit a size up and bold, so a ✻ reads as plainly as a π. */
export const GLYPH = 'shrink-0 text-[1.15em] font-bold leading-none';

/** What a tab's accessible name and tooltip say about it, beyond its title. */
export function describeTab(tab: ChatTab): string[] {
  return [
    ENGINES[tab.kind].label,
    ...(tab.busy ? ['turn running'] : []),
    ...(tab.attention ? ['needs you'] : []),
    ...(tab.unread ? ['unread'] : []),
    ...(tab.crew ? ['crew'] : tab.crewPending ? ['crew from next session'] : []),
    ...(tab.subagentsLeftRunning > 0
      ? [
          `${tab.subagentsLeftRunning} subagent${tab.subagentsLeftRunning === 1 ? '' : 's'} still running`,
        ]
      : []),
  ];
}
