import { useCallback, useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { CHAT_ORCHESTRATOR } from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS } from '@features/chat/chat-sessions.service.ts';
import { useTabFolder } from '@features/chat/useTabFolder.ts';
import type { Project } from '@features/settings/preferences.types.ts';
import { MAIN_CHAT, type ChatSessionInfo, type ProjectCatalog } from '@shared/transport/protocol.ts';
import { FOLDER_NOT_FOUND, wireErrorCode } from '@shared/transport/errors.ts';

/** Sentinel select value for the "Open folder…" typed-path option. */
const OPEN_FOLDER = '__open-folder__';

/** A configured root that is not a strict descendant of another remaining folder. */
function topLevelRoots(paths: string[]): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    if (
      !roots.some((root) => path.startsWith(root + '/')) &&
      !paths.some((other) => other !== path && path.startsWith(other + '/'))
    ) {
      roots.push(path);
    }
  }
  return roots.sort((a, b) => a.localeCompare(b));
}

/** The configured root containing `path`, or null for a path outside every root. */
function containingRoot(path: string, roots: string[]): string | null {
  return roots.find((root) => path.startsWith(root + '/')) ?? null;
}

/**
 * Label a folder relative to its root's parent (`/home/you/projects`
 * → `projects`, `/home/you/projects/helmraiser` → `projects/helmraiser`)
 * so folders from different roots with equal basenames stay distinguishable.
 */
function relativeLabel(path: string, roots: string[]): string {
  const root = containingRoot(path, roots) ?? (roots.includes(path) ? path : null);
  const parent = root ? root.slice(0, root.lastIndexOf('/')) || '/' : null;
  return parent && path.startsWith(parent + '/') ? path.slice(parent.length + 1) : path;
}

/** Represent the sidecar's live working folder in the selector catalog. */
function projectForCwd(cwd: string, catalog: ProjectCatalog | null): Project | null {
  if (cwd === catalog?.globalRoot) return null;
  const listed = [...(catalog?.known ?? []), ...(catalog?.folders ?? [])].find(
    (project) => project.path === cwd,
  );
  if (listed) return listed;
  return {
    id: cwd,
    name: cwd.split('/').filter(Boolean).at(-1) ?? cwd,
    path: cwd,
    envTier: 'normal',
  };
}

export function ProjectSelector() {
  const orchestrator = useService(CHAT_ORCHESTRATOR);
  const chat = useService(CHAT_SESSION);
  const sharedCwd = useSyncExternalStore(chat.subscribe, chat.getSnapshot).activeSession?.cwd;
  // The folder is the shown tab's own (T2.2 review); the tabs say when the shown tab is settled.
  const tabs = useService(CHAT_SESSIONS);
  const tabsReady = useSyncExternalStore(tabs.subscribe, () => tabs.getSnapshot().ready);
  const { folder, setFolder } = useTabFolder();
  const [catalog, setCatalog] = useState<ProjectCatalog | null>(null);
  const [catalogReady, setCatalogReady] = useState(false);
  /** What `currentChat` said, and for which tab. */
  const [initialSession, setInitialSession] = useState<{ chatId: string; session: ChatSessionInfo | null }>();
  const [opening, setOpening] = useState(false);
  const [typedPath, setTypedPath] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const catalogRequest = useRef<Promise<void> | null>(null);
  const catalogGeneration = useRef(0);
  /** Invalidates mount work whenever a newer root decision reaches this tab. */
  const rootDecisionGeneration = useRef(0);
  /** The root-decision generation currentChat's answer belongs to. */
  const initialGeneration = useRef(0);

  const refreshCatalog = useCallback(() => {
    // Pointer focus and pointer down can arrive together; share their request.
    if (catalogRequest.current) return;
    const generation = ++catalogGeneration.current;
    const request = orchestrator
      .discoverProjects()
      .then((found) => {
        if (catalogGeneration.current === generation) {
          setCatalog(found);
          setCatalogReady(true);
        }
      })
      .catch(() => {
        if (catalogGeneration.current === generation) {
          setCatalog(null);
          setCatalogReady(true);
        }
      })
      .finally(() => {
        if (catalogRequest.current === request) catalogRequest.current = null;
      });
    catalogRequest.current = request;
  }, [orchestrator]);

  useEffect(() => {
    refreshCatalog();
    const generation = rootDecisionGeneration.current;
    void orchestrator
      .currentChat()
      .then((session) => {
        if (rootDecisionGeneration.current === generation) {
          initialGeneration.current = generation;
          setInitialSession({ chatId: orchestrator.chatId, session });
        }
      })
      .catch(() => undefined);
    return () => {
      catalogGeneration.current += 1;
      catalogRequest.current = null;
      rootDecisionGeneration.current += 1;
    };
  }, [orchestrator, refreshCatalog]);

  // Effects read the latest folder and catalog without re-running when they change.
  const adoptFolder = useEffectEvent((project: Project | null) => setFolder(project));
  const storedFolder = useEffectEvent(() => folder);
  const currentCatalog = useEffectEvent(() => catalog);

  // ChatSession already follows foreign `session-changed` events for the
  // transcript. Mark it as the newest root decision before mount initialization
  // can act, then mirror it locally without sending a mutation back.
  useEffect(() => {
    if (!sharedCwd) return;
    rootDecisionGeneration.current += 1;
    if (catalogReady) {
      const project = projectForCwd(sharedCwd, currentCatalog());
      adoptFolder(project);
      // The history follows the folder shown, which a reload or another client's switch moved.
      void chat.followRoot(project?.path ?? null).catch(() => undefined);
    }
  }, [catalogReady, sharedCwd, chat]);

  // Once per window, for `main` only: a created tab already has its folder on
  // the sidecar, and re-rooting it would swap its new conversation for an old
  // one. It waits for the tabs, so a reload restoring another tab never
  // re-roots `main` with that tab's folder.
  const initialized = useRef(false);
  useEffect(() => {
    if (!tabsReady || !catalogReady || initialSession?.chatId !== MAIN_CHAT || initialized.current) return;
    if (orchestrator.chatId !== MAIN_CHAT) return;
    initialized.current = true;
    // The decision is only valid for the root state currentChat saw: a pick or a
    // foreign switch since then (which may land before the catalog does) wins.
    const generation = initialGeneration.current;
    if (rootDecisionGeneration.current !== generation) return;
    if (initialSession.session) {
      const project = projectForCwd(initialSession.session.cwd, catalog);
      adoptFolder(project);
      void chat.followRoot(project?.path ?? null).catch(() => undefined);
      return;
    }

    // With no shared session to adopt, restore main's own stored root. Validate
    // it first so a selection retained from another machine still falls back to
    // Global only for the sidecar's explicit FOLDER_NOT_FOUND response.
    const stored = storedFolder();
    if (!stored) {
      if (rootDecisionGeneration.current === generation) {
        void chat.setRoot(null).catch(() => undefined);
      }
      return;
    }
    const restoreStored = async (): Promise<void> => {
      try {
        await orchestrator.resolveProject(stored.path);
      } catch (error: unknown) {
        if (rootDecisionGeneration.current !== generation) return;
        if (wireErrorCode(error) === FOLDER_NOT_FOUND) {
          adoptFolder(null);
          await chat.setRoot(null).catch(() => undefined);
          return;
        }
        await chat.setRoot(stored.path).catch(() => undefined);
        return;
      }
      if (rootDecisionGeneration.current !== generation) return;
      await chat.setRoot(stored.path).catch(() => undefined);
    };
    void restoreStored();
  }, [catalog, catalogReady, chat, initialSession, orchestrator, tabsReady]);

  const globalRoot = catalog?.globalRoot ?? '';
  const known = catalog?.known ?? [];
  const folders = catalog?.folders ?? [];
  const knownPaths = new Set(known.map((project) => project.path));
  const shownFolders = folders.filter(
    (folder) => !knownPaths.has(folder.path) && folder.path !== globalRoot,
  );
  // Roots are derived before the known-dedup so a folder under a root that is
  // itself a known project still labels as `personal/child`, not `child`.
  const roots = topLevelRoots(folders.filter((f) => f.path !== globalRoot).map((f) => f.path));
  const stored = folder;
  // A stored project absent from both lists stays selectable, as today.
  const retained =
    stored && !knownPaths.has(stored.path) && !shownFolders.some((f) => f.path === stored.path)
      ? [stored]
      : [];

  const pick = (project: Project | null) => {
    rootDecisionGeneration.current += 1;
    setFolder(project);
    void chat.setRoot(project?.path ?? null).catch(() => undefined);
    setOpening(false);
    setTypedPath('');
    setTypedError(null);
  };

  const openTyped = async () => {
    const submitted = typedPath.trim();
    if (!submitted) return;
    try {
      const resolved = await orchestrator.resolveProject(submitted);
      pick(resolved);
    } catch (error) {
      setTypedError(error instanceof Error ? error.message : String(error));
    }
  };

  const selected = stored?.id ?? '';

  return (
    <label className="mb-3 flex flex-col gap-1 border-b border-border pb-3 font-mono text-xs text-muted">
      WORKING FOLDER
      <select
        aria-label="Working folder"
        value={selected}
        onFocus={refreshCatalog}
        onPointerDown={refreshCatalog}
        onChange={(event) => {
          const value = event.target.value;
          if (value === OPEN_FOLDER) {
            setOpening(true);
            return;
          }
          const project =
            [...known, ...shownFolders, ...retained].find(
              (candidate) => candidate.id === value,
            ) ?? null;
          pick(project);
        }}
        className="min-w-0 rounded border border-border bg-bg py-1.5 pl-2 pr-6 text-text"
      >
        <option value="">Global · {globalRoot || 'workspace'}</option>
        {retained.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
        {known.length > 0 && (
          <optgroup label="Known projects">
            {[...known]
              .sort(
                (a, b) =>
                  a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
              )
              .map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
          </optgroup>
        )}
        {shownFolders.length > 0 && (
          <optgroup label="Folders">
            {shownFolders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {relativeLabel(folder.path, roots)}
              </option>
            ))}
          </optgroup>
        )}
        <option value={OPEN_FOLDER}>Open folder…</option>
      </select>
      {opening && (
        <span className="flex items-center gap-1">
          <input
            aria-label="Folder path"
            placeholder="/path/to/folder or ~/…"
            value={typedPath}
            onChange={(event) => {
              setTypedPath(event.target.value);
              setTypedError(null);
            }}
            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-text"
          />
          <button
            type="button"
            onClick={() => void openTyped()}
            className="rounded border border-border px-2 py-1 text-text hover:bg-border/40"
          >
            OPEN
          </button>
          <button
            type="button"
            onClick={() => {
              setOpening(false);
              setTypedPath('');
              setTypedError(null);
            }}
            className="rounded border border-border px-2 py-1 text-muted hover:bg-border/40"
          >
            CANCEL
          </button>
        </span>
      )}
      {typedError && <span className="text-danger">{typedError}</span>}
    </label>
  );
}
