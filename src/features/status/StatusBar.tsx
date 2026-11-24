import { useEffect, useState } from 'react';
import { useNow } from '@core/clock/useNow.ts';
import { useService } from '@core/container/useService.ts';
import type {
  EmbeddedStatus,
  EmbeddedUpkeepInfo,
  HealthResult,
  UpkeepResult,
} from '@shared/transport/protocol.ts';
import { SYSTEM } from './system.client.ts';
import { useConnection } from './useConnection.ts';
import { useHelmraiserMonitor } from '@features/jobs/useHelmraiserMonitor.ts';
import { useShell } from '@core/shell/useShell.ts';
import { startHint } from '@core/transport/humane-error.ts';
import { ClaudeCodeChip } from '@features/claude-code/ClaudeCodeChip.tsx';

const DOT: Record<string, string> = {
  open: 'bg-ok shadow-glow-ok',
  connecting: 'bg-info',
  closed: 'bg-danger shadow-glow-danger',
};

const LABEL: Record<string, string> = {
  open: 'SIDECAR ONLINE',
  connecting: 'CONNECTING…',
  closed: 'SIDECAR OFFLINE',
};

/**
 * Backend liveness is discovered as seams are exercised (pi on its first
 * session, helmraiser on its first probe), so a single fetch at connect time
 * would freeze the strip on the startup picture. Re-read it on an interval.
 */
const HEALTH_POLL_MS = 5000;

/** The exact promotion command the available state must show verbatim (`scripts/promote-pi.ts`). */
const PROMOTION_COMMAND = 'npm run promote:pi';
const CLAUDE_PROMOTION_COMMAND = 'npm run promote:claude-sdk';
const RECOVERY_COMMAND = 'npm run upkeep:embedded -- --recover';

/** Statuses that are something to say, plus deterministic-only verification. */
const EMBEDDED_SHOWN_STATUSES: readonly EmbeddedStatus[] = [
  'available',
  'promotion_failed',
  'needs_attention',
  'recovery_required',
  'cleanup_pending',
];

/**
 * The embedded-SDK strip renders only detection/promotion states worth
 * acting on and the deterministic-only honesty signal; healthy current,
 * unknown, and checking states stay quiet.
 */
function embeddedChip(embedded: EmbeddedUpkeepInfo): { label: string; tooltip: string } | null {
  const shown =
    EMBEDDED_SHOWN_STATUSES.includes(embedded.status) ||
    embedded.verificationLevel === 'deterministic_only';
  if (!shown) return null;
  const versions = `installed ${embedded.installedVersion ?? 'unknown'} · latest ${embedded.latestVersion ?? 'unknown'} · verified ${embedded.verifiedVersion ?? 'unknown'} (${embedded.verificationLevel})`;
  switch (embedded.status) {
    case 'available':
      return {
        label: 'SDK update available',
        tooltip: `embedded pi SDK update available — stop the sidecar first, then run: ${PROMOTION_COMMAND} · ${versions}`,
      };
    case 'promotion_failed': {
      const result = embedded.lastPromotionResult ? ` — ${embedded.lastPromotionResult.slice(0, 160)}` : '';
      return {
        label: 'SDK promotion failed',
        tooltip: `embedded pi SDK promotion failed; the previous version was retained${result} · ${versions}`,
      };
    }
    case 'needs_attention':
      return {
        label: 'SDK needs attention',
        tooltip: `embedded pi SDK baseline needs attention — promotion is refused until package.json, lockfile, and installed agree · ${versions}`,
      };
    case 'recovery_required':
      return {
        label: 'SDK recovery required',
        tooltip: `embedded pi SDK recovery is required — stop the sidecar, then run: ${RECOVERY_COMMAND} · ${versions}`,
      };
    case 'cleanup_pending':
      return {
        label: 'SDK cleanup pending',
        tooltip: `embedded pi SDK: obsolete backup cleanup is pending — stop the sidecar, then run: ${RECOVERY_COMMAND} · ${versions}`,
      };
    default:
      return {
        label: 'SDK verified deterministically',
        tooltip: `embedded pi SDK verified only deterministically (deterministic_only) — ${versions}`,
      };
  }
}

/**
 * The upkeep strip renders only failures or drift. `unknown` drift is a
 * version-read miss, not a drift, and healthy/disabled states are nothing to
 * show — the tooltip carries the details when there is something to say.
 */
function upkeepChip(upkeep: UpkeepResult): { label: string; tooltip: string } | null {
  const failed =
    upkeep.status === 'failed' ||
    upkeep.status === 'timed_out' ||
    upkeep.status === 'missing_binary';
  if (!failed && upkeep.drift !== 'behind' && upkeep.drift !== 'ahead') return null;
  const label =
    upkeep.status === 'failed'
      ? 'upkeep failed'
      : upkeep.status === 'timed_out'
        ? 'upkeep timed out'
        : upkeep.status === 'missing_binary'
          ? 'pi not found'
          : upkeep.drift === 'behind'
            ? 'pi SDK behind'
            : 'pi SDK ahead';
  const versions = `global pi CLI ${upkeep.globalPiVersion ?? 'unknown'} · embedded pi SDK ${upkeep.embeddedSdkVersion ?? 'unknown'}`;
  const why =
    'the embedded pi SDK is pinned in this repository\u2019s package.json; aligning it is a deliberate dependency update';
  const detail = upkeep.lastResult ? ` — ${upkeep.lastResult.slice(0, 160)}` : '';
  return { label, tooltip: `upkeep: ${label}${detail} · ${versions} · ${why}` };
}

/** Attention only: compare paired patches, not the unrelated CLI/SDK major versions. */
function claudeSdkChip(info: UpkeepResult['claudeSdk']): { label: string; tooltip: string } | null {
  if (info?.status !== 'drift' || !info.cliVersion || !info.sdkVersion) return null;
  const cli = /^2\.1\.(0|[1-9]\d*)$/.exec(info.cliVersion);
  const sdk = /^0\.3\.(0|[1-9]\d*)$/.exec(info.sdkVersion);
  if (!cli || !sdk) return null;
  const cliPatch = Number(cli[1]);
  const sdkPatch = Number(sdk[1]);
  if (!Number.isSafeInteger(cliPatch) || !Number.isSafeInteger(sdkPatch) || cliPatch === sdkPatch) return null;
  return {
    label: `Claude SDK ${sdkPatch < cliPatch ? 'behind' : 'ahead'} CLI`,
    tooltip: `Claude Code CLI ${info.cliVersion} · Claude Agent SDK ${info.sdkVersion} — stop the sidecar first, then run: ${CLAUDE_PROMOTION_COMMAND}`,
  };
}

/** How long `pi update --all` may wait on crew work before the strip mentions it. */
const LONG_DEFERRAL_MS = 24 * 3_600_000;

/**
 * A quiet note when the automatic `pi update --all` has been deferred, run
 * after run, for over a day (it waits only while crew work is running under an
 * updatable extension). Nothing to fix, so not an attention chip.
 */
const DEFERRAL_TICK_MS = 60_000;

function deferralNote(upkeep: UpkeepResult, now: number): { label: string; tooltip: string } | null {
  if (upkeep.status !== 'deferred' || upkeep.deferredSince == null) return null;
  if (now - upkeep.deferredSince < LONG_DEFERRAL_MS) return null;
  const hours = Math.floor((now - upkeep.deferredSince) / 3_600_000);
  return {
    label: 'pi update waiting',
    tooltip: `pi update --all has waited ${hours} h — ${upkeep.lastResult ?? 'deferred'}; it runs at the first check with no crew work going`,
  };
}

/** The exact down-Helmraiser tooltip: helmraiser v2 is a CLI, not a Hub server. */

/** Bottom status strip: live transport state + sidecar health once connected. */
export function StatusBar() {
  const state = useConnection();
  const system = useService(SYSTEM);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [upkeep, setUpkeep] = useState<UpkeepResult | null>(null);
  const helmraiser = useHelmraiserMonitor();
  const { setView } = useShell();
  const runningRun = helmraiser.status?.running[0] ?? null;
  const runningTitle = runningRun ? (runningRun.title ?? runningRun.id ?? runningRun.task) : null;

  // Leaving `open` drops what the last connection reported, in the same render.
  const open = state === 'open';
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setHealth(null);
      setUpkeep(null);
    }
  }

  useEffect(() => {
    if (state !== 'open') return;
    let active = true;
    const poll = (): void => {
      system
        .health()
        .then((h) => {
          if (active) setHealth(h);
        })
        .catch(() => {
          if (active) setHealth(null);
        });
      system
        .upkeep()
        .then((u) => {
          if (active) setUpkeep(u);
        })
        .catch(() => {
          if (active) setUpkeep(null);
        });
    };
    poll();
    const timer = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [state, system]);

  const globalChip = upkeep ? upkeepChip(upkeep) : null;
  // The deferral note counts hours; a minute tick runs only while pi's update waits.
  const now = useNow(DEFERRAL_TICK_MS, upkeep?.status === 'deferred');
  const waiting = upkeep ? deferralNote(upkeep, now) : null;
  const embedded = upkeep ? embeddedChip(upkeep.embedded) : null;
  const claudeSdk = claudeSdkChip(upkeep?.claudeSdk);

  return (
    // One line at any width (T2.3): nothing wraps; the Helmraiser run label is what truncates.
    <footer className="flex w-full min-w-0 items-center gap-3 whitespace-nowrap border-t border-border bg-surface-raised px-4 py-2 font-mono text-xs text-muted">
      <span className={`inline-block h-2 w-2 rounded-full ${DOT[state] ?? 'bg-muted'}`} />
      <span className="tracking-widest text-text">{LABEL[state] ?? state}</span>
      {runningRun && (
        <>
          <span className="text-faint">|</span>
          <button
            type="button"
            onClick={() => setView('jobs')}
            className="min-w-0 max-w-[45vw] truncate text-left text-info hover:text-text"
            title={`${runningTitle} · ${runningRun.stage} · iteration ${runningRun.iteration}`}
          >
            {runningTitle} · {runningRun.stage} · iteration {runningRun.iteration}
          </button>
        </>
      )}
      {globalChip && (
        <>
          <span className="text-faint">|</span>
          <span className="text-attention" title={globalChip.tooltip}>
            {globalChip.label}
          </span>
        </>
      )}
      {waiting && (
        <>
          <span className="text-faint">|</span>
          <span className="text-muted" title={waiting.tooltip}>
            {waiting.label}
          </span>
        </>
      )}
      {embedded && (
        <>
          <span className="text-faint">|</span>
          <span className="text-attention" title={embedded.tooltip}>
            {embedded.label}
          </span>
        </>
      )}
      {claudeSdk && (
        <>
          <span className="text-faint">|</span>
          <span className="text-attention" title={claudeSdk.tooltip}>
            {claudeSdk.label}
          </span>
        </>
      )}
      <ClaudeCodeChip connected={state === 'open'} />
      {health && (
        <>
          <span className="text-faint">|</span>
          <span>v{health.version}</span>
          <span className="text-faint">|</span>
          <span>up {Math.floor(health.uptimeMs / 1000)}s</span>
          {Object.entries(health.backends).map(([name, status]) => {
            // A tool whose CLI is missing is not a fault: it reads dim, and the
            // tooltip says how to get it. `down` means it is there but failed (danger).
            const hint = status === 'not_installed' ? startHint(name) : null;
            return (
            <span key={name} className="text-muted" title={hint ?? undefined}>
              <span className="text-faint"> · </span>
              {name}:
              <span className={status === 'up' ? 'text-ok' : status === 'down' ? 'text-danger' : 'text-muted'}>
                {status === 'not_installed' ? 'not installed' : status}
              </span>
            </span>
            );
          })}
        </>
      )}
    </footer>
  );
}
