/**
 * `slots.json` (T2.3): load and write against a temp state dir. Nothing here
 * reads or writes the owner's `~/.local/state`.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSlots, openSlots, slotsFilePath, SlotsWriter, type SlotRecord } from './chat-slots-file.ts';
import { ChatRegistry, type EngineFactory } from './chat-registry.ts';
import { FakeEngine } from './test/fake-chat-engine.ts';
import { repositoryStateDir } from './upkeep/state-path.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fo-slots-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

let records: SlotRecord[] = [];
beforeEach(() => {
  records = [
    { chatId: 'main', kind: 'pi', root: null, session: { engine: 'pi', id: 'p1', path: '/s/a_p1.jsonl' } },
    { chatId: 'c1a2b3c4', kind: 'claude-code', root: dir, session: null },
  ];
});

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('slots.json: where it lives', () => {
  it('is per checkout: two checkouts never share one, aliases of one checkout do', async () => {
    const realpath = (path: string): Promise<string> => Promise.resolve(path === '/alias' ? '/dev/fo' : path);
    const at = (path: string): Promise<string> =>
      repositoryStateDir(path, { fs: { realpath }, stateRoot: dir }).then(slotsFilePath);
    const dev = await at('/dev/fo');
    expect(await at('/home/u/.local/share/funkyoctopus/app')).not.toBe(dev);
    expect(await at('/alias')).toBe(dev);
    expect(dev.startsWith(join(dir, 'funkyoctopus'))).toBe(true);
  });
});

describe('slots.json: loading', () => {
  it('no file is a first start: no records and nothing to warn about', async () => {
    expect(await loadSlots(dir)).toEqual({ records: [], warnings: [] });
  });

  it('reads back what the writer wrote', async () => {
    const writer = new SlotsWriter({ stateDir: dir, read: () => records, delayMs: 1 });
    await writer.close();
    expect(await loadSlots(dir)).toEqual({ records, warnings: [] });
  });

  it.each([
    ['not JSON', '{"version":1,'],
    ['another version', JSON.stringify({ version: 2, slots: [] })],
    ['a malformed slot', JSON.stringify({ version: 1, slots: [{ chatId: 'c1a2b3c4', kind: 'gpt', root: null, session: null }] })],
    ['a session without a path', JSON.stringify({ version: 1, slots: [{ chatId: 'c1a2b3c4', kind: 'pi', root: null, session: { engine: 'pi', id: 'x' } }] })],
    ['a chat listed twice', JSON.stringify({ version: 1, slots: [{ chatId: 'c1a2b3c4', kind: 'pi', root: null, session: null }, { chatId: 'c1a2b3c4', kind: 'pi', root: null, session: null }] })],
    ['a chat id FunkyOctopus never mints', JSON.stringify({ version: 1, slots: [{ chatId: '__proto__', kind: 'pi', root: null, session: null }] })],
    ['an upper-case chat id', JSON.stringify({ version: 1, slots: [{ chatId: 'C1A2B3C4', kind: 'pi', root: null, session: null }] })],
  ])('a file with %s is not trusted at all: no records, and a warning', async (_label, text) => {
    await writeFile(slotsFilePath(dir), text);
    const loaded = await loadSlots(dir);
    expect(loaded.records).toEqual([]);
    expect(loaded.warnings).toEqual([expect.stringMatching(/starting with main only/)]);
  });

  it.each([
    ['relative', 'work/project'],
    ['gone', '/no/such/folder/for/fo-slots'],
  ])('a %s folder is not trusted: the tab comes back at the global root, without its session', async (_label, root) => {
    const text = JSON.stringify({
      version: 1,
      slots: [{ chatId: 'c1a2b3c4', kind: 'pi', root, session: { engine: 'pi', id: 'p1', path: '/s/a_p1.jsonl' } }],
    });
    await writeFile(slotsFilePath(dir), text);
    const loaded = await loadSlots(dir);
    expect(loaded.records).toEqual([{ chatId: 'c1a2b3c4', kind: 'pi', root: null, session: null }]);
    expect(loaded.warnings).toEqual([expect.stringMatching(/c1a2b3c4.*not an existing absolute folder/)]);
  });

  it('a file that cannot be read is a warning, not a crash', async () => {
    await mkdir(slotsFilePath(dir));
    const loaded = await loadSlots(dir);
    expect(loaded.records).toEqual([]);
    expect(loaded.warnings).toEqual([expect.stringMatching(/could not be read.*starting with main only/)]);
  });
});

describe('slots.json: writing', () => {
  it('debounces: a burst of changes is one write, of the records as they stand when it fires', async () => {
    let current: SlotRecord[] = [];
    const writer = new SlotsWriter({ stateDir: dir, read: () => current, delayMs: 15 });
    writer.schedule();
    current = records.slice(0, 1);
    writer.schedule();
    current = records;
    writer.schedule();
    expect(await readdir(dir)).toEqual([]);
    await settle();
    expect((await loadSlots(dir)).records).toEqual(records);
  });

  it('writes atomically, privately, and leaves no staging file behind', async () => {
    const writer = new SlotsWriter({ stateDir: dir, read: () => records, delayMs: 1 });
    writer.schedule();
    await settle();
    expect(await readdir(dir)).toEqual(['slots.json']);
    expect((await stat(slotsFilePath(dir))).mode & 0o777).toBe(0o600);
  });

  it('skips a write that would not change the file', async () => {
    const writer = new SlotsWriter({ stateDir: dir, read: () => records, delayMs: 1 });
    writer.schedule();
    await settle();
    await writeFile(slotsFilePath(dir), 'touched by hand');
    writer.schedule();
    await settle();
    expect(await readFile(slotsFilePath(dir), 'utf8')).toBe('touched by hand');
  });

  it('close records the slots as they stand, and nothing after: shutdown empties the registry next', async () => {
    let current = records;
    const writer = new SlotsWriter({ stateDir: dir, read: () => current, delayMs: 1 });
    writer.schedule();
    await writer.close();
    current = [];
    writer.schedule();
    await writer.close();
    await settle();
    expect((await loadSlots(dir)).records).toEqual(records);
  });

  it('a failed write is logged and retried on the next change', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const missing = join(dir, 'gone');
    const writer = new SlotsWriter({ stateDir: missing, read: () => records, delayMs: 1 });
    writer.schedule();
    await settle();
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/recording the chat tabs failed/));
    await mkdir(missing);
    writer.schedule();
    await settle();
    expect((await loadSlots(missing)).records).toEqual(records);
  });
});

describe('slots.json: one sidecar at a time (slots.lock)', () => {
  it('the first sidecar takes the lock and restores; a second one gets main only and never writes', async () => {
    await new SlotsWriter({ stateDir: dir, read: () => records, delayMs: 1 }).close();
    const first = await openSlots(dir);
    const second = await openSlots(dir);

    expect(first.records).toEqual(records);
    expect(first.warnings).toEqual([]);
    expect(second.records).toEqual([]);
    expect(second.warnings).toEqual([expect.stringMatching(new RegExp(`in use by another sidecar \\(pid ${process.pid}\\)`))]);

    // Two registries over the one state dir, as two sidecars from one checkout would be.
    const factories: Record<'pi' | 'claude-code', EngineFactory> = {
      pi: (ctx) => new FakeEngine('pi', ctx),
      'claude-code': (ctx) => new FakeEngine('claude-code', ctx),
    };
    const one = new ChatRegistry({ mainKind: 'pi', factories, restored: first.records });
    const two = new ChatRegistry({ mainKind: 'pi', factories, restored: second.records });
    expect(one.list().map((slot) => slot.chatId)).toEqual(['main', 'c1a2b3c4']);
    expect(two.list().map((slot) => slot.chatId)).toEqual(['main']);
    expect(second.writer(() => two.records())).toBeNull();
    const writer = first.writer(() => one.records());
    two.create('pi', null);
    await writer?.close();
    expect((await loadSlots(dir)).records.map((record) => record.chatId)).toEqual(['main', 'c1a2b3c4']);

    // Once the first lets go, the next sidecar has it.
    await first.release();
    const third = await openSlots(dir);
    expect(third.records.map((record) => record.chatId)).toEqual(['main', 'c1a2b3c4']);
    await third.release();
  });

  it('a lock left by a sidecar that is gone is taken over', async () => {
    await writeFile(join(dir, 'slots.lock'), '4194999\n');
    const opened = await openSlots(dir, { isAlive: (pid) => pid !== 4194999 });
    expect(opened.warnings).toEqual([]);
    expect((await readFile(join(dir, 'slots.lock'), 'utf8')).trim()).toBe(String(process.pid));
    await opened.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it('sweeps the staging files a crash left, only when it holds the lock', async () => {
    await writeFile(join(dir, 'pending-slots-crashed.json'), '{"version":1,');
    const holder = await openSlots(dir);
    expect((await readdir(dir)).sort()).toEqual(['slots.lock']);
    await writeFile(join(dir, 'pending-slots-in-flight.json'), '{}');
    // A second sidecar must not delete the holder's write in flight.
    await openSlots(dir);
    expect((await readdir(dir)).sort()).toEqual(['pending-slots-in-flight.json', 'slots.lock']);
    await holder.release();
  });
});
