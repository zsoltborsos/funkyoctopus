import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import type { VaultGuard } from '../security/vault.ts';

export interface HelmraiserRunTarget {
  projectPath: string;
  runId: string;
}

/** Starts a Helmraiser process and resolves once the OS reports a successful spawn. */
export type HelmraiserRunner = (args: string[], cwd: string) => Promise<void>;

const defaultRunner: HelmraiserRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(config.helmraiserBin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8 * 1024);
    });
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(new Error(stderr.trim() || error.message));
    });
  });

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} is required`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Adapt the shared Vault matcher to Helmraiser's deliberately non-interactive subprocess policy. */
export function vaultBeforeSpawn(guard: VaultGuard): (args: string[]) => Promise<void> {
  return async (args) => {
    const command = [config.helmraiserBin, ...args].map(shellQuote).join(' ');
    const decision = await guard.guard(randomUUID(), 'bash', { command });
    if (decision) throw new Error(decision.reason);
  };
}

/** Abort path for governed Helmraiser runs; status and progress come from the CLI (`cli.ts`). */
export class HelmraiserFactory {
  constructor(
    private readonly run: HelmraiserRunner = defaultRunner,
    private readonly beforeSpawn?: (args: string[], cwd: string) => Promise<void>,
  ) {}

  async abort(target: HelmraiserRunTarget): Promise<void> {
    const projectPath = required(target.projectPath, 'projectPath');
    const runId = required(target.runId, 'runId');
    await this.execute(['abort', runId, '--project-dir', projectPath], projectPath);
  }

  private async execute(args: string[], cwd: string): Promise<void> {
    await this.beforeSpawn?.(args, cwd);
    await this.run(args, cwd);
  }
}
