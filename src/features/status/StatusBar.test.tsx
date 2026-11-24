import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { ShellProvider } from '@core/shell/ShellProvider.tsx';
import { TRANSPORT } from '@core/transport/transport-client.ts';
import { HELMRAISER_MONITOR, type HelmraiserMonitorSnapshot } from '@features/jobs/helmraiser-monitor.service.ts';
import type { ClaudeSdkUpkeepInfo, EmbeddedUpkeepInfo, HealthResult, UpkeepResult } from '@shared/transport/protocol.ts';
import { makeHelmraiserStatus } from '@features/jobs/__fixtures__/helmraiser-status.ts';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { CLAUDE_CODE } from '@features/claude-code/claude-code.client.ts';
import type { ClaudeStatusResult } from '@shared/transport/protocol.ts';
import { SYSTEM } from './system.client.ts';
import { StatusBar } from './StatusBar.tsx';

function renderBar(active: boolean, upkeep?: UpkeepResult, health?: HealthResult, claudeStatus?: ClaudeStatusResult) {
  const status = makeHelmraiserStatus();
  if (!active) status.running = [];
  const snapshot: HelmraiserMonitorSnapshot = { status, loading: false, error: null, unavailable: false };
  const monitor = { getSnapshot: () => snapshot, subscribe: () => () => undefined, refresh: vi.fn() };
  const transport = { getState: () => 'open', subscribe: () => () => undefined };
  const system = {
    health: vi.fn(() => health ? Promise.resolve(health) : new Promise<never>(() => undefined)),
    upkeep: vi.fn(() => Promise.resolve(upkeep ?? null)),
  };
  const container = new Container();
  container.registerInstance(HELMRAISER_MONITOR, monitor as never);
  container.registerInstance(TRANSPORT, transport as never);
  container.registerInstance(SYSTEM, system as never);
  // Like health, Claude Code stays unanswered unless a test gives it a status.
  const claude = {
    status: vi.fn(() => claudeStatus ? Promise.resolve(claudeStatus) : new Promise<never>(() => undefined)),
    sessions: vi.fn(() => Promise.resolve([])),
  };
  container.registerInstance(CLAUDE_CODE, claude as never);
  container.registerInstance(PREFERENCES, new PreferencesService(new MemoryStorageAdapter()));
  render(<ContainerProvider container={container}><ShellProvider><StatusBar /></ShellProvider></ContainerProvider>);
  return { system, claude };
}

const embeddedInfo = (overrides: Partial<EmbeddedUpkeepInfo> = {}): EmbeddedUpkeepInfo => ({
  installedVersion: '0.84.1',
  latestVersion: '0.84.1',
  verifiedVersion: '0.84.1',
  verificationLevel: 'live',
  status: 'current',
  lastCheckAt: 1,
  lastPromotionAttemptAt: null,
  lastPromotionResult: null,
  lastRecoveryAttemptAt: null,
  lastRecoveryResult: null,
  ...overrides,
});

const behind: UpkeepResult = {
  disabled: false,
  status: 'updated',
  lastRunAt: 1,
  lastResult: 'up to date',
  globalPiVersion: '0.84.1',
  embeddedSdkVersion: '0.81.1',
  drift: 'behind',
  embedded: embeddedInfo({ installedVersion: '0.81.1', verifiedVersion: '0.81.1', status: 'current' }),
};

describe('StatusBar Helmraiser strip', () => {
  it('shows the first running run as a truncating cockpit link into the jobs view', async () => {
    const user = userEvent.setup(); renderBar(true);
    const link = screen.getByRole('button', { name: 'Planned runs: a strong model plans, the cheap implementer follows the plan · implement · iteration 1' });
    expect(link).toHaveClass('truncate');
    expect(link.title).toBe('Planned runs: a strong model plans, the cheap implementer follows the plan · implement · iteration 1');
    await user.click(link);
  });
  it('keeps the strip on one line: items never wrap, the run label truncates instead (T2.3, 1280 px)', () => {
    renderBar(true);
    expect(screen.getByRole('contentinfo')).toHaveClass('whitespace-nowrap');
    expect(screen.getByRole('button', { name: /Planned runs/ })).toHaveClass('min-w-0', 'truncate');
  });
  it('hides when nothing is running', () => { renderBar(false); expect(screen.queryByText(/implement/)).not.toBeInTheDocument(); });
});

describe('StatusBar upkeep strip', () => {
  it('shows a chip only for failure or drift, never for a healthy equal state', async () => {
    const { system } = renderBar(false, { ...behind, status: 'failed', lastResult: 'boom', globalPiVersion: null, drift: 'unknown' });
    const chip = await screen.findByTitle(/upkeep failed/);
    expect(chip).toHaveTextContent('upkeep failed');
    expect(chip.title).toContain('boom');
    void system;
  });

  it('labels missing binaries and timeouts distinctly', async () => {
    renderBar(false, { ...behind, status: 'missing_binary', lastResult: 'pi: command not found', globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown' });
    expect(await screen.findByText('pi not found')).toBeInTheDocument();
    renderBar(false, { ...behind, status: 'timed_out', lastResult: 'timed out after 300000ms', globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown' });
    expect(await screen.findByText('upkeep timed out')).toBeInTheDocument();
  });

  it('shows ahead and behind drift chips', async () => {
    renderBar(false, behind);
    expect(await screen.findByText('pi SDK behind')).toBeInTheDocument();
    renderBar(false, { ...behind, globalPiVersion: '0.81.1', embeddedSdkVersion: '0.84.1', drift: 'ahead' });
    expect(await screen.findByText('pi SDK ahead')).toBeInTheDocument();
  });

  it('hides the chip when versions are equal', async () => {
    const { system } = renderBar(false, { ...behind, embeddedSdkVersion: '0.84.1', drift: 'equal' });
    await waitFor(() => expect(system.upkeep).toHaveBeenCalled());
    expect(screen.queryByText(/pi SDK/)).not.toBeInTheDocument();
  });

  it('hides the chip when upkeep is disabled', async () => {
    const { system } = renderBar(false, {
      disabled: true, status: 'idle', lastRunAt: null, lastResult: null,
      globalPiVersion: null, embeddedSdkVersion: null, drift: 'unknown',
      embedded: embeddedInfo({ status: 'unknown' }),
    });
    await waitFor(() => expect(system.upkeep).toHaveBeenCalled());
    expect(screen.queryByText(/upkeep|pi SDK/)).not.toBeInTheDocument();
  });

  it('notes quietly when pi update has been waiting on crew work for over a day, and says why', async () => {
    const reason = 'deferred: 1 crew subagent is running, and pi update could replace some-ext under it';
    renderBar(false, { ...behind, drift: 'equal', status: 'deferred', lastResult: reason, deferredSince: Date.now() - 25 * 3_600_000 });
    const note = await screen.findByText('pi update waiting');
    expect(note).toHaveClass('text-muted');
    expect(note.title).toContain(reason);
  });

  it('says nothing about a deferral under a day old', async () => {
    const { system } = renderBar(false, { ...behind, drift: 'equal', status: 'deferred', lastResult: 'deferred: x', deferredSince: Date.now() - 3_600_000 });
    await waitFor(() => expect(system.upkeep).toHaveBeenCalled());
    expect(screen.queryByText(/pi update waiting|upkeep/)).not.toBeInTheDocument();
  });

  it('tooltip distinguishes the global CLI from the embedded SDK and explains deliberate dependency updates, never npm install', async () => {
    renderBar(false, behind);
    const chip = await screen.findByTitle(/global pi CLI 0\.84\.1/);
    expect(chip.title).toContain('embedded pi SDK 0.81.1');
    expect(chip.title).toContain('behind');
    expect(chip.title).toContain('deliberate');
    expect(chip.title).not.toContain('npm install');
  });
});

describe('StatusBar embedded upkeep strip', () => {
  it('shows an update-available chip with the exact promotion command and stop-sidecar instruction', async () => {
    renderBar(false, {
      ...behind,
      embedded: embeddedInfo({ status: 'available', latestVersion: '0.85.0' }),
    });
    const chip = await screen.findByText('SDK update available');
    expect(chip.title).toContain('npm run promote:pi');
    expect(chip.title).toContain('stop the sidecar first');
  });

  it('names installed, latest, and verified versions in the tooltip', async () => {
    renderBar(false, {
      ...behind,
      embedded: embeddedInfo({ status: 'available', latestVersion: '0.85.0', verificationLevel: 'deterministic_only' }),
    });
    const chip = await screen.findByText('SDK update available');
    expect(chip.title).toContain('installed 0.84.1');
    expect(chip.title).toContain('latest 0.85.0');
    expect(chip.title).toContain('verified 0.84.1');
    expect(chip.title).toContain('deterministic_only');
  });

  it('shows promotion_failed, needs_attention, recovery_required, and cleanup_pending states', async () => {
    renderBar(false, { ...behind, embedded: embeddedInfo({ status: 'promotion_failed', lastPromotionResult: 'gate failed', latestVersion: '0.85.0' }) });
    const failed = await screen.findByText('SDK promotion failed');
    expect(failed.title).toContain('gate failed');
    renderBar(false, { ...behind, embedded: embeddedInfo({ status: 'needs_attention' }) });
    expect(await screen.findByText('SDK needs attention')).toBeInTheDocument();
    renderBar(false, { ...behind, embedded: embeddedInfo({ status: 'recovery_required' }) });
    const recovery = await screen.findByText('SDK recovery required');
    expect(recovery.title).toContain('npm run upkeep:embedded -- --recover');
    renderBar(false, { ...behind, embedded: embeddedInfo({ status: 'cleanup_pending' }) });
    expect(await screen.findByText('SDK cleanup pending')).toBeInTheDocument();
  });

  it('shows a deterministic-only verification chip even while current, and never calls it live-verified', async () => {
    renderBar(false, {
      ...behind,
      embedded: embeddedInfo({ status: 'current', verificationLevel: 'deterministic_only' }),
    });
    const chip = await screen.findByText('SDK verified deterministically');
    expect(chip.title).toContain('deterministic_only');
    expect(chip.title).not.toContain('live');
  });

  it('stays quiet for healthy current, unknown, checking, and disabled states', async () => {
    // A drift-equal base: no global chip, so any /SDK/ text is an embedded chip.
    const healthy: UpkeepResult = { ...behind, drift: 'equal', embeddedSdkVersion: '0.84.1' };
    const { system } = renderBar(false, { ...healthy, embedded: embeddedInfo({ status: 'current' }) });
    await waitFor(() => expect(system.upkeep).toHaveBeenCalled());
    expect(screen.queryByText(/SDK/)).not.toBeInTheDocument();
    renderBar(false, { ...healthy, embedded: embeddedInfo({ status: 'unknown', latestVersion: null }) });
    await waitFor(() => expect(screen.queryByText(/SDK/)).not.toBeInTheDocument());
    renderBar(false, { ...healthy, embedded: embeddedInfo({ status: 'checking' }) });
    await waitFor(() => expect(screen.queryByText(/SDK/)).not.toBeInTheDocument());
    renderBar(false, { ...healthy, disabled: true, embedded: embeddedInfo({ status: 'unknown' }) });
    await waitFor(() => expect(screen.queryByText(/SDK/)).not.toBeInTheDocument());
  });

  it('coexists with the global failure chip when both have something to say', async () => {
    renderBar(false, {
      ...behind,
      status: 'failed',
      lastResult: 'boom',
      drift: 'unknown',
      embedded: embeddedInfo({ status: 'available', latestVersion: '0.85.0' }),
    });
    expect(await screen.findByText('upkeep failed')).toBeInTheDocument();
    expect(await screen.findByText('SDK update available')).toBeInTheDocument();
  });
});

describe('StatusBar Claude SDK drift', () => {
  const quiet: UpkeepResult = { ...behind, drift: 'equal', embedded: embeddedInfo() };
  it.each([
    ['2.1.305', '0.3.302', 'behind'], ['2.1.10', '0.3.9', 'behind'], ['2.1.9', '0.3.10', 'ahead'],
  ])('shows numeric pairing direction for %s / %s', async (cliVersion, sdkVersion, direction) => {
    renderBar(false, { ...quiet, claudeSdk: { status: 'drift', cliVersion, sdkVersion } });
    const chip = await screen.findByText(`Claude SDK ${direction} CLI`);
    expect(chip).toHaveClass('text-attention');
    expect(chip.title).toContain(`Claude Code CLI ${cliVersion}`);
    expect(chip.title).toContain(`Claude Agent SDK ${sdkVersion}`);
    expect(chip.title).toContain('stop the sidecar first, then run: npm run promote:claude-sdk');
    expect(screen.queryAllByText(/Claude SDK/)).toHaveLength(1);
  });
  it.each([
    undefined,
    { status: 'in-sync', cliVersion: '2.1.302', sdkVersion: '0.3.302' },
    { status: 'unknown', cliVersion: null, sdkVersion: '0.3.302' },
    { status: 'unknown', cliVersion: '2.1.302', sdkVersion: null },
    { status: 'drift', cliVersion: 'bad', sdkVersion: '0.3.302' },
    { status: 'drift', cliVersion: '2.2.302', sdkVersion: '0.3.305' },
    { status: 'drift', cliVersion: '2.1.302', sdkVersion: '0.4.305' },
    { status: 'drift', cliVersion: '2.1.302', sdkVersion: '0.3.302' },
    { status: 'drift', cliVersion: '2.1.302', sdkVersion: '0.3.0305' },
  ] satisfies (ClaudeSdkUpkeepInfo | undefined)[])('stays quiet for absent, unknown, in-sync or inconsistent data: %j', async (claudeSdk) => {
    const { system } = renderBar(false, { ...quiet, ...(claudeSdk ? { claudeSdk } : {}) });
    await act(async () => { await Promise.resolve(); });
    expect(system.upkeep).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Claude SDK/)).not.toBeInTheDocument();
    expect(screen.getByRole('contentinfo').querySelector('.text-attention')).toBeNull();
  });
  it('coexists with pi attention and Claude quota', async () => {
    renderBar(false, { ...quiet, embedded: embeddedInfo({ status: 'available' }),
      claudeSdk: { status: 'drift', cliVersion: '2.1.305', sdkVersion: '0.3.302' } }, undefined,
    { cli: 'ok', auth: { loggedIn: true, subscriptionType: 'max' },
      usage: { fetchedAt: 1, limits: [{ kind: 'session', label: '5h', percent: 72, resetsAt: null, active: true }] }, live: [] });
    expect(await screen.findByText('Claude SDK behind CLI')).toBeInTheDocument();
    expect(await screen.findByText('SDK update available')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Claude Max/ })).toBeInTheDocument();
  });
  it('changes and removes the chip on the existing five-second upkeep poll', async () => {
    vi.useFakeTimers();
    try {
      const { system } = renderBar(false, { ...quiet, claudeSdk: { status: 'drift', cliVersion: '2.1.305', sdkVersion: '0.3.302' } });
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('Claude SDK behind CLI')).toBeInTheDocument();
      system.upkeep.mockResolvedValue({ ...quiet, claudeSdk: { status: 'drift', cliVersion: '2.1.9', sdkVersion: '0.3.10' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByText('Claude SDK ahead CLI')).toBeInTheDocument();
      system.upkeep.mockResolvedValue({ ...quiet, claudeSdk: { status: 'in-sync', cliVersion: '2.1.10', sdkVersion: '0.3.10' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.queryByText(/Claude SDK/)).not.toBeInTheDocument();
      expect(system.upkeep).toHaveBeenCalledTimes(3);
      expect(system.health).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe('StatusBar backend chips', () => {
  const health = (backends: HealthResult['backends']): HealthResult => ({
    ok: true, service: 'funkyoctopus-sidecar', version: '0.1.0', uptimeMs: 1000, backends,
  });

  it('shows a tool whose CLI is missing as dim "not installed" with the install line in the tooltip, not as down', async () => {
    renderBar(false, undefined, health({ pi: 'up', helmraiser: 'not_installed', leeboard: 'not_installed' }));
    const chips = await screen.findAllByText('not installed');
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(chip.className).toContain('text-muted');
      expect(chip.className).not.toContain('text-attention');
      expect(chip.className).not.toContain('text-danger');
    }
    expect(chips.map((chip) => chip.parentElement?.getAttribute('title'))).toEqual([
      'Helmraiser is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net',
      'Leeboard is not installed — FunkyOctopus works without it. Install: https://zsoltborsos.net',
    ]);
    expect(screen.queryByText('down')).not.toBeInTheDocument();
    expect(screen.getAllByText('up', { selector: '.text-ok' })).toHaveLength(1);
  });

  it('keeps a Helmraiser that is installed but failing danger: a fault, not a missing tool', async () => {
    renderBar(false, undefined, health({ pi: 'up', helmraiser: 'down' }));
    const chip = await screen.findByText('down');
    expect(chip.className).toContain('text-danger');
    expect(chip.parentElement?.getAttribute('title')).toBeNull();
  });

  it('keeps a down backend with no start command danger', async () => {
    renderBar(false, undefined, health({ pi: 'down', helmraiser: 'unknown' }));
    const chip = await screen.findByText('down');
    expect(chip.className).toContain('text-danger');
    expect(chip.parentElement?.getAttribute('title')).toBeNull();
  });
});

describe('StatusBar Claude Code chip', () => {
  const status: ClaudeStatusResult = {
    cli: 'ok',
    auth: { loggedIn: true, subscriptionType: 'max' },
    usage: {
      fetchedAt: 1,
      limits: [
        { kind: 'session', label: '5h', percent: 72, resetsAt: null, active: true },
        { kind: 'weekly_all', label: 'week', percent: 72, resetsAt: null, active: false },
      ],
    },
    live: [],
  };

  it('shows the plan and quota once connected, alongside the other chips', async () => {
    renderBar(false, behind, undefined, status);
    expect(await screen.findByRole('button', { name: 'Claude Max · 5h 72% · wk 72%' })).toBeInTheDocument();
    expect(await screen.findByText('pi SDK behind')).toBeInTheDocument();
  });

  it('shows no chip while Claude Code has not answered', async () => {
    const { claude } = renderBar(false);
    await waitFor(() => expect(claude.status).toHaveBeenCalled());
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
  });
});
