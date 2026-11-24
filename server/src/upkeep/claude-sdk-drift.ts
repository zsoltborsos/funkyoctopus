import { readFile } from 'node:fs/promises';
import type { ClaudeSdkUpkeepInfo } from '../../../src/shared/transport/protocol.ts';
import { resolveClaudeBin } from '../claude-code/cli.ts';
import { claudeChildEnv } from '../claude-code/env.ts';
import { nodeSpawn, runCommand, type CommandOutcome, type RunCommandOptions } from './run-command.ts';
import { exactStableString, parseExactStableVersion } from './versions.ts';

export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const SDK_MANIFEST = new URL('../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url);

export interface ClaudeSdkDriftDeps {
  env: NodeJS.ProcessEnv;
  version: string;
  resolveBin: (bin: string, path: string) => Promise<string | null>;
  run: (options: RunCommandOptions) => Promise<CommandOutcome>;
  readFile: (path: URL) => Promise<string>;
}
export type ClaudeCliVersionDeps = Omit<ClaudeSdkDriftDeps, 'readFile'>;

export function parseClaudeCliVersion(output: string): string | null {
  const match = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/.exec(output.trim());
  return match?.[1] ? exactStableString(match[1]) : null;
}

/** Only the measured/documented CLI 2.1.N ↔ SDK 0.3.N pairing is understood. */
export function sdkVersionForCli(cliVersion: string): string | null {
  const cli = parseExactStableVersion(cliVersion);
  return cli?.major === 2 && cli.minor === 1 ? `0.3.${cli.patch}` : null;
}

export function claudeSdkDriftOf(cliVersion: string | null, sdkVersion: string | null): ClaudeSdkUpkeepInfo {
  const cli = cliVersion === null ? null : parseExactStableVersion(cliVersion);
  const sdk = sdkVersion === null ? null : parseExactStableVersion(sdkVersion);
  const supported = cli?.major === 2 && cli.minor === 1 && sdk?.major === 0 && sdk.minor === 3;
  return { status: supported ? (cli.patch === sdk.patch ? 'in-sync' : 'drift') : 'unknown', cliVersion, sdkVersion };
}

export async function readClaudeCliVersion(deps: ClaudeCliVersionDeps): Promise<string | null> {
  try {
    const bin = await deps.resolveBin(deps.env.CLAUDE_BIN ?? 'claude', deps.env.PATH ?? '');
    if (bin === null) return null;
    const result = await deps.run({ command: bin, args: ['--version'], timeoutMs: 10_000,
      maxOutputBytes: 4096, env: claudeChildEnv(deps.env, deps.version) });
    return result.kind === 'exit' && result.code === 0 && result.facts.droppedBytes === 0
      ? parseClaudeCliVersion(result.facts.stdout) : null;
  } catch {
    return null;
  }
}

/** Read independently, retaining whichever version remains available. Never mutates state. */
export async function detectClaudeSdkDrift(deps: ClaudeSdkDriftDeps): Promise<ClaudeSdkUpkeepInfo> {
  const cli = readClaudeCliVersion(deps);
  let sdk: string | null = null;
  try {
    const pkg = JSON.parse(await deps.readFile(SDK_MANIFEST)) as { version?: unknown } | null;
    sdk = typeof pkg?.version === 'string' ? exactStableString(pkg.version) : null;
  } catch { /* Unavailable manifests are an unknown version, not a startup error. */ }
  return claudeSdkDriftOf(await cli, sdk);
}

/** Inert bindings: no filesystem or process work until a reader is called. */
export function productionClaudeSdkDriftDeps(env: NodeJS.ProcessEnv, version: string): ClaudeSdkDriftDeps {
  return { env, version, resolveBin: resolveClaudeBin, readFile: (path) => readFile(path, 'utf8'),
    run: (options) => runCommand({ spawn: nodeSpawn }, options) };
}
