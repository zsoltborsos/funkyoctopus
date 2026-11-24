import { useEffect, useRef, useState } from 'react';
import type { HelmraiserScoutLens, HelmraiserScoutSettings, HelmraiserStatus } from '@shared/transport/protocol.ts';
import { useService } from '@core/container/useService.ts';
import { WORKFLOW } from './workflow.client.ts';

const lenses: HelmraiserScoutLens[] = ['state', 'docs', 'tests', 'guardrails'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function ScoutSettings({ status, onRefresh, disabled }: {
  status: HelmraiserStatus | null; onRefresh: () => Promise<void>; disabled: boolean;
}) {
  const workflow = useService(WORKFLOW);
  const [settings, setSettings] = useState<HelmraiserScoutSettings | null>(null);
  const [text, setText] = useState<Partial<Record<HelmraiserScoutLens, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const sequence = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const id = ++sequence.current;
    if (busy.current) return;
    setError(null);
    const read = status?.scouts?.lenses
      ? Promise.resolve({ lenses: status.scouts.lenses }) : workflow.scoutSettings();
    void read.then((value) => {
      // Background polls update effective settings, not the owner's unsaved inputs.
      if (id === sequence.current) setSettings(value);
    }, (failure: unknown) => { if (id === sequence.current) setError(message(failure)); });
    return () => { if (sequence.current === id) sequence.current = id + 1; };
  }, [status, workflow]);

  const mutate = async (action: () => Promise<HelmraiserScoutSettings>, clearCooldown?: HelmraiserScoutLens) => {
    if (busy.current || disabled) return;
    busy.current = true;
    sequence.current++;
    setPending(true);
    setError(null);
    try {
      setSettings(await action());
      if (clearCooldown !== undefined) setText((current) => {
        const next = { ...current };
        delete next[clearCooldown];
        return next;
      });
      try { await onRefresh(); } catch (failure) { setError(`Status refresh failed: ${message(failure)}`); }
    } catch (failure) { setError(message(failure)); }
    finally { busy.current = false; setPending(false); }
  };
  const button = 'rounded border border-border px-2 py-1 text-xs text-text hover:border-accent disabled:opacity-40';
  return <section aria-label="Scout automation settings" className="flex flex-col gap-2 border-t border-border pt-3">
    <h4 className="text-xs text-muted">AUTOMATION SETTINGS</h4>
    <p className="text-xs text-muted">a lens switched on runs automatically even while <code>routing.scout.enabled</code> is false; queue pause stops all scouting.</p>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {!settings && !error && <p>loading scout settings…</p>}
    {settings && lenses.map((lens) => {
      // An older Helmraiser does not report a lens it does not have.
      const value: HelmraiserScoutSettings['lenses'][HelmraiserScoutLens] | undefined = settings.lenses[lens];
      if (!value) return null;
      return <fieldset key={lens} disabled={disabled || pending} className="flex flex-wrap items-center gap-3 rounded border border-border p-2">
        <legend className="px-1 text-xs text-muted">{lens}</legend>
        <label className="text-xs"><input type="checkbox" className="accent-accent" checked={value.auto} onChange={(event) => void mutate(() => workflow.setScoutSettings({ lens, auto: event.target.checked }))} /> {lens} automatic</label>
        <span className="text-xs text-muted">auto: {value.source.auto}</span>
        <label className="text-xs">{lens} cooldown hours <input type="number" step="any" className="w-20 rounded border border-border bg-bg px-2 text-text" value={text[lens] ?? String(value.cooldown_hours)} onChange={(event) => setText((current) => ({ ...current, [lens]: event.target.value }))} /></label>
        <span className="text-xs text-muted">cooldown: {value.source.cooldown_hours}</span>
        <button className={button} onClick={() => {
          const cooldownHours = Number(text[lens] ?? value.cooldown_hours);
          if (!Number.isFinite(cooldownHours) || cooldownHours <= 0) { setError(`${lens}: cooldown must be finite and greater than zero`); return; }
          void mutate(() => workflow.setScoutSettings({ lens, cooldownHours }), lens);
        }}>Save cooldown</button>
        {(value.source.auto === 'ledger' || value.source.cooldown_hours === 'ledger') && <button className={button} onClick={() => void mutate(() => workflow.resetScoutSettings(lens), lens)}>Reset to default</button>}
      </fieldset>;
    })}
  </section>;
}
