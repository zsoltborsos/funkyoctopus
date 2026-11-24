/**
 * The chat slots a sidecar brings back after a restart (T2.3, decision 13):
 * `slots.json` in the checkout's state dir, which is keyed by the checkout's
 * real path (`upkeep/state-path.ts`), so the dev sidecars and the deployed
 * service never share one.
 *
 * It is UI state only (non-goal 7): which tabs exist, their engine and folder,
 * and the engine session each held. Never a transcript, a model turn or
 * anything an engine owns. A file that cannot be read or does not validate is
 * not trusted at all: the sidecar starts with `main` only and says why.
 *
 * One sidecar per state dir uses it (`slots.lock`, a pid lock): two sidecars
 * from one checkout would otherwise arm the same sessions, each with its own
 * holder index, and write one pi JSONL from two processes. The second starts
 * with `main` only and neither restores nor records tabs.
 */

import { randomUUID } from 'node:crypto';
import { open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { EngineKind } from '../../src/shared/transport/protocol.ts';
import { messageOf } from './util/errors.ts';
import { isRecord } from './util/records.ts';

export const SLOTS_FILE = 'slots.json';
const SLOTS_LOCK = 'slots.lock';
const PENDING_PREFIX = 'pending-slots-';
const SLOTS_VERSION = 1;
/** `main`, or an id the registry minted (8 lower-case hex). Nothing else names a tab. */
const CHAT_ID = /^(main|[0-9a-f]{8})$/;

/** One slot as recorded: enough to arm it again, nothing more. */
export interface SlotRecord {
  chatId: string;
  kind: EngineKind;
  /** The slot's folder; null for the configured global root. */
  root: string | null;
  /** The engine session the slot held, if any. */
  session: { engine: EngineKind; id: string; path: string } | null;
}

export const slotsFilePath = (stateDir: string): string => join(stateDir, SLOTS_FILE);

const isKind = (value: unknown): value is EngineKind => value === 'pi' || value === 'claude-code';
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function parseRecord(value: unknown): SlotRecord | null {
  if (!isRecord(value)) return null;
  const { chatId, kind, root, session } = value;
  if (!isText(chatId) || !CHAT_ID.test(chatId) || !isKind(kind) || !(root === null || isText(root))) return null;
  if (session === null) return { chatId, kind, root, session: null };
  if (!isRecord(session) || !isKind(session.engine) || !isText(session.id) || !isText(session.path)) return null;
  return { chatId, kind, root, session: { engine: session.engine, id: session.id, path: session.path } };
}

/** The records in a file's text, or why the text is not a slots file. */
export function parseSlots(text: string): { records: SlotRecord[] } | { invalid: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { invalid: `not JSON (${messageOf(error)})` };
  }
  if (!isRecord(parsed) || parsed.version !== SLOTS_VERSION || !Array.isArray(parsed.slots)) {
    return { invalid: `not a version ${SLOTS_VERSION} slots file` };
  }
  const records: SlotRecord[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of parsed.slots.entries()) {
    const record = parseRecord(raw);
    if (!record) return { invalid: `slot ${index} is malformed` };
    if (seen.has(record.chatId)) return { invalid: `chat ${record.chatId} is listed twice` };
    seen.add(record.chatId);
    records.push(record);
  }
  return { records };
}

/** An absolute path naming a folder that exists now. */
const isFolder = (path: string): Promise<boolean> =>
  isAbsolute(path) ? stat(path).then((entry) => entry.isDirectory(), () => false) : Promise.resolve(false);

/**
 * The slots recorded in `stateDir`. No file is a first start: no records, no
 * warning. A file that cannot be read or does not validate yields no records
 * and the warning to log. A folder that is not an existing absolute path is not
 * trusted either: pi would reopen the session with it as its working folder, so
 * that tab comes back at the global root without its session.
 */
export async function loadSlots(stateDir: string): Promise<{ records: SlotRecord[]; warnings: string[] }> {
  const path = slotsFilePath(stateDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], warnings: [] };
    return { records: [], warnings: [`${path} could not be read (${messageOf(error)}); starting with main only`] };
  }
  const parsed = parseSlots(text);
  if ('invalid' in parsed) return { records: [], warnings: [`${path} is ${parsed.invalid}; starting with main only`] };
  const warnings: string[] = [];
  const records = await Promise.all(
    parsed.records.map(async (record) => {
      if (record.root === null || (await isFolder(record.root))) return record;
      warnings.push(`${record.chatId}: ${record.root} is not an existing absolute folder; the tab restores empty at the global root`);
      return { ...record, root: null, session: null };
    }),
  );
  return { records, warnings };
}

/** Whether a process with this pid is running (a pid we may not signal still is). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Take `slots.lock` for this process; the pid holding it when another live one does. */
async function takeLock(lockPath: string, pid: number, isAlive: (pid: number) => boolean): Promise<number | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim());
    if (Number.isSafeInteger(holder) && holder > 0 && isAlive(holder)) return holder;
    // Left by a sidecar that is gone (or torn): take it over, once.
    await unlink(lockPath).catch(() => undefined);
  }
  return -1;
}

export interface OpenedSlots {
  records: SlotRecord[];
  /** What to log: a file not trusted, a folder gone, or the file in use by another sidecar. */
  warnings: string[];
  /** This sidecar's writer, or null when another sidecar holds the file. */
  writer: (read: () => SlotRecord[]) => SlotsWriter | null;
  /** Let go of the lock (shutdown, after the last write). */
  release: () => Promise<void>;
}

/**
 * Open the state dir's slots for this sidecar: take the lock, sweep the staging
 * files a crash left, and load. Without the lock, nothing is restored, swept
 * or written.
 */
export async function openSlots(
  stateDir: string,
  deps: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<OpenedSlots> {
  const pid = deps.pid ?? process.pid;
  const lockPath = join(stateDir, SLOTS_LOCK);
  const holder = await takeLock(lockPath, pid, deps.isAlive ?? processAlive);
  if (holder !== null) {
    return {
      records: [],
      warnings: [
        `${slotsFilePath(stateDir)} is in use by another sidecar (pid ${holder < 0 ? '?' : holder}) from this checkout; starting with main only, and this sidecar's tabs are not kept`,
      ],
      writer: () => null,
      release: () => Promise.resolve(),
    };
  }
  const names = await readdir(stateDir).catch(() => [] as string[]);
  await Promise.all(
    names.filter((name) => name.startsWith(PENDING_PREFIX)).map((name) => unlink(join(stateDir, name)).catch(() => undefined)),
  );
  const { records, warnings } = await loadSlots(stateDir);
  return {
    records,
    warnings,
    writer: (read) => new SlotsWriter({ stateDir, read }),
    release: async () => {
      const held = (await readFile(lockPath, 'utf8').catch(() => '')).trim();
      if (held === String(pid)) await unlink(lockPath).catch(() => undefined);
    },
  };
}

export interface SlotsWriterOptions {
  stateDir: string;
  /** The records as they stand, read when a write fires (not when it is asked for). */
  read: () => SlotRecord[];
  /** How long a write waits for further changes; 250 ms by default. */
  delayMs?: number;
}

/**
 * Writes the slots file: debounced, since a turn moves slot state several
 * times; skipped when the text would not change; atomic, as a private staging
 * file renamed over the old one, so a crash leaves the old file or the new one,
 * never half of either. A failed write is logged and the next change retries.
 */
export class SlotsWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private written: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: SlotsWriterOptions) {}

  /** Something changed: write within the debounce delay. */
  schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.write();
    }, this.options.delayMs ?? 250);
    this.timer.unref();
  }

  /**
   * Shutdown: record the slots as they stand now, before the registry is
   * emptied, and write nothing after. Resolves when that last write is done.
   */
  close(): Promise<void> {
    // A second shutdown signal must not record the registry it has emptied.
    if (this.stopped) return this.writing;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const records = this.options.read();
    this.stopped = true;
    return this.write(records);
  }

  private write(records?: SlotRecord[]): Promise<void> {
    this.writing = this.writing.then(async () => {
      // A debounced write that fires after close would read an emptied registry.
      if (this.stopped && records === undefined) return;
      const text = `${JSON.stringify({ version: SLOTS_VERSION, slots: records ?? this.options.read() }, null, 2)}\n`;
      if (text === this.written) return;
      const pending = join(this.options.stateDir, `${PENDING_PREFIX}${randomUUID()}.json`);
      try {
        // On disk before it replaces the old file, so a crash leaves one whole file or the other.
        const file = await open(pending, 'w', 0o600);
        try {
          await file.writeFile(text);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(pending, slotsFilePath(this.options.stateDir));
        this.written = text;
      } catch (error) {
        await unlink(pending).catch(() => undefined);
        console.error(`[chats] recording the chat tabs failed: ${messageOf(error)}`);
      }
    });
    return this.writing;
  }
}
