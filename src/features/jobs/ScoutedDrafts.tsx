import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { HELMRAISER_DROP_CLASSES, type HelmraiserDropClass, type HelmraiserScoutedDraft, type HelmraiserStatus } from '@shared/transport/protocol.ts';
import { useService } from '@core/container/useService.ts';
import { useShell } from '@core/shell/useShell.ts';
import { CHAT_ORCHESTRATOR } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSIONS } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDERS, folderProject } from '@features/chat/tab-folders.ts';
import { WORKFLOW } from './workflow.client.ts';

const discussDraftPrompt = (draft: HelmraiserScoutedDraft): string =>
  `Help me refine this Helmraiser draft.\n\nProject: ${draft.project}\nTitle: ${draft.title}\nTask file: ${draft.path ?? 'unavailable'}\n\nRead the task file, help refine it, and queue it only when I am happy with it.`;

const draftKey = (draft: HelmraiserScoutedDraft): string =>
  `${draft.project}\u0000${draft.path ?? draft.task_id ?? draft.id}`;

const formatDraftAge = (seconds: number): string => {
  const age = Math.max(0, seconds);
  if (age < 60) return `${Math.floor(age)}s`;
  if (age < 3_600) return `${Math.floor(age / 60)}m`;
  if (age < 86_400) return `${Math.floor(age / 3_600)}h`;
  return `${Math.floor(age / 86_400)}d`;
};

type RowState = {
  mode: 'idle' | 'queue' | 'drop';
  pending: boolean;
  reason: string;
  dropClass: HelmraiserDropClass | null;
  error: string | null;
};

const idleRow = (): RowState => ({ mode: 'idle', pending: false, reason: '', dropClass: null, error: null });

/** What each drop class means, as Helmraiser defines them (docs/reference.md "drafts drop"). */
const DROP_CLASS_NOTES: Record<HelmraiserDropClass, string> = {
  wrong: 'the finding is not real',
  unwanted: 'real, but not worth doing',
  duplicate: 'already tracked, fixed, or the same as another draft',
  unusable: 'real and wanted, but needs too much rework to queue',
};
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function ScoutedDrafts({
  refreshToken,
  onQueueSuccess,
  mode = 'scouted',
}: {
  mode?: 'scouted' | 'unqueued';
  refreshToken: HelmraiserStatus | null;
  onQueueSuccess: () => Promise<void>;
}) {
  const workflow = useService(WORKFLOW);
  const orchestrator = useService(CHAT_ORCHESTRATOR);
  const chatTabs = useService(CHAT_SESSIONS);
  const folders = useService(TAB_FOLDERS);
  const navigation = chatTabs.reviewNavigation;
  const reviewNavigationPending = useSyncExternalStore(navigation.subscribe, navigation.isPending);
  const { composeInChat } = useShell();
  const [drafts, setDrafts] = useState<HelmraiserScoutedDraft[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const request = useRef(0);
  const removed = useRef(new Set<string>());

  // A new status asks again; the last failure no longer stands, while the drafts shown stay.
  const [askedFor, setAskedFor] = useState(refreshToken);
  if (askedFor !== refreshToken) {
    setAskedFor(refreshToken);
    setLoadError(null);
  }

  useEffect(() => {
    const sequence = ++request.current;
    void (mode === 'unqueued' ? workflow.allDrafts() : workflow.drafts()).then(
      (next) => {
        if (sequence !== request.current) return;
        setDrafts(next.filter((draft) => (mode !== 'unqueued' || (draft.kind === 'manual' && draft.age > 600)) && !removed.current.has(draftKey(draft))));
      },
      (error: unknown) => {
        if (sequence !== request.current) return;
        setDrafts([]);
        setLoadError(errorText(error));
      },
    );
    return () => {
      if (sequence === request.current) request.current += 1;
    };
  }, [workflow, refreshToken, mode]);

  const patchRow = (key: string, patch: Partial<RowState>): void => {
    setRows((current) => ({ ...current, [key]: { ...(current[key] ?? idleRow()), ...patch } }));
  };

  const remove = (draft: HelmraiserScoutedDraft): void => {
    const key = draftKey(draft);
    removed.current.add(key);
    setDrafts((current) => current?.filter((row) => draftKey(row) !== key) ?? current);
  };

  const queue = async (draft: HelmraiserScoutedDraft): Promise<void> => {
    if (!draft.path) return;
    const key = draftKey(draft);
    patchRow(key, { pending: true, error: null });
    try {
      const current = await orchestrator.currentChat();
      await workflow.queue(draft.path, current ? `fo:${current.path}` : undefined);
      remove(draft);
      await onQueueSuccess();
    } catch (error) {
      patchRow(key, { pending: false, error: errorText(error) });
    }
  };

  const drop = async (draft: HelmraiserScoutedDraft, reason: string, dropClass: HelmraiserDropClass | null): Promise<void> => {
    const key = draftKey(draft);
    const taskId = draft.task_id ?? draft.id;
    const trimmed = reason.trim();
    if (!taskId.trim() || !trimmed || !dropClass) return;
    patchRow(key, { pending: true, error: null });
    try {
      await workflow.dropDraft(taskId, trimmed, dropClass);
      remove(draft);
    } catch (error) {
      patchRow(key, { pending: false, error: errorText(error) });
    }
  };

  const discuss = async (draft: HelmraiserScoutedDraft): Promise<void> => {
    if (!draft.path) return;
    const release = navigation.tryAcquire();
    if (!release) return;
    const key = draftKey(draft);
    patchRow(key, { pending: true, error: null });
    try {
      // A new pi tab in the draft's project, so no tab's conversation is replaced.
      const project = draft.project;
      const opened = await chatTabs.create('pi', project, (chatId) =>
        folders.forTab(chatId).set(folderProject(project)),
      );
      composeInChat(discussDraftPrompt(draft), opened);
    } catch (error) {
      patchRow(key, { error: errorText(error) });
    } finally {
      patchRow(key, { pending: false });
      release();
    }
  };

  const Container = mode === 'unqueued' ? 'details' : 'section';
  const Heading = mode === 'unqueued' ? 'summary' : 'h3';
  return (
    <Container aria-label={mode === 'unqueued' ? 'Unqueued drafts' : 'Scouted drafts'} className="flex flex-col gap-2 border-b border-border pb-4">
      <Heading className="font-mono text-xs text-muted">
        {mode === 'unqueued' ? 'UNQUEUED DRAFTS' : 'SCOUTED'}{drafts !== null ? ` (${drafts.length})` : ''}
      </Heading>
      {drafts === null && <p className="font-mono text-sm text-muted">loading {mode} drafts…</p>}
      {loadError && <p role="alert" className="font-mono text-sm text-danger">⚠ {loadError}</p>}
      {!loadError && drafts?.length === 0 && (
        <p className="font-mono text-sm text-muted">{mode === 'unqueued' ? 'No older unqueued drafts' : 'No drafts — run a scout'}</p>
      )}
      {drafts?.map((draft) => {
        const key = draftKey(draft);
        const row = rows[key] ?? idleRow();
        const pathUnavailable = !draft.path;
        return (
          <article key={key} aria-label={`${mode === 'unqueued' ? 'Unqueued' : 'Scouted'} draft: ${draft.title}`} className="rounded border border-border p-3 font-mono text-sm">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <strong className="text-text">{draft.title}</strong>
              {mode !== 'unqueued' && <span className="text-muted">{draft.lens ?? 'state'}</span>}
              <span className="text-muted">{draft.size}</span>
              <span className="text-muted">{formatDraftAge(draft.age)} ago</span>
            </div>
            <p className="mt-1 break-all text-xs text-muted">{draft.project}</p>
            {draft.preflight?.summary && <p className="mt-2 text-xs text-text">{draft.preflight.summary}</p>}
            {draft.preflight?.error && <p className="mt-1 text-xs text-danger">{draft.preflight.error}</p>}
            {draft.intake_error
              ? <p className="mt-1 text-xs text-danger">{draft.intake_error}</p>
              : <p className="mt-1 text-xs text-muted">{draft.intake_status}</p>}
            {pathUnavailable && <p className="mt-1 text-xs text-muted">task path unavailable — Queue and Discuss disabled</p>}
            {row.error && <p role="alert" className="mt-2 text-xs text-danger">⚠ {row.error}</p>}

            {row.mode === 'queue' ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">Queue this draft?</span>
                <RowButton name="CONFIRM QUEUE" tone="accent" disabled={row.pending} onClick={() => void queue(draft)} />
                <RowButton name="CANCEL" tone="muted" disabled={row.pending} onClick={() => patchRow(key, { mode: 'idle', error: null })} />
              </div>
            ) : row.mode === 'drop' ? (
              <div className="mt-3 flex flex-col gap-3">
                <DropClassPicker value={row.dropClass} disabled={row.pending} onChange={(dropClass) => patchRow(key, { dropClass })} />
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-muted">
                    Drop reason
                    <input
                      value={row.reason}
                      disabled={row.pending}
                      onChange={(event) => patchRow(key, { reason: event.target.value })}
                      className="rounded border border-border bg-bg px-2 py-1 text-text outline-none focus:border-accent"
                    />
                  </label>
                  <RowButton name="CONFIRM DROP" tone="danger" disabled={row.pending || row.dropClass === null || row.reason.trim() === ''} onClick={() => void drop(draft, row.reason, row.dropClass)} />
                  <RowButton name="CANCEL" tone="muted" disabled={row.pending} onClick={() => patchRow(key, { mode: 'idle', reason: '', dropClass: null, error: null })} />
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <RowButton name="QUEUE" tone="accent" disabled={row.pending || pathUnavailable} {...(pathUnavailable ? { title: 'Task path unavailable' } : {})} onClick={() => patchRow(key, { mode: 'queue', error: null })} />
                <RowButton name="DISCUSS" tone="muted" disabled={row.pending || pathUnavailable || reviewNavigationPending} {...(pathUnavailable ? { title: 'Task path unavailable' } : {})} onClick={() => void discuss(draft)} />
                <RowButton name="DROP" tone="danger" disabled={row.pending} onClick={() => patchRow(key, { mode: 'drop', error: null })} />
              </div>
            )}
          </article>
        );
      })}
    </Container>
  );
}

/** One required choice of why a draft is dropped; its own radio name keeps rows' choices apart. */
function DropClassPicker({
  value,
  disabled,
  onChange,
}: {
  value: HelmraiserDropClass | null;
  disabled: boolean;
  onChange: (dropClass: HelmraiserDropClass) => void;
}) {
  const group = useId();
  return (
    <fieldset role="radiogroup" disabled={disabled} className="flex flex-col gap-1 text-xs">
      <legend className="mb-1 text-muted">Why drop it?</legend>
      {HELMRAISER_DROP_CLASSES.map((dropClass) => (
        <label key={dropClass} className="flex items-baseline gap-2">
          <input
            type="radio"
            name={group}
            value={dropClass}
            checked={value === dropClass}
            onChange={() => onChange(dropClass)}
            className="accent-accent"
          />
          <span className="text-text">{dropClass}</span>{' '}
          <span className="text-muted">{DROP_CLASS_NOTES[dropClass]}</span>
        </label>
      ))}
    </fieldset>
  );
}

function RowButton({
  name,
  tone,
  disabled,
  title,
  onClick,
}: {
  name: string;
  tone: 'accent' | 'danger' | 'muted';
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  const color = tone === 'accent'
    ? 'border-accent text-accent'
    : tone === 'danger'
      ? 'border-danger text-danger'
      : 'border-border text-muted';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs ${color} disabled:opacity-40`}
    >
      {name}
    </button>
  );
}
