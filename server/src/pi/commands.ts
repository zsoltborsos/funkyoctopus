import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ChatCommand } from '../../../src/shared/transport/protocol.ts';

/**
 * FunkyOctopus's own commands for a pi slot. pi's `/compact`, `/name` and the
 * rest are its TUI's (they would reach the model as plain text through
 * `prompt()`), so these two are typed seam calls instead: `chat.compact` runs
 * `session.compact`, `chat.rename` runs `setSessionName`. pi's other TUI
 * built-ins are not offered: FO has its own controls for new, open, model and
 * thinking, and the rest have no meaning here.
 */
export const PI_BUILTINS: ChatCommand[] = [
  {
    name: 'compact',
    description: 'Summarise the conversation so far to free context',
    argumentHint: '[instructions]',
    source: 'builtin',
    kind: 'action',
  },
  {
    name: 'rename',
    description: 'Name this conversation',
    argumentHint: '<name>',
    aliases: ['name'],
    source: 'builtin',
    kind: 'action',
  },
];

/**
 * What `prompt()` dispatches itself, read from the session as pi's RPC
 * `get_commands` assembles it: extension commands, prompt templates, then
 * skills as `skill:<name>`. A slot without pi-crew has none of crew's: its
 * resource loader dropped them (`crew.ts`). FO's built-ins come first and win
 * a name another source also uses, as pi's TUI built-ins do.
 */
export function piCommands(
  session: Pick<AgentSession, 'extensionRunner' | 'promptTemplates' | 'resourceLoader'>,
): ChatCommand[] {
  const listed: ChatCommand[] = [
    ...session.extensionRunner.getRegisteredCommands().map(
      (command): ChatCommand => ({
        name: command.invocationName,
        description: command.description ?? '',
        source: 'extension',
        kind: 'text',
      }),
    ),
    ...session.promptTemplates.map(
      (template): ChatCommand => ({
        name: template.name,
        description: template.description,
        ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
        source: 'template',
        kind: 'text',
      }),
    ),
    ...session.resourceLoader.getSkills().skills.map(
      (skill): ChatCommand => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skill',
        kind: 'text',
      }),
    ),
  ];
  const seen = new Set(PI_BUILTINS.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const commands = [...PI_BUILTINS];
  for (const command of listed) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    commands.push(command);
  }
  return commands;
}
