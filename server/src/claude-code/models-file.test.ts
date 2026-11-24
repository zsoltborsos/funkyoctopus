/**
 * `claude-models.json`: the last list a live Claude process gave, kept in the
 * state dir so a restart can show it before any process runs. Against a temp
 * state dir; nothing here reads or writes the owner's `~/.local/state`.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../../../src/shared/transport/protocol.ts';
import { harness, send } from '../test/claude-chat-harness.ts';
import { openClaudeModels } from './models-file.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fo-claude-models-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const FABLE: ModelOption = {
  provider: 'claude-code',
  id: 'fable',
  name: 'Fable 5',
  resolvedId: 'claude-fable-5',
  thinkingLevels: ['low', 'high'],
  input: ['text', 'image'],
};
const HAIKU_45: ModelOption = {
  provider: 'claude-code',
  id: 'claude-haiku-4-5-20251001',
  name: 'Haiku 4.5',
  thinkingLevels: [],
  input: ['text', 'image'],
};
const saved = (models: unknown): Promise<void> =>
  writeFile(join(dir, 'claude-models.json'), JSON.stringify({ version: 1, models }));

describe('claude-models.json: opening at boot', () => {
  it('offers the list the last run saved, as the last known one', async () => {
    await saved([FABLE, HAIKU_45]);

    const { cache, warnings } = await openClaudeModels(dir);

    expect(cache.models).toEqual([FABLE, HAIKU_45]);
    expect(cache.stale).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe('claude-models.json: nothing usable at boot', () => {
  it('no state dir, or no file yet, leaves the aliases to stand, without a warning', async () => {
    for (const stateDir of [null, dir]) {
      const { cache, warnings } = await openClaudeModels(stateDir);
      expect(cache.models).toBeNull();
      expect(warnings).toEqual([]);
    }
  });

  it.each([
    ['not JSON', '{"version":1,'],
    ['another version', JSON.stringify({ version: 2, models: [FABLE] })],
    ['no models list', JSON.stringify({ version: 1 })],
    ['an empty list', JSON.stringify({ version: 1, models: [] })],
    ['a model of another provider', JSON.stringify({ version: 1, models: [FABLE, { ...HAIKU_45, provider: 'openai' }] })],
    ['a model without an id', JSON.stringify({ version: 1, models: [{ ...FABLE, id: '' }] })],
    ['a model without a name', JSON.stringify({ version: 1, models: [{ ...FABLE, name: undefined }] })],
    ['a ladder that is not text', JSON.stringify({ version: 1, models: [{ ...FABLE, thinkingLevels: [1] }] })],
    ['an input that is not a modality', JSON.stringify({ version: 1, models: [{ ...FABLE, input: ['video'] }] })],
    ['a resolved id that is not text', JSON.stringify({ version: 1, models: [{ ...FABLE, resolvedId: 5 }] })],
  ])('does not trust a file that is %s: the aliases stand and the log says why', async (_name, text) => {
    await writeFile(join(dir, 'claude-models.json'), text);

    const { cache, warnings } = await openClaudeModels(dir);

    expect(cache.models).toBeNull();
    expect(cache.stale).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining(join(dir, 'claude-models.json'))]);
  });

  it('does not trust a file that cannot be read', async () => {
    await mkdir(join(dir, 'claude-models.json'));

    const { cache, warnings } = await openClaudeModels(dir);

    expect(cache.models).toBeNull();
    expect(warnings).toEqual([expect.stringContaining('could not be read')]);
  });
});

describe('claude-models.json: keeping the live list', () => {
  const recorded = JSON.parse(
    readFileSync(new URL('./fixtures/supported-models.json', import.meta.url), 'utf8'),
  ) as { value: string }[];
  const recordedIds = recorded.map((model) => model.value);
  const idsAt = async (stateDir: string): Promise<string[] | undefined> =>
    (await openClaudeModels(stateDir)).cache.models?.map((model) => model.id);

  it('writes nothing at boot, whatever it finds', async () => {
    await openClaudeModels(dir);
    expect(await readdir(dir)).toEqual([]);

    await writeFile(join(dir, 'claude-models.json'), 'not json');
    await openClaudeModels(dir);
    expect(await readFile(join(dir, 'claude-models.json'), 'utf8')).toBe('not json');
  });

  it('saves the first live process’s list, so the next boot offers it before any process runs', async () => {
    await saved([FABLE]);
    const { cache } = await openClaudeModels(dir);
    const { chat } = harness(['plain'], { modelCache: cache }, recorded);

    await send(chat, 'one');

    await expect.poll(() => idsAt(dir)).toEqual(recordedIds);
    // Whole file, private, and no staging file left behind.
    expect(JSON.parse(await readFile(join(dir, 'claude-models.json'), 'utf8'))).toMatchObject({ version: 1 });
    expect((await stat(join(dir, 'claude-models.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['claude-models.json']);
  });

  it('keeps the saved list when a live process cannot list models', async () => {
    await saved([FABLE]);
    const { cache } = await openClaudeModels(dir);
    const { chat, fake } = harness(['plain'], { modelCache: cache }, new Error('no models today'));

    await send(chat, 'one');
    await expect.poll(() => fake.queries[0]?.supportedModelsAsked).toBe(1);

    expect(await idsAt(dir)).toEqual(['fable']);
  });

  it('does not save an empty list over a good one', async () => {
    await saved([FABLE]);
    const { cache } = await openClaudeModels(dir);

    cache.persist?.([]);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await idsAt(dir)).toEqual(['fable']);
  });

  it('logs a save that fails and carries on, leaving no staging file', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gone = join(dir, 'gone');
    await mkdir(gone);
    const { cache } = await openClaudeModels(gone);
    await rm(gone, { recursive: true });

    cache.persist?.([FABLE]);

    await expect.poll(() => error.mock.calls.length).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('claude-models');
    expect(await readdir(dir)).toEqual([]);
  });
});
