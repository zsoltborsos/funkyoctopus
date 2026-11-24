import type { ChatCommand } from '@shared/transport/protocol.ts';

/**
 * What follows the `/` while the draft is a command being named: it starts
 * with `/`, has no space and no newline yet. Null otherwise; once the owner
 * types a space they are writing its arguments, and the palette is done.
 */
export function slashQuery(draft: string): string | null {
  const match = /^\/(\S*)$/u.exec(draft);
  return match ? (match[1] ?? '') : null;
}

/**
 * The commands whose name or an alias holds `query` (any case), names that
 * start with it first, then the rest, each in the engine's order. An empty
 * query lists everything.
 */
export function filterCommands(commands: readonly ChatCommand[], query: string): ChatCommand[] {
  const needle = query.toLowerCase();
  if (!needle) return [...commands];
  const names = (command: ChatCommand): string[] => [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
  const starts = commands.filter((command) => names(command).some((name) => name.startsWith(needle)));
  const contains = commands.filter(
    (command) => !starts.includes(command) && names(command).some((name) => name.includes(needle)),
  );
  return [...starts, ...contains];
}

/**
 * A sent draft that names one of FO's own actions (`/compact keep notes`,
 * `/rename Palette`, or an alias): the action and its arguments, run instead
 * of sending the text. Null for anything else, which goes as a message.
 */
export function actionFor(text: string, commands: readonly ChatCommand[]): { command: ChatCommand; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return null;
  const name = match[1] ?? '';
  const command = commands.find(
    (candidate) => candidate.kind === 'action' && (candidate.name === name || (candidate.aliases ?? []).includes(name)),
  );
  return command ? { command, args: (match[2] ?? '').trim() } : null;
}

/** The palette's list, for the composer's `aria-controls`, and each option's id. */
export const SLASH_LIST_ID = 'slash-commands';
export const slashOptionId = (index: number): string => `${SLASH_LIST_ID}-${index}`;

/** The palette's badge for where a command comes from. */
export const SOURCE_LABEL: Record<ChatCommand['source'], string> = {
  builtin: 'funkyoctopus',
  extension: 'extension',
  template: 'template',
  skill: 'skill',
  'claude-builtin': 'claude code',
  'claude-custom': 'custom',
};
