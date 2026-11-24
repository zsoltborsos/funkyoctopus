import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Container } from '@core/container/container.ts';
import { ContainerProvider } from '@core/container/ContainerContext.tsx';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PREFERENCES, PreferencesService } from '@features/settings/preferences.service.ts';
import { SettingsPanel } from '@features/settings/SettingsPanel.tsx';
import { SystemClient } from '@features/status/system.client.ts';
import type { WorkflowClient } from './workflow.client.ts';
import { HelmraiserNotifications, type ConnectionSurface } from './helmraiser-notifications.service.ts';
import type { HelmraiserEvent } from '@shared/transport/protocol.ts';

// --- fakes ---

const AWAITING: HelmraiserEvent = {
  kind: 'helmraiser-event',
  event: 'awaiting',
  runId: 'r1',
  task: 't',
  title: 'Prepare the release',
};
const FAILED: HelmraiserEvent = { ...AWAITING, event: 'failed', runId: 'r2', title: 'Build broke' };
const LANDED: HelmraiserEvent = { ...AWAITING, event: 'landed', runId: 'r3', title: 'Release shipped' };

interface FakeNotification {
  title: string;
  body: string;
  onclick: (() => void) | null;
}

/**
 * Controllable Notification global: captured instances plus static
 * permission/request behaviour the tests can shape per case.
 */
function stubNotification(options: { permission?: string; requestResult?: string; supported?: boolean } = {}): {
  notifications: FakeNotification[];
  requestPermission: ReturnType<typeof vi.fn<() => Promise<string>>>;
} {
  const notifications: FakeNotification[] = [];
  const requestPermission = vi.fn(() =>
    Promise.resolve(options.requestResult ?? options.permission ?? 'default'));
  const Notification: typeof globalThis.Notification = function FakeNotificationCtor(
    title: string,
    init?: { body?: string },
  ) {
    notifications.push({ title, body: init?.body ?? '', onclick: null });
    return notifications[notifications.length - 1];
  } as unknown as typeof globalThis.Notification;
  Object.defineProperty(Notification, 'permission', { value: options.permission ?? 'default' });
  Object.defineProperty(Notification, 'requestPermission', { value: requestPermission });
  if (options.supported !== false) vi.stubGlobal('Notification', Notification);
  return { notifications, requestPermission };
}

/** One connection surface the test toggles to simulate reconnects. */
function connectionSurface(initial: 'open' | 'closed' = 'open'): ConnectionSurface & {
  set: (state: 'open' | 'closed') => void;
} {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (next) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

interface Harness {
  stub: ReturnType<typeof stubNotification>;
  preferences: PreferencesService;
  observerCount: () => number;
  /** Delivers an event to the one live observer, if any. */
  push: (event: HelmraiserEvent) => void;
  setHealth: (health: { desktopNotifications?: true } | undefined) => void;
  /** Settles the oldest held health read (only with `holdHealth: true`). */
  settleHealth: (health?: { desktopNotifications?: true }) => void;
  setConnection: (state: 'open' | 'closed') => void;
  openJobs: ReturnType<typeof vi.fn>;
  stop: () => void;
}

/** Builds the service against fakes and starts it (the hook's effect, by hand). */
function serviceHarness(options: {
  permission?: string;
  supported?: boolean;
  health?: { desktopNotifications?: true };
  healthRejects?: boolean;
  /** Health reads stay pending until `settleHealth` answers them, oldest first. */
  holdHealth?: boolean;
} = {}): Harness {
  const stub = stubNotification(options);
  const preferences = new PreferencesService(new MemoryStorageAdapter());
  const observers: ((event: HelmraiserEvent) => void)[] = [];
  const workflow = {
    observe: (handlers: { onEvent: (event: HelmraiserEvent) => void }) => {
      observers.push(handlers.onEvent);
      return () => {
        const index = observers.indexOf(handlers.onEvent);
        if (index >= 0) observers.splice(index, 1);
      };
    },
  } as unknown as WorkflowClient;
  let healthAnswer: { desktopNotifications?: true } | undefined = options.health;
  const defaultHealth = {
    ok: true as const,
    service: 'funkyoctopus-sidecar' as const,
    version: '0',
    uptimeMs: 0,
    backends: {},
  };
  const pendingHealth: ((health: typeof defaultHealth) => void)[] = [];
  const system = {
    health: () => {
      if (options.healthRejects) return Promise.reject(new Error('health unavailable'));
      if (options.holdHealth) {
        return new Promise<typeof defaultHealth>((resolve) => {
          pendingHealth.push(resolve);
        });
      }
      return Promise.resolve(healthAnswer ?? defaultHealth);
    },
  } as unknown as SystemClient;
  const connection = connectionSurface('open');
  const openJobs = vi.fn();
  const service = new HelmraiserNotifications(workflow, system, preferences, connection);
  const stop = service.start(openJobs);
  return {
    stub,
    preferences,
    observerCount: () => observers.length,
    push: (event) => observers[0]?.(event),
    setHealth: (health) => {
      healthAnswer = health;
    },
    settleHealth: (health) => {
      pendingHealth.shift()?.({ ...defaultHealth, ...health });
    },
    setConnection: connection.set,
    openJobs,
    stop,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Helmraiser browser notifications', () => {
  it('defaults the preference to false and persists through PreferencesService', () => {
    const preferences = new PreferencesService(new MemoryStorageAdapter());
    expect(preferences.get().notifyHelmraiser).toBe(false);
    preferences.update({ notifyHelmraiser: true });
    expect(preferences.get().notifyHelmraiser).toBe(true);
    preferences.update({ notifyHelmraiser: false });
    expect(preferences.get().notifyHelmraiser).toBe(false);
  });

  it('the Settings toggle requests permission and enables only after granted', async () => {
    const user = userEvent.setup();
    // Default permission: clicking asks, and a granted answer enables.
    const storage = new MemoryStorageAdapter();
    const preferences = new PreferencesService(storage);
    const container = new Container();
    container.registerInstance(PREFERENCES, preferences);
    const stub = stubNotification({ permission: 'default', requestResult: 'granted' });
    render(
      <ContainerProvider container={container}>
        <SettingsPanel />
      </ContainerProvider>,
    );
    const toggle = screen.getByRole('switch', { name: 'Notify me about Helmraiser runs' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    expect(stub.requestPermission).toHaveBeenCalledOnce();
    expect(preferences.get().notifyHelmraiser).toBe(true);
    cleanup();
    vi.unstubAllGlobals();

    // A denied answer leaves it off, and off is persisted immediately.
    const deniedPrefs = new PreferencesService(new MemoryStorageAdapter());
    const deniedContainer = new Container();
    deniedContainer.registerInstance(PREFERENCES, deniedPrefs);
    const denied = stubNotification({ permission: 'default', requestResult: 'denied' });
    render(
      <ContainerProvider container={deniedContainer}>
        <SettingsPanel />
      </ContainerProvider>,
    );
    await user.click(screen.getByRole('switch', { name: 'Notify me about Helmraiser runs' }));
    expect(denied.requestPermission).toHaveBeenCalledOnce();
    expect(deniedPrefs.get().notifyHelmraiser).toBe(false);
    cleanup();
    vi.unstubAllGlobals();

    // Already-granted permission enables without asking again.
    const grantedPrefs = new PreferencesService(new MemoryStorageAdapter());
    const grantedContainer = new Container();
    grantedContainer.registerInstance(PREFERENCES, grantedPrefs);
    const granted = stubNotification({ permission: 'granted' });
    render(
      <ContainerProvider container={grantedContainer}>
        <SettingsPanel />
      </ContainerProvider>,
    );
    await user.click(screen.getByRole('switch', { name: 'Notify me about Helmraiser runs' }));
    expect(granted.requestPermission).not.toHaveBeenCalled();
    expect(grantedPrefs.get().notifyHelmraiser).toBe(true);
  });

  it('an awaiting event produces the exact approval title and body', async () => {
    const h = serviceHarness({ permission: 'granted' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(AWAITING);
    expect(h.stub.notifications[0]).toMatchObject({
      title: 'Helmraiser: approval needed',
      body: 'Prepare the release',
    });
    h.stop();
  });

  it('a failed event produces the exact failed title and body', async () => {
    const h = serviceHarness({ permission: 'granted' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(FAILED);
    expect(h.stub.notifications[0]).toMatchObject({
      title: 'Helmraiser: run failed',
      body: 'Build broke',
    });
    h.stop();
  });

  it('a landed event produces the exact landed title and body', async () => {
    const h = serviceHarness({ permission: 'granted' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(LANDED);
    expect(h.stub.notifications[0]).toMatchObject({
      title: 'Helmraiser: run landed',
      body: 'Release shipped',
    });
    // Clicking lands in the Jobs view, as for the other events.
    const notification = h.stub.notifications[0];
    notification?.onclick?.();
    expect(h.openJobs).toHaveBeenCalledOnce();
    h.stop();
  });

  it('clicking the notification focuses the window and opens Jobs', async () => {
    const h = serviceHarness({ permission: 'granted' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    const focus = vi.spyOn(window, 'focus').mockReturnValue(undefined);
    h.push(AWAITING);
    const notification = h.stub.notifications[0];
    notification?.onclick?.();
    expect(focus).toHaveBeenCalledOnce();
    expect(h.openJobs).toHaveBeenCalledOnce();
    h.stop();
  });

  it('shows nothing while the preference is off', async () => {
    const h = serviceHarness({ permission: 'granted' });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(AWAITING);
    h.push(FAILED);
    expect(h.stub.notifications).toEqual([]);
    h.stop();
  });

  it('shows nothing when health reports desktop notifications', async () => {
    const h = serviceHarness({ permission: 'granted', health: { desktopNotifications: true } });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(AWAITING);
    expect(h.stub.notifications).toEqual([]);
    h.stop();
  });

  it('a failing health read treats desktop notifications as not reported', async () => {
    const h = serviceHarness({ permission: 'granted', healthRejects: true });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(AWAITING);
    expect(h.stub.notifications[0]).toMatchObject({ title: 'Helmraiser: approval needed' });
    h.stop();
  });

  it('shows nothing when permission is not granted', async () => {
    const h = serviceHarness({ permission: 'default' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(FAILED);
    expect(h.stub.notifications).toEqual([]);
    h.stop();
  });

  it('a dropped connection cancels the stream; reconnect replaces, not duplicates', async () => {
    const h = serviceHarness({ permission: 'granted' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.setConnection('closed');
    expect(h.observerCount()).toBe(0);
    h.setConnection('open');
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.push(FAILED);
    expect(h.stub.notifications[0]).toMatchObject({
      title: 'Helmraiser: run failed',
      body: 'Build broke',
    });
    h.stop();
  });

  it('cleanup cancels the stream and a later reconnect wires nothing', async () => {
    const h = serviceHarness({ permission: 'granted' });
    h.preferences.update({ notifyHelmraiser: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    h.stop();
    expect(h.observerCount()).toBe(0);
    h.setConnection('closed');
    h.setConnection('open');
    await Promise.resolve();
    expect(h.observerCount()).toBe(0);
  });

  it('an in-flight health read from a dropped connection cannot open the new stream', async () => {
    const h = serviceHarness({ permission: 'granted', holdHealth: true });
    h.preferences.update({ notifyHelmraiser: true });
    // The first connection's health read is still in flight when it drops and
    // the transport reconnects.
    h.setConnection('closed');
    h.setConnection('open');
    await Promise.resolve();
    expect(h.observerCount()).toBe(0);
    // The stale read resolves late: it must not open a stream of its own.
    h.settleHealth();
    await Promise.resolve();
    expect(h.observerCount()).toBe(0);
    // The reconnect's own read opens exactly one stream.
    h.settleHealth({ desktopNotifications: true });
    await vi.waitFor(() => expect(h.observerCount()).toBe(1));
    // And the reported health is the live read's, not the stale one's.
    h.push(AWAITING);
    expect(h.stub.notifications).toEqual([]);
    h.stop();
    expect(h.observerCount()).toBe(0);
  });

  it('a stale health read cannot survive cleanup and open a stream afterwards', async () => {
    const h = serviceHarness({ permission: 'granted', holdHealth: true });
    h.preferences.update({ notifyHelmraiser: true });
    h.stop();
    h.settleHealth();
    await Promise.resolve();
    expect(h.observerCount()).toBe(0);
  });
});
