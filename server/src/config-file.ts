import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Where the optional settings file lives: `FUNKYOCTOPUS_CONFIG` when set,
 * otherwise `<home>/.funkyoctopus/config.env` (next to the Vault rules file).
 */
export function configFilePath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env.FUNKYOCTOPUS_CONFIG?.trim();
  return override === undefined || override === '' ? join(home, '.funkyoctopus', 'config.env') : override;
}

/**
 * Applies the optional settings file (KEY=VALUE lines, the `.env.example`
 * format) to `env`. A key the real environment already defines is left alone,
 * so the environment always wins. Returns the keys it set. A missing file is
 * no settings at all; a file that exists but cannot be read stops the sidecar,
 * since silently ignoring a half-read config would start it on wrong settings.
 */
export async function applyConfigFile(path: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`cannot read config file ${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
