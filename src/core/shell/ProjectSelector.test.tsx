import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import type { Project } from '@features/settings/preferences.types.ts';
import type {
  ChatChunk,
  ChatSessionInfo,
  ChatTimelineItem,
  ProjectCatalog,
  ProjectOption,
} from '@shared/transport/protocol.ts';
import {
  CHAT_ORCHESTRATOR,
  type ChatOrchestrator,
} from '@features/chat/chat-orchestrator.client.ts';
import { CHAT_SESSION, ChatSession } from '@features/chat/chat-session.service.ts';
import { CHAT_SESSIONS } from '@features/chat/chat-sessions.service.ts';
import { TAB_FOLDER, TabFolders } from '@features/chat/tab-folders.ts';
import { ProjectSelector } from './ProjectSelector.tsx';
import { FOLDER_NOT_FOUND, WireCallError } from '@shared/transport/errors.ts';

const option = (path: string, name?: string): ProjectOption => ({
  id: path,
  name: name ?? path.split('/').at(-1) ?? path,
  path,
  envTier: 'normal',
});

/** Catalog with one Leeboard-known project and two browsable root trees. */
const catalog = (): ProjectCatalog => ({
  globalRoot: '/home/you/Work',
  known: [
    { id: '/home/example/projects/funkyoctopus', name: 'FunkyOctopus', path: '/home/example/projects/funkyoctopus', envTier: 'normal' },
  ],
  folders: [
    { id: '/home/you/Work', name: 'Work', path: '/home/you/Work', envTier: 'normal' },
    { id: '/home/example/projects', name: 'projects', path: '/home/example/projects', envTier: 'normal' },
    { id: '/home/example/projects/funkyoctopus', name: 'FunkyOctopus', path: '/home/example/projects/funkyoctopus', envTier: 'normal' },
    { id: '/home/example/projects/helmraiser', name: 'helmraiser', path: '/home/example/projects/helmraiser', envTier: 'normal' },
    { id: '/home/example/work', name: 'work', path: '/home/example/work', envTier: 'normal' },
    { id: '/home/example/work/acme-app', name: 'acme-app', path: '/home/example/work/acme-app', envTier: 'normal' },
  ],
});

interface SetupOptions {
  discover?: Promise<ProjectCatalog>;
  catalog?: ProjectCatalog | null;
  stored?: Project | null;
  current?: ChatSessionInfo | null | Promise<ChatSessionInfo | null>;
  resolve?: (path: string) => Promise<Project>;
  setRoot?: (path: string | null) => Promise<ChatTimelineItem[]>;
  /** The shown tab (main by default). */
  chatId?: string;
  /** Whether the tab list has arrived; it can be made to arrive later. */
  tabsReady?: boolean;
}

function setup({
  catalog: catalogValue = catalog(),
  stored = null,
  current = null,
  resolve,
  setRoot: setRootImpl,
  discover,
  chatId = 'main',
  tabsReady = true,
}: SetupOptions = {}) {
  const setRoot = vi.fn(setRootImpl ?? (() => Promise.resolve([])));
  const listChats = vi.fn((_root: string | null) => Promise.resolve([] as ChatSessionInfo[]));
  let observer: ((chunk: ChatChunk) => void) | null = null;
  const discoverProjects = vi.fn(() =>
    discover
      ? discover
      : catalogValue
        ? Promise.resolve(catalogValue)
        : Promise.reject(new Error('sidecar unavailable')),
  );
  const orchestrator = {
    chatId,
    discoverProjects,
    resolveProject:
      resolve ??
      ((path: string) => Promise.resolve(option(path))),
    setRoot,
    listChats,
    currentChat: vi.fn(() => Promise.resolve(current)),
    transcript: () => Promise.resolve([]),
    // The ChatSession service subscribes an observation stream on construction.
    observe: (handlers: { onChunk: (chunk: ChatChunk) => void }) => {
      observer = handlers.onChunk;
      return () => {};
    },
  } as unknown as ChatOrchestrator;
  const storage = new MemoryStorageAdapter();
  const preferences = new PreferencesService(storage);
  // The shown tab's own folder; `stored` is what this tab last had.
  const tabFolders = new TabFolders(storage);
  const folder = tabFolders.forTab(chatId);
  if (stored) folder.set(stored);
  let ready = tabsReady;
  const tabListeners = new Set<() => void>();
  const tabs = {
    subscribe: (listener: () => void) => {
      tabListeners.add(listener);
      return () => tabListeners.delete(listener);
    },
    getSnapshot: () => ({ ready, tabs: [], activeChatId: chatId }),
  };
  const container = new Container();
  container.registerInstance(CHAT_ORCHESTRATOR, orchestrator);
  container.register(CHAT_SESSION, (c) => new ChatSession(c.resolve(CHAT_ORCHESTRATOR)));
  container.registerInstance(PREFERENCES, preferences);
  container.registerInstance(CHAT_SESSIONS, tabs as never);
  container.registerInstance(TAB_FOLDER, folder);

  const rendered = render(
    <ContainerProvider container={container}>
      <ProjectSelector />
    </ContainerProvider>,
  );
  return {
    preferences,
    folder,
    tabFolders,
    /** The tab list arrives. */
    tabsArrive: () => {
      ready = true;
      act(() => tabListeners.forEach((listener) => listener()));
    },
    listChats,
    setRoot,
    orchestrator,
    discoverProjects,
    emit: (chunk: ChatChunk) => observer?.(chunk),
    unmount: rendered.unmount,
  };
}

const selector = () => screen.getByRole('combobox', { name: 'Working folder' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ProjectSelector', () => {
  const liveSession = (cwd: string): ChatSessionInfo => ({
    path: '/sessions/live.jsonl', engine: 'pi',
    id: 'live',
    cwd,
    title: 'Live session',
    created: '2026-09-28T00:00:00Z',
    modified: '2026-09-28T00:00:00Z',
  });

  it('adopts a live session in a known project without re-rooting it', async () => {
    const { folder, setRoot } = setup({
      stored: option('/old/project', 'Old project'),
      current: liveSession('/home/example/projects/funkyoctopus'),
    });

    await vi.waitFor(() =>
      expect(selector()).toHaveValue('/home/example/projects/funkyoctopus'),
    );
    expect(folder.get()).toEqual(catalog().known[0]);
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('adopts a live session at the catalog global root without re-rooting it', async () => {
    const { folder, setRoot } = setup({
      stored: option('/old/project', 'Old project'),
      current: liveSession('/home/you/Work'),
    });

    await vi.waitFor(() => expect(selector()).toHaveValue(''));
    expect(folder.get()).toBeNull();
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('retains a live session path outside the catalog without re-rooting it', async () => {
    const { folder, setRoot } = setup({
      current: liveSession('/outside/catalog/project'),
    });

    await vi.waitFor(() => expect(selector()).toHaveValue('/outside/catalog/project'));
    expect(folder.get()).toEqual(
      option('/outside/catalog/project', 'project'),
    );
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('restores a stored project once when there is no live session', async () => {
    const stored = option('/home/example/work/acme-app');
    const { setRoot } = setup({ stored });

    await vi.waitFor(() =>
      expect(setRoot).toHaveBeenCalledWith(stored.path, expect.any(String)),
    );
    expect(setRoot).toHaveBeenCalledTimes(1);
  });

  it('does not restore a stored root when a foreign switch lands between currentChat and the catalog', async () => {
    const catalogArrives = deferred<ProjectCatalog>();
    const { emit, folder, setRoot } = setup({
      stored: option('/old/project', 'Old project'),
      current: null,
      discover: catalogArrives.promise,
    });
    // currentChat has resolved (no live session) while the catalog is still pending.
    await new Promise((resolve) => setTimeout(resolve, 20));

    emit({
      kind: 'session-changed',
      origin: 'other-tab',
      session: liveSession('/home/example/work/acme-app'),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    catalogArrives.resolve(catalog());

    await vi.waitFor(() =>
      expect(folder.get()?.path).toBe('/home/example/work/acme-app'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('does not let a stale currentChat result override a newer foreign switch', async () => {
    const current = deferred<ChatSessionInfo | null>();
    const { emit, folder, setRoot } = setup({
      stored: option('/old/project', 'Old project'),
      current: current.promise,
    });
    await screen.findByRole('option', { name: 'FunkyOctopus' });

    emit({
      kind: 'session-changed',
      origin: 'other-tab',
      session: liveSession('/home/example/work/acme-app'),
    });
    await vi.waitFor(() =>
      expect(folder.get()?.path).toBe('/home/example/work/acme-app'),
    );

    current.resolve(null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(folder.get()?.path).toBe('/home/example/work/acme-app');
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('does not retry a stored-root restore when setRoot rejects', async () => {
    const stored = option('/home/example/work/acme-app');
    const { setRoot } = setup({
      stored,
      setRoot: () => Promise.reject(new Error('socket closed')),
    });

    await vi.waitFor(() => expect(setRoot).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setRoot).toHaveBeenCalledWith(stored.path, expect.any(String));
    expect(setRoot).toHaveBeenCalledTimes(1);
  });

  it('does not restore a stored root after a user pick supersedes its validation', async () => {
    const validation = deferred<Project>();
    const stored = option('/old/project', 'Old project');
    const { setRoot } = setup({
      stored,
      resolve: () => validation.promise,
    });
    const folders = await screen.findByRole('group', { name: 'Folders' });
    const helmraiser = within(folders).getByRole('option', { name: 'projects/helmraiser' });

    await userEvent.selectOptions(selector(), helmraiser);
    validation.resolve(stored);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setRoot).toHaveBeenCalledOnce();
    expect(setRoot).toHaveBeenCalledWith(
      '/home/example/projects/helmraiser',
      expect.any(String),
    );
  });

  it('does not restore a stored root after a foreign switch supersedes its validation', async () => {
    const validation = deferred<Project>();
    const stored = option('/old/project', 'Old project');
    const { emit, folder, setRoot } = setup({
      stored,
      resolve: () => validation.promise,
    });
    await screen.findByRole('option', { name: 'FunkyOctopus' });

    emit({
      kind: 'session-changed',
      origin: 'other-tab',
      session: liveSession('/home/example/projects/funkyoctopus'),
    });
    await vi.waitFor(() =>
      expect(folder.get()?.path).toBe(
        '/home/example/projects/funkyoctopus',
      ),
    );
    validation.resolve(stored);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('does not restore a stored root after unmount', async () => {
    const validation = deferred<Project>();
    const stored = option('/old/project', 'Old project');
    const { setRoot, unmount } = setup({
      stored,
      resolve: () => validation.promise,
    });
    await screen.findByRole('option', { name: 'FunkyOctopus' });

    unmount();
    validation.resolve(stored);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('lists the adopted chat\'s folder in the history, not every folder, as it does after the owner picks it', async () => {
    // A reloaded tab: the selector adopts the running chat's folder, and the history must follow it.
    const { listChats, setRoot } = setup({ current: liveSession('/home/example/projects/funkyoctopus') });

    await vi.waitFor(() => expect(listChats).toHaveBeenLastCalledWith('/home/example/projects/funkyoctopus'));
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('lists every folder in the history when the adopted chat is in the global root, as Global does', async () => {
    const { listChats } = setup({ current: liveSession('/home/you/Work') });

    await vi.waitFor(() => expect(selector()).toHaveValue(''));
    // Global is the tab's scope already: it asks for the history of no folder in particular.
    expect(listChats).not.toHaveBeenCalledWith('/home/you/Work');
  });

  it("follows another client's session switch with the history, without re-rooting", async () => {
    const { emit, listChats } = setup({
      current: liveSession('/home/example/projects/funkyoctopus'),
    });
    await vi.waitFor(() => expect(listChats).toHaveBeenLastCalledWith('/home/example/projects/funkyoctopus'));

    emit({
      kind: 'session-changed',
      origin: 'other-tab',
      session: liveSession('/home/example/work/acme-app'),
    });

    await vi.waitFor(() => expect(listChats).toHaveBeenLastCalledWith('/home/example/work/acme-app'));
  });

  it("follows another client's session switch without re-rooting it", async () => {
    const { emit, folder, setRoot } = setup({
      current: liveSession('/home/example/projects/funkyoctopus'),
    });
    await vi.waitFor(() =>
      expect(selector()).toHaveValue('/home/example/projects/funkyoctopus'),
    );

    emit({
      kind: 'session-changed',
      origin: 'other-tab',
      session: liveSession('/home/example/work/acme-app'),
    });

    await vi.waitFor(() =>
      expect(selector()).toHaveValue('/home/example/work/acme-app'),
    );
    expect(folder.get()?.path).toBe('/home/example/work/acme-app');
    expect(setRoot).not.toHaveBeenCalled();
  });

  it('lists Global first, then Known projects and Folders groups', async () => {
    setup();
    const options = await screen.findAllByRole('option');
    expect(options[0]).toHaveAccessibleName('Global · /home/you/Work');
    const group = screen.getByRole('group', { name: 'Known projects' });
    expect(within(group).getAllByRole('option').map((o) => o.textContent)).toEqual(['FunkyOctopus']);
    expect(screen.getByRole('group', { name: 'Folders' })).toBeTruthy();
  });

  it('refreshes the catalog when reopened so newly created folders appear', async () => {
    const { discoverProjects } = setup();
    await screen.findByRole('option', { name: 'projects/helmraiser' });

    const refreshed = catalog();
    refreshed.folders.push(option('/home/example/projects/new-folder'));
    discoverProjects.mockResolvedValue(refreshed);

    await userEvent.click(selector());

    expect(await screen.findByRole('option', { name: 'projects/new-folder' })).toBeInTheDocument();
    expect(discoverProjects).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates folders against known projects and drops the global root', async () => {
    setup();
    const folders = await screen.findByRole('group', { name: 'Folders' });
    const names = within(folders).getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual([
      'projects',
      'projects/helmraiser',
      'work',
      'work/acme-app',
    ]);
  });

  it('labels folders relative to their root so equal basenames stay distinguishable', async () => {
    setup();
    const folders = await screen.findByRole('group', { name: 'Folders' });
    expect(
      within(folders).getAllByRole('option').map((o) => o.textContent),
    ).toEqual(['projects', 'projects/helmraiser', 'work', 'work/acme-app']);
  });

  it('keeps a stored project selectable when it is in neither list', async () => {
    setup({ stored: option('/old/machine/project', 'Old Machine Project') });
    await screen.findByRole('group', { name: 'Folders' });
    expect(
      screen.getByRole('option', { name: 'Old Machine Project' }),
    ).toBeInTheDocument();
    expect(selector()).toHaveValue('/old/machine/project');
  });

  it('picking a folder updates the preference and re-roots exactly once', async () => {
    const { folder, setRoot } = setup();
    await vi.waitFor(() => expect(setRoot).toHaveBeenCalledTimes(1));
    setRoot.mockClear();

    const folders = await screen.findByRole('group', { name: 'Folders' });
    const helmraiser = within(folders).getByRole('option', { name: 'projects/helmraiser' });
    await userEvent.selectOptions(selector(), helmraiser);

    expect(folder.get()?.path).toBe('/home/example/projects/helmraiser');
    await vi.waitFor(() =>
      expect(setRoot).toHaveBeenCalledWith(
        '/home/example/projects/helmraiser',
        expect.any(String),
      ),
    );
    expect(setRoot).toHaveBeenCalledTimes(1);
  });

  it('picking Global clears the active project and re-roots exactly once', async () => {
    const { folder, setRoot } = setup({
      stored: option('/home/example/work/acme-app'),
    });
    await vi.waitFor(() => expect(selector()).toHaveValue('/home/example/work/acme-app'));
    await vi.waitFor(() => expect(setRoot).toHaveBeenCalledTimes(1));
    setRoot.mockClear();

    await userEvent.selectOptions(selector(), screen.getByRole('option', { name: /^Global · / }));

    expect(folder.get()).toBeNull();
    await vi.waitFor(() => expect(setRoot).toHaveBeenCalledWith(null, expect.any(String)));
    expect(setRoot).toHaveBeenCalledTimes(1);
  });

  it('Open folder… resolves a typed path and selects it', async () => {
    const resolve = vi.fn(() => Promise.resolve(option('/somewhere/else', 'Elsewhere')));
    const { folder, setRoot } = setup({ resolve });
    await vi.waitFor(() => expect(setRoot).toHaveBeenCalledOnce());
    setRoot.mockClear();
    await userEvent.selectOptions(selector(), screen.getByRole('option', { name: 'Open folder…' }));

    const input = screen.getByRole('textbox', { name: 'Folder path' });
    await userEvent.type(input, '~/somewhere/else');
    await userEvent.click(screen.getByRole('button', { name: 'OPEN' }));

    expect(resolve).toHaveBeenCalledWith('~/somewhere/else');
    expect(folder.get()?.path).toBe('/somewhere/else');
    await vi.waitFor(() =>
      expect(setRoot).toHaveBeenLastCalledWith('/somewhere/else', expect.any(String)),
    );
    expect(setRoot).toHaveBeenCalledTimes(1);
  });

  it('Open folder… shows the failure message and keeps the form open', async () => {
    const resolve = vi.fn(() => Promise.reject(new Error('no such folder: /gone')));
    setup({ resolve });
    await userEvent.selectOptions(selector(), screen.getByRole('option', { name: 'Open folder…' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Folder path' }), '/gone');
    await userEvent.click(screen.getByRole('button', { name: 'OPEN' }));

    expect(await screen.findByText('no such folder: /gone')).toHaveClass('text-danger');
    expect(screen.getByRole('textbox', { name: 'Folder path' })).toBeInTheDocument();
  });

  it('labels a child folder by its root even when the root itself is a known project', async () => {
    const rootAsKnown: ProjectCatalog = {
      globalRoot: '/home/you/Work',
      known: [
        { id: '/home/example/projects', name: 'projects', path: '/home/example/projects', envTier: 'normal' },
      ],
      folders: [
        { id: '/home/example/projects', name: 'projects', path: '/home/example/projects', envTier: 'normal' },
        { id: '/home/example/projects/child', name: 'child', path: '/home/example/projects/child', envTier: 'normal' },
      ],
    };
    setup({ catalog: rootAsKnown });
    const folders = await screen.findByRole('group', { name: 'Folders' });
    const options = within(folders).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['projects/child']);
  });

  it('does not re-resolve a stable selection on unrelated preference changes', async () => {
    const resolve = vi.fn(() => Promise.resolve(option('/home/example/work/acme-app')));
    const { preferences } = setup({ stored: option('/home/example/work/acme-app'), resolve });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));

    preferences.update({ fontSize: 19 });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('waits for the tab list before restoring, then restores main’s own folder — never another tab’s', async () => {
    const mine = option('/home/example/work/acme-app');
    const { setRoot, tabsArrive, tabFolders } = setup({ stored: mine, current: null, tabsReady: false });
    act(() => tabFolders.forTab('b').set(option('/home/example/projects/helmraiser')));
    await new Promise((r) => setTimeout(r, 20));
    expect(setRoot).not.toHaveBeenCalled();

    tabsArrive();
    await vi.waitFor(() => expect(setRoot).toHaveBeenCalledWith('/home/example/work/acme-app', expect.any(String)));
    expect(setRoot).toHaveBeenCalledTimes(1);
  });

  it('never re-roots a created tab: its folder is already its own on the sidecar', async () => {
    const { setRoot, folder } = setup({ chatId: 'b', stored: option('/home/example/work/acme-app'), current: null });
    await new Promise((r) => setTimeout(r, 30));
    expect(setRoot).not.toHaveBeenCalled();
    expect(folder.get()?.path).toBe('/home/example/work/acme-app');
    expect(selector()).toHaveValue('/home/example/work/acme-app');
  });

  it('clears a stale stored selection that no longer resolves, falling back to global', async () => {
    const { folder, setRoot } = setup({
      stored: option('/home/example/projects/retired-app', 'Old Project'),
      resolve: () =>
        Promise.reject(new WireCallError('no such folder: /home/example/projects/retired-app', FOLDER_NOT_FOUND)),
    });
    await vi.waitFor(() => expect(folder.get()).toBeNull());
    await vi.waitFor(() =>
      expect(setRoot).toHaveBeenLastCalledWith(null, expect.any(String)),
    );
    expect(selector()).toHaveValue('');
  });

  it('keeps the stored selection when resolving fails for another reason, such as a disconnect', async () => {
    const stored = option('/home/example/work/acme-app');
    const resolve = vi.fn(() => Promise.reject(new Error('socket closed')));
    const { folder } = setup({ stored, resolve });
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(folder.get()).toEqual(stored);
  });
});
