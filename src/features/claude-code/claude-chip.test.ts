import { describe, expect, it } from 'vitest';
import type { ClaudeAuthInfo, ClaudeStatusResult } from '@shared/transport/protocol.ts';
import { claudeChip, folderName, formatAgo, formatReset, signInMethod } from './claude-chip.ts';

const NOW = Date.UTC(2026, 9, 17, 17, 0, 0);
const MIN = 60_000;

describe('formatReset', () => {
  it('counts down in minutes inside the hour, never saying 0m', () => {
    expect(formatReset(NOW + 45 * MIN, NOW)).toBe('in 45m');
    expect(formatReset(NOW + 20_000, NOW)).toBe('in 1m');
  });

  it('counts down in hours and minutes inside the day', () => {
    expect(formatReset(NOW + 90 * MIN, NOW)).toBe('in 1h 30m');
    expect(formatReset(NOW + 5 * 60 * MIN, NOW)).toBe('in 5h 0m');
  });

  it('names a moment beyond a day by clock time instead of a long countdown', () => {
    const text = formatReset(NOW + 4 * 24 * 60 * MIN, NOW);
    expect(text).not.toMatch(/^in /);
    expect(text).toMatch(/\d{1,2}:\d{2}/);
  });

  it('says now for a window that has already reset', () => {
    expect(formatReset(NOW - 1, NOW)).toBe('now');
  });
});

describe('formatAgo', () => {
  it.each([
    [10_000, 'just now'],
    [2 * MIN, '2m ago'],
    [59 * MIN, '59m ago'],
    [3 * 60 * MIN, '3h ago'],
    [2 * 24 * 60 * MIN, '2d ago'],
  ])('%i ms ago reads %s', (ago, text) => {
    expect(formatAgo(NOW - ago, NOW)).toBe(text);
  });

  it('treats a timestamp slightly in the future as just now', () => {
    expect(formatAgo(NOW + 5_000, NOW)).toBe('just now');
  });
});

describe('folderName', () => {
  it('takes the last path segment, tolerating a trailing slash and the root', () => {
    expect(folderName('/home/example/projects/alpha')).toBe('alpha');
    expect(folderName('/home/example/projects/alpha/')).toBe('alpha');
    expect(folderName('/')).toBe('/');
  });
});

describe('signInMethod', () => {
  it.each<[ClaudeAuthInfo, string]>([
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }, 'subscription (Max)'],
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }, 'subscription'],
    [{ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, 'API key'],
    [{ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }, 'auth token'],
    [{ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }, 'Amazon Bedrock'],
    [{ loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' }, 'Google Vertex AI'],
    [{ loggedIn: true, authMethod: 'third_party', apiProvider: 'foundry' }, 'Microsoft Foundry'],
    [{ loggedIn: true, authMethod: 'third_party', apiProvider: 'gateway' }, 'gateway'],
    [{ loggedIn: true, authMethod: 'something_new', apiProvider: 'firstParty' }, 'something_new'],
  ])('names %o as %s', (auth, name) => {
    expect(signInMethod(auth)).toBe(name);
  });

  it('names nothing when logged out', () => {
    expect(signInMethod({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })).toBeNull();
  });
});

describe('claudeChip', () => {
  const signedIn = (auth: ClaudeAuthInfo): ClaudeStatusResult => ({ cli: 'ok', auth, live: [] });

  it('names a metered sign-in on the chip itself, with no quota and no alarm', () => {
    expect(claudeChip(signedIn({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }))).toEqual({
      label: 'Claude · API key',
      tooltip: 'Claude via API key: billed per use, no subscription quota',
      tone: 'normal',
      interactive: true,
    });
    expect(claudeChip(signedIn({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' })).label).toBe(
      'Claude · Amazon Bedrock',
    );
  });

  it('keeps the plan and its quota for a subscription', () => {
    const chip = claudeChip({
      ...signedIn({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' }),
      usage: { fetchedAt: 0, limits: [{ kind: 'session', label: '5h', percent: 12, resetsAt: null, active: true }] },
    });
    expect(chip.label).toBe('Claude Pro · 5h 12%');
    expect(chip.tooltip).toBe('Claude on your subscription (Pro): quota and sessions');
  });

  it('never calls a subscription whose plan went unreported billed per use', () => {
    const chip = claudeChip(signedIn({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
    expect(chip.label).toBe('Claude');
    expect(chip.tooltip).toBe('Claude subscription quota and sessions');
  });
});
