/**
 * `claude-commands.json`: the last command lists live Claude processes gave,
 * per folder, kept in the state dir so a restarted sidecar's Claude tabs offer
 * them before any process runs. Against a temp state dir; nothing here reads
 * or writes the owner's `~/.local/state`, and no `claude` is spawned.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROOT, harness, send } from '../test/claude-chat-harness.ts';
import { COMMANDS_FILE, openClaudeCommands } from './commands-file.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fo-claude-commands-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const CONTEXT = { name: 'context', description: 'Show context', argumentHint: '', builtin: true };
const DEPLOY = { name: 'deploy', description: 'Ship it', argumentHint: '<env>' };

describe('claude-commands.json', () => {
  it('no state dir, or no file yet: no lists, no warning', async () => {
    for (const stateDir of [null, dir]) {
      const { cache, warnings } = await openClaudeCommands(stateDir);
      expect(cache.roots).toEqual([]);
      expect(warnings).toEqual([]);
    }
  });

  it('a file that is not a commands file is not trusted at all, with a warning', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const text of ['{', JSON.stringify({ version: 2, roots: [] }), JSON.stringify({ version: 1, roots: [{ root: '/a', commands: [{ name: 1 }], terminal: [] }] })]) {
      await writeFile(join(dir, COMMANDS_FILE), text);
      const { cache, warnings } = await openClaudeCommands(dir);
      expect(cache.roots).toEqual([]);
      expect(warnings).toHaveLength(1);
    }
  });

  it('keeps what a live process listed, and a restart serves it to a tab with no process, starting none', async () => {
    const first = await openClaudeCommands(dir);
    const { chat, fake } = harness(['plain'], { commandCache: first.cache });
    fake.onStart = (query) => {
      query.commands = [CONTEXT, DEPLOY];
    };
    await send(chat, 'hello');
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(dir, COMMANDS_FILE), 'utf8')) as { roots: { root: string }[] };
      expect(saved.roots.map((entry) => entry.root)).toEqual([ROOT]);
    });
    expect((await readdir(dir)).filter((name) => name.startsWith('pending-'))).toEqual([]);

    // The next sidecar: the tab is restored with no process.
    const second = await openClaudeCommands(dir);
    const restarted = harness([], { commandCache: second.cache });
    expect(await restarted.chat.commands()).toEqual({
      state: 'last-known',
      commands: [
        { name: 'context', description: 'Show context', source: 'claude-builtin', kind: 'text' },
        { name: 'deploy', description: 'Ship it', argumentHint: '<env>', source: 'claude-custom', kind: 'text' },
      ],
    });
    expect(restarted.fake.queries).toHaveLength(0);
  });
});
