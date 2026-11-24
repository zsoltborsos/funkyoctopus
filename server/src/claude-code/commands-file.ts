/**
 * The last command lists live `claude` processes gave, per folder:
 * `claude-commands.json` in the checkout's state dir, beside
 * `claude-models.json`.
 *
 * The SDK lists commands only through a live process, and FO never starts one
 * just to ask (decision 12), so without this a restarted sidecar's Claude tabs
 * offer no `/` commands until each runs a turn. A saved list is only the last
 * known one: a live process's list replaces it. A file that cannot be read or
 * does not validate is not trusted at all.
 */

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import { messageOf } from '../util/errors.ts';
import { isRecord } from '../util/records.ts';
import { SAVED_ROOTS_LIMIT, type ClaudeCommandCache, type SavedCommands } from './commands.ts';

export const COMMANDS_FILE = 'claude-commands.json';
const PENDING_PREFIX = 'pending-commands-';
const COMMANDS_VERSION = 1;

const isText = (value: unknown): value is string => typeof value === 'string';
const isName = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseCommand(value: unknown): SlashCommand | null {
  if (!isRecord(value)) return null;
  const { name, description, argumentHint, aliases, builtin } = value;
  if (!isName(name) || !isText(description) || !isText(argumentHint)) return null;
  if (aliases !== undefined && !(Array.isArray(aliases) && aliases.every(isName))) return null;
  if (builtin !== undefined && typeof builtin !== 'boolean') return null;
  return {
    name,
    description,
    argumentHint,
    ...(aliases !== undefined ? { aliases } : {}),
    ...(builtin !== undefined ? { builtin } : {}),
  };
}

function parseRoot(value: unknown): SavedCommands | null {
  if (!isRecord(value)) return null;
  const { root, commands, terminal } = value;
  if (!isName(root) || !Array.isArray(commands) || !Array.isArray(terminal) || !terminal.every(isName)) return null;
  const parsed: SlashCommand[] = [];
  for (const raw of commands) {
    const command = parseCommand(raw);
    if (!command) return null;
    parsed.push(command);
  }
  return { root, commands: parsed, terminal };
}

/** The saved lists in a file's text, or why the text is not a commands file. */
function parseCommands(text: string): { roots: SavedCommands[] } | { invalid: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { invalid: `not JSON (${messageOf(error)})` };
  }
  if (!isRecord(parsed) || parsed.version !== COMMANDS_VERSION || !Array.isArray(parsed.roots)) {
    return { invalid: `not a version ${COMMANDS_VERSION} commands file` };
  }
  const roots: SavedCommands[] = [];
  for (const [index, raw] of parsed.roots.entries()) {
    const saved = parseRoot(raw);
    if (!saved) return { invalid: `folder ${index} is malformed` };
    roots.push(saved);
  }
  return { roots: roots.slice(0, SAVED_ROOTS_LIMIT) };
}

/**
 * Replace the saved lists: atomic, as a private staging file renamed over the
 * old one, so a crash leaves the old file or the new one. A failed write is
 * logged; the lists in memory are unaffected.
 */
async function saveCommands(stateDir: string, roots: SavedCommands[]): Promise<void> {
  const text = `${JSON.stringify({ version: COMMANDS_VERSION, roots }, null, 2)}\n`;
  const pending = join(stateDir, `${PENDING_PREFIX}${randomUUID()}.json`);
  try {
    const file = await open(pending, 'w', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(pending, join(stateDir, COMMANDS_FILE));
  } catch (error) {
    await unlink(pending).catch(() => undefined);
    console.error(`[commands] keeping the Claude command lists failed: ${messageOf(error)}`);
  }
}

/**
 * The cache the Claude slots share, starting from the lists saved in
 * `stateDir` and saving each change. No file is a first start: no lists, no
 * warning. Without a state dir nothing is kept across restarts.
 */
export async function openClaudeCommands(
  stateDir: string | null,
): Promise<{ cache: ClaudeCommandCache; warnings: string[] }> {
  if (stateDir === null) return { cache: { roots: [] }, warnings: [] };
  const path = join(stateDir, COMMANDS_FILE);
  const persist = (roots: SavedCommands[]): void => void saveCommands(stateDir, roots);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cache: { roots: [], persist }, warnings: [] };
    return { cache: { roots: [], persist }, warnings: [`${path} could not be read (${messageOf(error)}); Claude tabs list their commands once their process runs`] };
  }
  const parsed = parseCommands(text);
  if ('invalid' in parsed) {
    return { cache: { roots: [], persist }, warnings: [`${path} is ${parsed.invalid}; Claude tabs list their commands once their process runs`] };
  }
  return { cache: { roots: parsed.roots, persist }, warnings: [] };
}
