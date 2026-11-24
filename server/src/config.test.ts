import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const OVERRIDE_KEY = 'FUNKYOCTOPUS_WS_ORIGINS';
const ROOTS_KEY = 'FUNKYOCTOPUS_PROJECT_ROOTS';

/**
 * `config.ts` snapshots its env at import, so an override is tested the same
 * way the Vault override is (session-dir.test.ts): stub the env, reset the
 * module registry, then import fresh.
 */
async function loadConfig(): Promise<typeof import('./config.ts')> {
  vi.resetModules();
  return import('./config.ts');
}

afterEach(() => {
  delete process.env[OVERRIDE_KEY];
  delete process.env[ROOTS_KEY];
  vi.unstubAllEnvs();
});

describe('FUNKYOCTOPUS_WS_ORIGINS', () => {
  it('defaults to the pinned Vite dev origins when the override is unset', async () => {
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toEqual([
      'http://localhost:14174',
      'http://127.0.0.1:14174',
    ]);
  });

  it('parses a comma-separated override, trimming whitespace around every origin', async () => {
    vi.stubEnv(OVERRIDE_KEY, ' http://dev.example:5173 , http://127.0.0.1:9999 ');
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toEqual([
      'http://dev.example:5173',
      'http://127.0.0.1:9999',
    ]);
  });

  it('falls back to the defaults for an empty override instead of opening access', async () => {
    vi.stubEnv(OVERRIDE_KEY, '');
    const { config } = await loadConfig();
    expect(config.wsAllowedOrigins).toEqual([
      'http://localhost:14174',
      'http://127.0.0.1:14174',
    ]);
  });

  it('treats a whitespace-only override as unset and drops empty comma segments', async () => {
    vi.stubEnv(OVERRIDE_KEY, '   ');
    const { config: blankConfig } = await loadConfig();
    expect(blankConfig.wsAllowedOrigins).toEqual([
      'http://localhost:14174',
      'http://127.0.0.1:14174',
    ]);

    vi.stubEnv(OVERRIDE_KEY, 'http://a:1, ,http://b:2,');
    const { config: partialConfig } = await loadConfig();
    expect(partialConfig.wsAllowedOrigins).toEqual(['http://a:1', 'http://b:2']);
  });
});

describe('workspace roots', () => {
  it('defaults the global root to ~/Work and the project roots to ~/projects', async () => {
    const { config } = await loadConfig();
    expect(config.primaryWorkspaceRoot).toBe(resolve(homedir(), 'Work'));
    expect(config.projectRoots).toEqual([join(homedir(), 'projects')]);
  });

  it('parses a comma-separated project-roots override, trimming and dropping empties', async () => {
    vi.stubEnv(ROOTS_KEY, ' /home/example/a , , /home/example/b ,');
    const { config } = await loadConfig();
    expect(config.projectRoots).toEqual(['/home/example/a', '/home/example/b']);
  });

  it('treats an explicitly empty project-roots value as no roots', async () => {
    vi.stubEnv(ROOTS_KEY, '   ');
    const { config } = await loadConfig();
    expect(config.projectRoots).toEqual([]);
  });
});

describe('CLAUDE_BIN', () => {
  it('defaults to the bare claude command, resolved later through PATH', async () => {
    vi.stubEnv('CLAUDE_BIN', '');
    delete process.env.CLAUDE_BIN;
    const { config } = await loadConfig();
    expect(config.claudeBin).toBe('claude');
  });

  it('takes the override verbatim', async () => {
    vi.stubEnv('CLAUDE_BIN', '/opt/claude/bin/claude');
    const { config } = await loadConfig();
    expect(config.claudeBin).toBe('/opt/claude/bin/claude');
  });
});

describe('FUNKYOCTOPUS_CLAUDE_IDLE_MS', () => {
  it('is 15 minutes unless set, whether unset or blank', async () => {
    delete process.env.FUNKYOCTOPUS_CLAUDE_IDLE_MS;
    expect((await loadConfig()).config.claudeIdleMs).toBe(900_000);

    vi.stubEnv('FUNKYOCTOPUS_CLAUDE_IDLE_MS', ' ');
    expect((await loadConfig()).config.claudeIdleMs).toBe(900_000);
  });

  it('takes a number of milliseconds', async () => {
    vi.stubEnv('FUNKYOCTOPUS_CLAUDE_IDLE_MS', '30000');
    expect((await loadConfig()).config.claudeIdleMs).toBe(30_000);
  });

  it.each(['0', '-5', '1.5', 'soon', '15m'])('refuses to start on %s, rather than guess a time', async (raw) => {
    vi.stubEnv('FUNKYOCTOPUS_CLAUDE_IDLE_MS', raw);
    await expect(loadConfig()).rejects.toThrow(
      `FUNKYOCTOPUS_CLAUDE_IDLE_MS must be a positive whole number of milliseconds, got "${raw}"`,
    );
  });
});

describe.each([
  ['FUNKYOCTOPUS_MAX_CHATS', 'maxChats', 8],
  ['FUNKYOCTOPUS_MAX_CLAUDE_RUNNING', 'maxClaudeRunning', 4],
] as const)('%s', (key, field, fallback) => {
  it(`is ${fallback} unless set, whether unset or blank`, async () => {
    delete process.env[key];
    expect((await loadConfig()).config[field]).toBe(fallback);
    vi.stubEnv(key, ' ');
    expect((await loadConfig()).config[field]).toBe(fallback);
  });

  it('takes a whole number', async () => {
    vi.stubEnv(key, '3');
    expect((await loadConfig()).config[field]).toBe(3);
  });

  it.each(['0', '-1', '2.5', 'many'])('refuses to start on %s', async (raw) => {
    vi.stubEnv(key, raw);
    await expect(loadConfig()).rejects.toThrow(`${key} must be a positive whole number, got "${raw}"`);
  });
});

describe('FUNKYOCTOPUS_CHAT_ENGINE', () => {
  it('is pi unless asked otherwise, whether unset or blank', async () => {
    delete process.env.FUNKYOCTOPUS_CHAT_ENGINE;
    expect((await loadConfig()).config.chatEngine).toBe('pi');

    vi.stubEnv('FUNKYOCTOPUS_CHAT_ENGINE', '  ');
    expect((await loadConfig()).config.chatEngine).toBe('pi');
  });

  it('takes pi or claude-code', async () => {
    vi.stubEnv('FUNKYOCTOPUS_CHAT_ENGINE', 'claude-code');
    expect((await loadConfig()).config.chatEngine).toBe('claude-code');

    vi.stubEnv('FUNKYOCTOPUS_CHAT_ENGINE', 'pi');
    expect((await loadConfig()).config.chatEngine).toBe('pi');
  });

  it('refuses to start on a name it does not know, rather than guess an engine', async () => {
    vi.stubEnv('FUNKYOCTOPUS_CHAT_ENGINE', 'claude');
    await expect(loadConfig()).rejects.toThrow(
      'FUNKYOCTOPUS_CHAT_ENGINE must be "pi" or "claude-code", got "claude"',
    );
  });
});

describe('FUNKYOCTOPUS_PROVIDER and FUNKYOCTOPUS_MODEL', () => {
  it('stay undefined when unset or blank, leaving the choice to pi settings', async () => {
    delete process.env.FUNKYOCTOPUS_PROVIDER;
    delete process.env.FUNKYOCTOPUS_MODEL;
    const unset = (await loadConfig()).config;
    expect(unset.piProvider).toBeUndefined();
    expect(unset.piModel).toBeUndefined();

    vi.stubEnv('FUNKYOCTOPUS_PROVIDER', ' ');
    vi.stubEnv('FUNKYOCTOPUS_MODEL', '');
    const blank = (await loadConfig()).config;
    expect(blank.piProvider).toBeUndefined();
    expect(blank.piModel).toBeUndefined();
  });

  it('take the override, trimmed', async () => {
    vi.stubEnv('FUNKYOCTOPUS_PROVIDER', ' example-provider ');
    vi.stubEnv('FUNKYOCTOPUS_MODEL', 'example-model');
    const { config } = await loadConfig();
    expect(config.piProvider).toBe('example-provider');
    expect(config.piModel).toBe('example-model');
  });
});
