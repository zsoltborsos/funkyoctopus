import { useRef, useState } from 'react';
import { useService } from '@core/container/useService.ts';
import type {
  HelmraiserCancelScoutsResult,
  HelmraiserRequestScoutsResult,
  HelmraiserStatus,
  HelmraiserScoutLens,
} from '@shared/transport/protocol.ts';
import { ScoutGrid, type ScoutCellError } from './ScoutGrid.tsx';
import { ScoutSettings } from './ScoutSettings.tsx';
import { WORKFLOW } from './workflow.client.ts';

const projectName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function Project({ path }: { path: string }) {
  return <span title={path} className="wrap-anywhere">{projectName(path)}</span>;
}

function ResultPaths({ label, paths }: { label: string; paths: string[] }) {
  return <p>{label}: {paths.length === 0 ? 'none' : paths.map((path, index) => (
    <span key={path}>{index > 0 && ', '}<Project path={path} /></span>
  ))}</p>;
}

export function ScoutControls({ status, onRefresh, disabled }: {
  status: HelmraiserStatus | null;
  onRefresh: () => Promise<void>;
  disabled: boolean;
}) {
  const workflow = useService(WORKFLOW);
  const scouts = status?.scouts;
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [requested, setRequested] = useState<HelmraiserRequestScoutsResult | null>(null);
  const [cancelled, setCancelled] = useState<HelmraiserCancelScoutsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cellErrors, setCellErrors] = useState<ScoutCellError[]>([]);

  const blocked = disabled || pending;
  const refresh = async (): Promise<void> => {
    try { await onRefresh(); }
    catch (failure) { setError(`Status refresh failed: ${errorText(failure)}`); }
  };

  /** One cell's request or cancel: the single action in flight, its result shown, its refusal kept in its cell. */
  const act = async (
    project: string,
    lens: HelmraiserScoutLens,
    action: ScoutCellError['action'],
    call: () => Promise<void>,
  ): Promise<void> => {
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    setCellErrors((current) => current.filter((refusal) => !(refusal.project === project && refusal.lens === lens)));
    try {
      await call();
      await refresh();
    } catch (failure) {
      setCellErrors((current) => [...current, { project, lens, action, message: errorText(failure) }]);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const requestScout = (project: string, lens: HelmraiserScoutLens): Promise<void> =>
    act(project, lens, 'request', async () => {
      setRequested(null);
      setRequested(await workflow.requestScouts([project], lens));
    });
  const cancelScout = (project: string, lens: HelmraiserScoutLens): Promise<void> =>
    act(project, lens, 'cancel', async () => {
      setCancelled(null);
      setCancelled(await workflow.cancelScouts([project], lens));
    });

  return (
    <section aria-label="Scout controls" className="flex flex-col gap-2 border-b border-border pb-4 font-mono text-sm text-text">
      <h3 className="text-xs text-muted">SCOUT</h3>
      {!status && <p className="text-muted">Scout status unavailable</p>}
      {status && !scouts && <p className="text-muted">Update Helmraiser to enable scouting</p>}
      {status && scouts && (
        <ScoutGrid scouts={scouts} queue={status.queue} blocked={blocked} errors={cellErrors}
          onRequest={(project, lens) => void requestScout(project, lens)}
          onCancel={(project, lens) => void cancelScout(project, lens)} />
      )}
      {requested && <div role="status"><ResultPaths label="requested" paths={requested.requested} />
        <ResultPaths label="already pending" paths={requested.already_pending} /></div>}
      {cancelled && <div role="status"><ResultPaths label="cancelled" paths={cancelled.cancelled} />
        <ResultPaths label="not pending" paths={cancelled.not_pending} /></div>}
      {error && <p role="alert" className="text-danger wrap-anywhere">{error}</p>}
      <ScoutSettings status={status} onRefresh={onRefresh} disabled={blocked} />
    </section>
  );
}
