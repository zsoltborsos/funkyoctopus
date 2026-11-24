import { beforeAll, describe, expect, it } from 'vitest';
import type { HelmraiserLogEvent } from '@shared/transport/protocol.ts';
import { clockTime, failedCheckTail, summarize } from './run-log.ts';
import { makeFailedRunLog } from './__fixtures__/helmraiser-log.ts';

// Deterministic local-time assertions (the timeline renders HH:MM:SS local).
beforeAll(() => { process.env.TZ = 'UTC'; });

const event = (type: string, payload: Record<string, unknown>): HelmraiserLogEvent =>
  ({ id: 1, ts: 0, source: 'helmraiser', stage: null, type, payload });

describe('clockTime', () => {
  it('renders epoch seconds as local HH:MM:SS', () => {
    expect(clockTime(1792427756.2993538)).toBe('16:35:56');
    expect(clockTime(1792428388.8909302)).toBe('16:46:28');
    expect(clockTime(0)).toBe('00:00:00');
  });
});

describe('summarize', () => {
  it.each([
    ['run_start', { task_id: '-mnt-x:app-sign-in', pi_version: '1.3.0' }, 'task -mnt-x:app-sign-in · pi 1.3.0'],
    ['routing', { lever: 'implement', from: 'a/b:high', to: 'a/b:high', reason: 'overflow_not_needed' }, 'implement: overflow_not_needed'],
    ['preflight', { pi_version: '1.3.0', auth: 'ready' }, 'pi 1.3.0 · auth ready'],
    ['base_sync', { status: 'skipped', reason: 'up_to_date', base_branch: 'main' }, 'skipped (up_to_date)'],
    ['base_sync', { status: 'rebased' }, 'rebased'],
    ['worktree_created', { path: '/w/x', branch: 'feature/x/142d660e', base: 'abc' }, 'feature/x/142d660e'],
    ['setup_start', { run: 'set -e\nnpm ci', timeout: 600, sandbox: 'srt' }, 'setup script, timeout 600 s'],
    ['setup_result', { ok: true, exit_code: 0, seconds: 12.046, tail: '' }, 'ok · exit 0 · 12 s'],
    ['setup_result', { ok: false, exit_code: 1, seconds: 3.456, tail: '' }, 'failed · exit 1 · 3.5 s'],
    ['stage_start', { stage: 'plan' }, 'plan'],
    ['iteration_start', { n: 2, attempt: 1, model: 'openai-codex/gpt-6.1-sol:high', prompt: '…' }, 'iteration 2, attempt 1 · openai-codex/gpt-6.1-sol:high'],
    ['plan_written', { path: '/h/.helmraiser/runs/r/plan.md', chars: 14614 }, '/h/.helmraiser/runs/r/plan.md (14614 chars)'],
    ['service_start', { name: 'postgres', image: 'postgres@sha256:1', port: 5432 }, 'postgres'],
    ['service_ready', { name: 'postgres', seconds: 9.647 }, 'postgres ready in 9.6 s'],
    ['service_failed', { name: 'postgres', reason: 'health check timed out' }, 'postgres: health check timed out'],
    ['service_stop', { removed: ['a', 'b', 'c'], error: null }, 'removed 3 containers'],
    ['service_stop', { removed: ['a'], error: null }, 'removed 1 container'],
    ['blocked_to_verify', { n: 1, reason: 'cannot keep the file unchanged' }, 'cannot keep the file unchanged'],
    // The failure reason is long and shown in full under the row, so the row says only the status.
    ['run_end', { status: 'failed', failure_reason: 'blocked: diff-check fails', active_minutes: 10.5 }, 'failed'],
    ['run_end', { status: 'landed' }, 'landed'],
    ['tool_execution_start', { toolName: 'read', args: { path: 'docs/a.md', offset: null, limit: null } }, 'read {"path":"docs/a.md"}'],
    ['tool_execution_end', { toolName: 'bash', isError: false }, 'bash ok'],
    ['tool_execution_end', { toolName: 'bash', isError: true }, 'bash error'],
    ['message_end', { message: { role: 'user', content: [{ type: 'text', text: '## Allowed paths\n\n- `a/**`' }] } }, 'user: ## Allowed paths - `a/**`'],
    ['message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'BLOCKED: the file\nfails.' }] } }, 'assistant: BLOCKED: the file fails.'],
    ['message_end', { message: { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: '# Policy\n\nAgreed.' }] } }, 'toolResult read: # Policy Agreed.'],
    ['message_end', { message: { role: 'system', content: '', sections: {} } }, 'system prompt'],
  ])('%s → %s', (type, payload, expected) => {
    expect(summarize(event(type, payload))).toBe(expected);
  });

  it('counts the tool calls of an assistant message with no text, and names a thinking-only one', () => {
    const calls = { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'toolCall', name: 'read' }, { type: 'toolCall', name: 'ls' }] } };
    expect(summarize(event('message_end', calls))).toBe('assistant: 2 tool calls');
    expect(summarize(event('message_end', { message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] } }))).toBe('assistant: 1 tool call');
    expect(summarize(event('message_end', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }))).toBe('assistant: thinking');
  });

  it('names the failing checks of a verify_result, or the number that passed', () => {
    const results = (...checks: Array<[string, boolean]>) => ({ passed: checks.every(([, ok]) => ok), results: checks.map(([name, passed]) => ({ name, passed })) });
    expect(summarize(event('verify_result', results(['lint', true], ['diff-check', false], ['tests', false])))).toBe('failed: diff-check, tests');
    expect(summarize(event('verify_result', results(['lint', true], ['tests', true])))).toBe('passed: 2 checks');
    expect(summarize(event('verify_result', { passed: false }))).toBe('failed');
  });

  it('says nothing for the pi lifecycle markers, which the type column already names', () => {
    for (const type of ['session', 'agent_start', 'agent_end', 'agent_settled', 'turn_start']) {
      expect(summarize(event(type, { type, willRetry: false }))).toBe('');
    }
  });

  it('shows an unknown type as a short JSON excerpt, and nothing for an empty payload', () => {
    expect(summarize(event('future_thing', { a: 1, b: 'x' }))).toBe('{"a":1,"b":"x"}');
    expect(summarize(event('future_thing', {}))).toBe('');
    const long = summarize(event('future_thing', { blob: 'y'.repeat(5_000) }));
    expect(long).toHaveLength(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps a long known summary to one short line too', () => {
    const text = summarize(event('blocked_to_verify', { reason: `${'word '.repeat(100)}` }));
    expect(text).toHaveLength(160);
    expect(text.endsWith('…')).toBe(true);
  });

  it('summarizes every event of the real fixture without a blob', () => {
    for (const e of makeFailedRunLog()) expect(summarize(e).length).toBeLessThanOrEqual(160);
  });
});

describe('failedCheckTail', () => {
  it('strips terminal colours and keeps the last six lines, saying how many were left out', () => {
    const tail = ['one', 'two', '\u001b[31mFAIL\u001b[39m src/a.test.ts', 'four', 'five', 'six', 'seven', 'eight', '', ''].join('\n');
    expect(failedCheckTail(tail)).toBe('… 2 earlier lines\nFAIL src/a.test.ts\nfour\nfive\nsix\nseven\neight');
  });

  it('returns a short tail whole and an empty one as empty', () => {
    expect(failedCheckTail('a.txt:21: trailing whitespace.\n+fonts')).toBe('a.txt:21: trailing whitespace.\n+fonts');
    expect(failedCheckTail('')).toBe('');
    expect(failedCheckTail('\n\n')).toBe('');
  });
});
