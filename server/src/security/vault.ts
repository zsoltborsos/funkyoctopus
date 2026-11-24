import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

export type VaultAction = 'block' | 'escalate';
export interface VaultRule {
  target: string;
  action: VaultAction;
}

export interface VaultEscalation {
  callId: string;
  tool: string;
  target: string;
  args: unknown;
}

export type EscalationHandler = (
  request: VaultEscalation,
  signal?: AbortSignal,
) => Promise<boolean>;

const DEFAULT_RULES: VaultRule[] = [{ target: '~/.ssh', action: 'block' }];
export const DEFAULT_VAULT_PATH = join(homedir(), '.funkyoctopus', 'vault.json');

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function isRule(value: unknown): value is VaultRule {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.target === 'string' && (item.action === 'block' || item.action === 'escalate')
  );
}

export async function loadVaultRules(path = DEFAULT_VAULT_PATH): Promise<VaultRule[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isRule)) {
      throw new Error(`Invalid Vault config: ${path}`);
    }
    return parsed;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(DEFAULT_RULES, null, 2)}\n`, { flag: 'wx' }).catch(
      (writeError: unknown) => {
        const writeCode = writeError instanceof Error && 'code' in writeError ? writeError.code : undefined;
        if (writeCode !== 'EEXIST') throw writeError;
      },
    );
    return DEFAULT_RULES;
  }
}

async function realpathAllowMissing(path: string, basePath = process.cwd()): Promise<string> {
  const expanded = expandHome(path);
  const absolute = isAbsolute(expanded) ? expanded : resolve(basePath, expanded);
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await realpathAllowMissing(parent, basePath), absolute.slice(parent.length + 1));
  }
}

function containedBy(candidate: string, target: string): boolean {
  const offset = relative(target, candidate);
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset));
}

function structuredPaths(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  const input = args as Record<string, unknown>;
  return [input.path, input.file_path, input.notebook_path].filter(
    (value): value is string => typeof value === 'string',
  );
}

/** Deterministic guard for structured paths; shell matching is explicitly a literal tripwire only. */
export class VaultGuard {
  constructor(
    private readonly rules: VaultRule[],
    private readonly onEscalate: EscalationHandler,
    private readonly basePath = process.cwd(),
  ) {}

  static async create(
    onEscalate: EscalationHandler,
    path = DEFAULT_VAULT_PATH,
    basePath = process.cwd(),
  ): Promise<VaultGuard> {
    return new VaultGuard(await loadVaultRules(path), onEscalate, basePath);
  }

  private async matchingRule(args: unknown): Promise<VaultRule | undefined> {
    for (const rule of this.rules) {
      const target = await realpathAllowMissing(rule.target);
      for (const candidate of structuredPaths(args)) {
        if (containedBy(await realpathAllowMissing(candidate, this.basePath), target)) return rule;
      }
      // A `command` is a shell line whatever the tool is called: pi's `bash`, Claude
      // Code's `Bash`, `PowerShell` and `Monitor`. Matched on the field, not the name.
      if (typeof (args as Record<string, unknown> | null)?.command === 'string') {
        const command = (args as Record<string, unknown>).command as string;
        const expanded = expandHome(rule.target);
        if (command.includes(rule.target) || command.includes(expanded)) return rule;
      }
    }
    return undefined;
  }

  async guard(
    callId: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ block: true; reason: string } | undefined> {
    const rule = await this.matchingRule(args);
    if (!rule) return undefined;
    if (rule.action === 'block') {
      return { block: true, reason: `Vault blocked access to ${rule.target}` };
    }
    const approved = await this.onEscalate(
      { callId, tool, target: rule.target, args },
      signal,
    );
    return approved ? undefined : { block: true, reason: `Vault denied access to ${rule.target}` };
  }
}
