import { describe, expect, it, vi } from 'vitest';
import { claudeSdkDriftOf, detectClaudeSdkDrift, parseClaudeCliVersion, productionClaudeSdkDriftDeps, sdkVersionForCli, type ClaudeSdkDriftDeps } from './claude-sdk-drift.ts';
import type { CommandOutcome } from './run-command.ts';

function harness() {
  const result: CommandOutcome = { kind: 'exit', code: 0, signal: null,
    facts: { stdout: '2.1.302 (Claude Code)\n', stderr: '', log: '', droppedBytes: 0 } };
  const deps: ClaudeSdkDriftDeps = {
    env: { CLAUDE_BIN: '/custom/claude', PATH: '/custom/bin', ANTHROPIC_API_KEY: 'sk-owner', CLAUDECODE: '1' },
    version: 'test', resolveBin: vi.fn().mockResolvedValue('/resolved/claude'),
    run: vi.fn().mockResolvedValue(result), readFile: vi.fn().mockResolvedValue('{"version":"0.3.302"}'),
  };
  return { deps, result };
}

describe('Claude SDK drift', () => {
  it.each(['2.1.302', ' 2.1.302 (Claude Code)\n'])('accepts version output %s', (output) => {
    expect(parseClaudeCliVersion(output)).toBe('2.1.302');
  });
  it.each(['2.1', 'v2.1.302', '2.1.0302', '2.1.302-beta', '2.1.302+build', 'hello 2.1.302', '2.1.302 junk'])('rejects %s', (output) => {
    expect(parseClaudeCliVersion(output)).toBeNull();
  });
  it.each([
    ['2.1.302', '0.3.302', 'in-sync'], ['2.1.305', '0.3.302', 'drift'],
    ['2.1.9', '0.3.10', 'drift'], ['2.1.10', '0.3.9', 'drift'],
    ['2.2.302', '0.3.302', 'unknown'], ['2.1.302', '0.4.302', 'unknown'],
    ['bad', '0.3.302', 'unknown'], [null, '0.3.302', 'unknown'],
  ] as const)('compares %s / %s', (cliVersion, sdkVersion, status) => {
    expect(claudeSdkDriftOf(cliVersion, sdkVersion)).toEqual({ status, cliVersion, sdkVersion });
  });
  it('maps only the documented family', () => {
    expect(sdkVersionForCli('2.1.302')).toBe('0.3.302');
    expect(sdkVersionForCli('2.2.302')).toBeNull();
    expect(sdkVersionForCli('2.1.302-beta')).toBeNull();
  });
  it('uses the resolved binary, sanitized env and bounded version-only command', async () => {
    const { deps } = harness();
    expect(await detectClaudeSdkDrift(deps)).toEqual({ status: 'in-sync', cliVersion: '2.1.302', sdkVersion: '0.3.302' });
    expect(deps.resolveBin).toHaveBeenCalledWith('/custom/claude', '/custom/bin');
    expect(deps.run).toHaveBeenCalledWith({ command: '/resolved/claude', args: ['--version'], timeoutMs: 10_000,
      maxOutputBytes: 4096, env: { CLAUDE_BIN: '/custom/claude', PATH: '/custom/bin', ANTHROPIC_API_KEY: 'sk-owner', CLAUDE_AGENT_SDK_CLIENT_APP: 'funkyoctopus/test' } });
    expect(String(vi.mocked(deps.readFile).mock.calls[0]?.[0])).toContain('/node_modules/@anthropic-ai/claude-agent-sdk/package.json');
    expect(deps.env.CLAUDECODE).toBe('1');
  });
  it.each(['missing', 'resolve-reject', 'run-reject', 'nonzero', 'null-exit', 'timeout', 'error', 'truncated', 'malformed'])('retains SDK on CLI failure: %s', async (failure) => {
    const { deps, result } = harness();
    if (failure === 'missing') vi.mocked(deps.resolveBin).mockResolvedValue(null);
    if (failure === 'resolve-reject') vi.mocked(deps.resolveBin).mockRejectedValue(new Error('missing'));
    if (failure === 'run-reject') vi.mocked(deps.run).mockRejectedValue(new Error('failed'));
    if (result.kind === 'exit') {
      if (failure === 'nonzero') result.code = 1;
      if (failure === 'null-exit') result.code = null;
      if (failure === 'truncated') result.facts.droppedBytes = 1;
      if (failure === 'malformed') result.facts.stdout = 'unreadable';
      if (failure === 'timeout') vi.mocked(deps.run).mockResolvedValue({ kind: 'terminated', reason: 'timeout', facts: result.facts });
      if (failure === 'error') vi.mocked(deps.run).mockResolvedValue({ kind: 'error', message: 'nope', code: 'ENOENT', facts: result.facts });
    }
    expect(await detectClaudeSdkDrift(deps)).toEqual({ status: 'unknown', cliVersion: null, sdkVersion: '0.3.302' });
  });
  it.each(['missing', 'null', '{}', '[]', 'broken', '{"version":1}', '{"version":"0.3.302-beta"}'])('retains CLI on SDK failure: %s', async (text) => {
    const { deps } = harness();
    if (text === 'missing') vi.mocked(deps.readFile).mockRejectedValue(new Error('missing'));
    else vi.mocked(deps.readFile).mockResolvedValue(text);
    expect(await detectClaudeSdkDrift(deps)).toEqual({ status: 'unknown', cliVersion: '2.1.302', sdkVersion: null });
  });
  it('defaults to claude and empty PATH, and constructs production deps without I/O', async () => {
    const { deps } = harness();
    deps.env = {};
    await detectClaudeSdkDrift(deps);
    expect(deps.resolveBin).toHaveBeenCalledWith('claude', '');
    expect(productionClaudeSdkDriftDeps({}, 'test').run).toBeTypeOf('function');
  });
});
