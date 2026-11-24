import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ChatCommand } from '../../../src/shared/transport/protocol.ts';

/**
 * Claude Code commands the `/` palette never offers, by name or alias. Typed by
 * hand they still go to the CLI as text; FO simply does not suggest them.
 *
 * - FO has its own control: `clear`/`new`/`reset` (`/clear` also resets the
 *   conversation under a new session id, which the tab would not follow),
 *   `resume` (History), `model` and `effort` (the pickers), `usage`/`cost`/
 *   `stats` (the status chip), `agents`, and `login`/`logout`/`exit` (a
 *   terminal's business: FO never touches the login, decision 12 limit 3).
 * - Decision 12, limit 2 (human-driven turns only): `schedule`, `routines`,
 *   `ultrareview`, `batch` and `goal` set work going that runs or comes back
 *   on its own; the remote-workflow commands are matched by pattern below.
 *
 * `rename` stays: FO has no rename of its own for a Claude tab, and its own
 * `/rename` is how the conversation gets a name.
 */
export const CLAUDE_HIDDEN_COMMANDS: readonly string[] = [
  'clear',
  'new',
  'reset',
  'resume',
  'model',
  'effort',
  'usage',
  'cost',
  'stats',
  'agents',
  'login',
  'logout',
  'exit',
  'schedule',
  'routines',
  'ultrareview',
  'batch',
  'goal',
];

/** Remote-workflow commands, whatever their exact names in this CLI release (decision 12, limit 2). */
const HIDDEN_PATTERN = /remote-workflow|workflow-launch/u;

const hiddenName = (name: string, terminal: ReadonlySet<string>): boolean =>
  CLAUDE_HIDDEN_COMMANDS.includes(name) || terminal.has(name) || HIDDEN_PATTERN.test(name);

/**
 * A process's list as the palette offers it. A row is dropped when its name or
 * an alias is hidden, or is one of `terminal` (`system/init`'s
 * `terminal_slash_commands`: bound to a terminal). Rows can share a name; the
 * one marked `builtin` is the one `/name` runs, so it is the one kept.
 */
export function claudeCommands(rows: readonly SlashCommand[], terminal: readonly string[]): ChatCommand[] {
  const terminalSet = new Set(terminal);
  const byName = new Map<string, SlashCommand>();
  for (const row of rows) {
    if ([row.name, ...(row.aliases ?? [])].some((name) => hiddenName(name, terminalSet))) continue;
    const held = byName.get(row.name);
    if (!held || (row.builtin === true && held.builtin !== true)) byName.set(row.name, row);
  }
  return [...byName.values()].map((row) => ({
    name: row.name,
    description: row.description,
    ...(row.argumentHint ? { argumentHint: row.argumentHint } : {}),
    ...(row.aliases && row.aliases.length > 0 ? { aliases: [...row.aliases] } : {}),
    source: row.builtin === true ? 'claude-builtin' : 'claude-custom',
    kind: 'text',
  }));
}

/** The last list a process gave in one folder, and the terminal-only names it reported. */
export interface SavedCommands {
  root: string;
  commands: SlashCommand[];
  terminal: string[];
}

/**
 * Where the lists live processes gave are kept, most recent folder first:
 * shared by every Claude slot, and (with `persist`) kept across restarts in
 * `claude-commands.json`. The SDK lists commands only through a live process,
 * and FO never starts one just to ask (decision 12), so a slot with none
 * serves what this holds.
 */
export interface ClaudeCommandCache {
  roots: SavedCommands[];
  /** Told every change, to keep it across restarts. */
  persist?: (roots: SavedCommands[]) => void;
}

/** How many folders' lists are kept. */
export const SAVED_ROOTS_LIMIT = 20;

/** Record what a live process in `root` listed; it becomes that folder's last-known list. */
export function rememberCommands(cache: ClaudeCommandCache, saved: SavedCommands): void {
  cache.roots = [saved, ...cache.roots.filter((entry) => entry.root !== saved.root)].slice(0, SAVED_ROOTS_LIMIT);
  cache.persist?.(cache.roots);
}

/**
 * The last-known list for a slot in `root` with no process: that folder's, or
 * else only Claude Code's own commands from the most recent folder's (a
 * project's or plugin's may not apply here). Null when nothing is known.
 */
export function lastKnownCommands(cache: ClaudeCommandCache, root: string): ChatCommand[] | null {
  const own = cache.roots.find((entry) => entry.root === root);
  if (own) return claudeCommands(own.commands, own.terminal);
  const latest = cache.roots[0];
  if (!latest) return null;
  return claudeCommands(
    latest.commands.filter((row) => row.builtin === true),
    latest.terminal,
  );
}
