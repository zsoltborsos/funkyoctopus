import { describe, expect, it } from 'vitest';
import { claudeChildEnv } from './env.ts';

/** The markers a parent Claude Code session exports; a child that inherits them believes it is nested. */
const STRIPPED = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
];

/**
 * How the owner tells Claude Code to sign in: their own API key or token, a
 * gateway, or a cloud provider (CURRENT_STATE decision 12, limit 1). The child
 * gets them as set; which one wins is the CLI's business.
 */
const AUTH = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_PROFILE',
  'AWS_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'ANTHROPIC_FOUNDRY_RESOURCE',
];

describe('claudeChildEnv', () => {
  it.each(STRIPPED)('drops %s so the child does not inherit a parent session', (name) => {
    const env = claudeChildEnv({ PATH: '/usr/bin', [name]: 'leak' }, '0.1.0');
    expect(env).not.toHaveProperty(name);
  });

  it.each(AUTH)('passes %s through, so every sign-in the CLI supports works', (name) => {
    const env = claudeChildEnv({ PATH: '/usr/bin', [name]: 'set-by-owner' }, '0.1.0');
    expect(env[name]).toBe('set-by-owner');
  });

  it('keeps everything else, including Claude configuration the owner chose', () => {
    const env = claudeChildEnv({ PATH: '/usr/bin', HOME: '/home/example', CLAUDE_CONFIG_DIR: '/cfg' }, '0.1.0');
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/example', CLAUDE_CONFIG_DIR: '/cfg' });
  });

  it('identifies FunkyOctopus to Claude Code, replacing any inherited client app', () => {
    const env = claudeChildEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'other/9' }, '0.1.0');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('funkyoctopus/0.1.0');
  });

  it('omits unset variables and leaves its input untouched', () => {
    const input: NodeJS.ProcessEnv = { PATH: '/usr/bin', UNSET: undefined, CLAUDECODE: '1' };
    const env = claudeChildEnv(input, '0.1.0');
    expect(env).not.toHaveProperty('UNSET');
    expect(input).toEqual({ PATH: '/usr/bin', UNSET: undefined, CLAUDECODE: '1' });
  });
});
