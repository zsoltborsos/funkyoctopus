import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SIDECAR_PORT } from '../../src/shared/transport/protocol.ts';
import { DEFAULT_VAULT_PATH } from './security/vault.ts';

/**
 * Browser Origins the WebSocket accepts before upgrade. The pair matches the
 * pinned Vite dev origins (development runs on 14174 so the installed service
 * keeps 14787); an absent Origin stays allowed for non-browser automation, so
 * this list governs browsers only. A serving sidecar appends its own
 * same-port loopback origins at runtime (`parseWsAllowedOrigins`).
 */
export const DEFAULT_WS_ALLOWED_ORIGINS = ['http://localhost:14174', 'http://127.0.0.1:14174'] as const;

/** Project roots the folder list scans one level deep, in selector order. */
const DEFAULT_PROJECT_ROOTS = [join(homedir(), 'projects')] as const;

/**
 * Parses FUNKYOCTOPUS_WORKSPACE_ROOTS-style comma-separated project roots:
 * entries are whitespace-trimmed and empty segments dropped, so an unset
 * variable uses the defaults while an explicitly empty value means none.
 */
function parseProjectRoots(): string[] {
  const raw = process.env.FUNKYOCTOPUS_PROJECT_ROOTS;
  if (raw === undefined) {
    return [...DEFAULT_PROJECT_ROOTS];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Parses FUNKYOCTOPUS_SERVE_UI: unset or blank means the sidecar serves no UI;
 * `1` means the repository's own `dist/`; any other value is a dist directory
 * (absolute, or relative to the process CWD).
 */
function parseServeUiDir(): string | undefined {
  const raw = process.env.FUNKYOCTOPUS_SERVE_UI;
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  if (raw === '1') {
    // config.ts lives at <repo>/server/src, so the repository dist is two up.
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
  }
  return resolve(raw);
}

/**
 * Parses FUNKYOCTOPUS_WS_ORIGINS: comma-separated exact origins, entries
 * whitespace-trimmed. An empty or whitespace-only override keeps the defaults
 * rather than opening access; empty comma segments are dropped. When the
 * sidecar serves the built UI, the same-port loopback origins are appended so
 * the served page can reach the WebSocket without an extra override.
 */
function parseWsAllowedOrigins(port: number, servingUi: boolean): readonly string[] {
  const raw = process.env.FUNKYOCTOPUS_WS_ORIGINS;
  const base: readonly string[] =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_WS_ALLOWED_ORIGINS
      : raw
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '');
  if (!servingUi) {
    return base;
  }
  const serving = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return [...base, ...serving.filter((origin) => !base.includes(origin))];
}

/**
 * Parses FUNKYOCTOPUS_CHAT_ENGINE, the engine behind the `main` chat slot: unset or
 * blank is pi; `claude-code` drives Claude Code on the owner's own sign-in.
 * Read at start, so switching means a restart. A name it does not know stops the
 * sidecar: a typo must not quietly pick an engine, least of all a metered one.
 */
function parseChatEngine(): 'pi' | 'claude-code' {
  const raw = process.env.FUNKYOCTOPUS_CHAT_ENGINE?.trim();
  if (raw === undefined || raw === '' || raw === 'pi') return 'pi';
  if (raw === 'claude-code') return 'claude-code';
  throw new Error(`FUNKYOCTOPUS_CHAT_ENGINE must be "pi" or "claude-code", got "${raw}"`);
}

function parseClaudeIdleMs(): number {
  const raw = process.env.FUNKYOCTOPUS_CLAUDE_IDLE_MS?.trim();
  if (raw === undefined || raw === '') return 15 * 60_000;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error(`FUNKYOCTOPUS_CLAUDE_IDLE_MS must be a positive whole number of milliseconds, got "${raw}"`);
  }
  return ms;
}

/** The trimmed value of `key`, or undefined when it is unset or blank. */
function parseOptional(key: string): string | undefined {
  const raw = process.env[key]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

/** A positive whole number from `key`, or `fallback` when unset or blank; anything else stops the sidecar. */
function parseCount(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error(`${key} must be a positive whole number, got "${raw}"`);
  }
  return count;
}

/** Sidecar runtime configuration, all overridable from the environment. */
const host = process.env.SIDECAR_HOST ?? '127.0.0.1';
const port = Number(process.env.SIDECAR_PORT ?? DEFAULT_SIDECAR_PORT);
const serveUiDir = parseServeUiDir();

export const config = {
  host,
  port,
  version: '0.1.0',
  /** Which engine answers `chat.*`: pi (default) or Claude Code. */
  chatEngine: parseChatEngine(),
  /**
   * Provider + model pi routes to, when the environment sets them. Unset, pi's own
   * defaultProvider/defaultModel settings decide (`resolvePiModel`, pi/default-model.ts).
   */
  piProvider: parseOptional('FUNKYOCTOPUS_PROVIDER'),
  piModel: parseOptional('FUNKYOCTOPUS_MODEL'),
  /** Primary root for a global chat session until the browser selects a project. */
  primaryWorkspaceRoot: process.env.FUNKYOCTOPUS_WORKSPACE_ROOT ?? resolve(homedir(), 'Work'),
  /** Folders the selector's folder list scans one level deep, besides the global root. */
  projectRoots: parseProjectRoots(),
  /** Helmraiser CLI binary the sidecar runs for status and control. */
  helmraiserBin: process.env.HELMRAISER_BIN ?? 'helmraiser',
  /** Claude Code CLI the sidecar reads status from; resolved to an absolute path through PATH. */
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  /** How long a Claude Code chat sits idle before its process is closed (the next send resumes it). */
  claudeIdleMs: parseClaudeIdleMs(),
  /** Most chat slots (tabs) at once, `main` included (decision 13). */
  maxChats: parseCount('FUNKYOCTOPUS_MAX_CHATS', 8),
  /** Most `claude` processes running at once across Claude slots; reaped ones do not count. */
  maxClaudeRunning: parseCount('FUNKYOCTOPUS_MAX_CLAUDE_RUNNING', 4),
  /** Helmraiser's run store, containing `runs/<uuid>/plan.md`. */
  helmraiserDataDir: resolve(process.env.HELMRAISER_DATA_DIR ?? join(homedir(), '.helmraiser')),
  /** Desktop notifications (notify-send); on only with FUNKYOCTOPUS_DESKTOP_NOTIFY=1. */
  desktopNotifications: process.env.FUNKYOCTOPUS_DESKTOP_NOTIFY === '1',
  /** Automatic `pi update --all` upkeep; off with FUNKYOCTOPUS_UPKEEP_DISABLED=1. */
  upkeepDisabled: process.env.FUNKYOCTOPUS_UPKEEP_DISABLED === '1',
  /** How often the scheduled upkeep check runs while the sidecar stays alive. */
  upkeepIntervalMs: Number(process.env.FUNKYOCTOPUS_UPKEEP_INTERVAL_MS ?? 24 * 60 * 60 * 1000),
  /** Vault rules file; a test may point this at a temp file without changing the default. */
  vaultPath: process.env.FUNKYOCTOPUS_VAULT_PATH ?? DEFAULT_VAULT_PATH,
  /** Exact browser Origins allowed onto the WebSocket; no wildcards. */
  wsAllowedOrigins: parseWsAllowedOrigins(port, serveUiDir !== undefined),
  /** Built UI directory served over HTTP; unset when not serving. */
  serveUiDir,
} as const;
