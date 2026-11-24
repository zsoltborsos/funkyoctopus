/**
 * The last models list a live `claude` process gave: `claude-models.json` in
 * the checkout's state dir, beside `slots.json`.
 *
 * The SDK can list models only through a live process, and restored tabs start
 * none at boot (T2.3), so without this a restart shows the three aliases until
 * some tab runs a turn. The saved list is only the *last known* one: it is
 * served until the first live process lists the real models, which replace it.
 * A file that cannot be read or does not validate is not trusted at all.
 */

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_CODE_PROVIDER, type ModelOption } from '../../../src/shared/transport/protocol.ts';
import { messageOf } from '../util/errors.ts';
import { isRecord } from '../util/records.ts';
import type { ClaudeModelCache } from './models.ts';

export const MODELS_FILE = 'claude-models.json';
const PENDING_PREFIX = 'pending-models-';
const MODELS_VERSION = 1;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isModality = (value: unknown): value is 'text' | 'image' => value === 'text' || value === 'image';

function parseModel(value: unknown): ModelOption | null {
  if (!isRecord(value)) return null;
  const { provider, id, name, resolvedId, thinkingLevels, input } = value;
  if (provider !== CLAUDE_CODE_PROVIDER || !isText(id) || !isText(name)) return null;
  if (resolvedId !== undefined && !isText(resolvedId)) return null;
  if (!Array.isArray(thinkingLevels) || !thinkingLevels.every(isText)) return null;
  if (!Array.isArray(input) || !input.every(isModality)) return null;
  return { provider, id, name, ...(resolvedId !== undefined ? { resolvedId } : {}), thinkingLevels, input };
}

/** The models in a file's text, or why the text is not a models file. */
function parseModels(text: string): { models: ModelOption[] } | { invalid: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { invalid: `not JSON (${messageOf(error)})` };
  }
  if (!isRecord(parsed) || parsed.version !== MODELS_VERSION || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    return { invalid: `not a version ${MODELS_VERSION} models file with models in it` };
  }
  const models: ModelOption[] = [];
  for (const [index, raw] of parsed.models.entries()) {
    const model = parseModel(raw);
    if (!model) return { invalid: `model ${index} is malformed` };
    models.push(model);
  }
  return { models };
}

/**
 * Replace the saved list: atomic, as a private staging file renamed over the old
 * one, so a crash leaves the old file or the new one, never half of either. A
 * failed write is logged; the list in memory is unaffected.
 */
async function saveModels(stateDir: string, models: ModelOption[]): Promise<void> {
  const text = `${JSON.stringify({ version: MODELS_VERSION, models }, null, 2)}\n`;
  const pending = join(stateDir, `${PENDING_PREFIX}${randomUUID()}.json`);
  try {
    // On disk before it replaces the old file.
    const file = await open(pending, 'w', 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(pending, join(stateDir, MODELS_FILE));
  } catch (error) {
    await unlink(pending).catch(() => undefined);
    console.error(`[models] keeping the Claude model list failed: ${messageOf(error)}`);
  }
}

/**
 * The list saved at `path`. No file is a first start: no list, no warning. A file
 * that cannot be read or does not validate gives no list and the warning to log.
 */
async function loadModels(path: string): Promise<{ models: ModelOption[] | null; warnings: string[] }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { models: null, warnings: [] };
    return { models: null, warnings: [`${path} could not be read (${messageOf(error)}); offering the aliases until a Claude tab runs`] };
  }
  const parsed = parseModels(text);
  if ('invalid' in parsed) return { models: null, warnings: [`${path} is ${parsed.invalid}; offering the aliases until a Claude tab runs`] };
  return { models: parsed.models, warnings: [] };
}

/**
 * The cache the Claude slots share, starting from the list saved in `stateDir`
 * (marked stale) and saving each live list that replaces it. Nothing is written
 * until then. Without a state dir the aliases stand until a process lists.
 */
export async function openClaudeModels(stateDir: string | null): Promise<{ cache: ClaudeModelCache; warnings: string[] }> {
  if (stateDir === null) return { cache: { models: null }, warnings: [] };
  const { models, warnings } = await loadModels(join(stateDir, MODELS_FILE));
  // An empty answer is not a list worth keeping (the file would not validate).
  const persist = (live: ModelOption[]): void => {
    if (live.length > 0) void saveModels(stateDir, live);
  };
  return { cache: models ? { models, stale: true, persist } : { models: null, persist }, warnings };
}
