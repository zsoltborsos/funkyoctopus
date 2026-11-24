/**
 * Minimal internal session-lifecycle host for PiChat.
 *
 * Lifecycle prerequisite for in-session crew visibility: SDK-created AgentSessions never
 * get extension session lifecycle (session_start/session_shutdown) because the
 * embedded `createAgentSession` path does not bind the extension runner — that
 * is exactly why asynchronous pi-crew crew results never arrived on the
 * production path. Production sessions are therefore owned by pi's public
 * AgentSessionRuntime, which PiChat binds once (headless rpc) and disposes
 * through `dispose()`, so session_shutdown precedes session invalidation.
 *
 * Injected test SessionFactory sessions keep a raw disposal host: they bring
 * their own session (and would otherwise need fake extension internals).
 */

import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionError,
  SessionShutdownEvent,
} from '@earendil-works/pi-coding-agent';

/**
 * Why a live session is torn down, in the words pi's TUI uses for the same
 * action (CURRENT_STATE decision 13): `new` for a new chat, `resume` for an
 * open or folder switch, `quit` only when the slot itself closes. Extensions
 * act on it: pi-crew aborts every subagent on `quit` and keeps them otherwise.
 * Derived from pi's own union, so a pi that drops one fails to compile here.
 */
export type TeardownReason = Extract<SessionShutdownEvent['reason'], 'quit' | 'new' | 'resume'>;

/** The lifecycle surface PiChat needs from the owner of a live pi session. */
export interface SessionHost {
  /** The live AgentSession (stable for the host's lifetime). */
  readonly session: AgentSession;
  /**
   * Idempotent teardown of the live session; never constructs. `targetSessionFile`
   * names the session being switched to, when there is one.
   */
  dispose(reason?: TeardownReason, targetSessionFile?: string): Promise<void>;
}

/**
 * The AgentSessionRuntime replacement factory, unreachable by design.
 *
 * PiChat owns session replacement (buildManager/create/continue/open and its
 * own swap semantics) and never delegates it to AgentSessionRuntime. Any
 * invocation of the runtime's /new,/resume,/fork,import machinery reaches this
 * factory and must fail loudly rather than silently replacing the session
 * behind PiChat's back.
 */
export function unreachableSessionReplacementFactory(): CreateAgentSessionRuntimeFactory {
  return () =>
    Promise.reject(
      new Error(
        'session replacement factory is unreachable: PiChat owns session replacement ' +
          '(buildManager/create/continue/open and swap); AgentSessionRuntime replacement ' +
          'must never be invoked.',
      ),
    );
}

/**
 * Production session host: pi's public AgentSessionRuntime wrapped, with the
 * extension runner bound exactly once to the headless rpc binding.
 *
 * Without `bindExtensions()`, an SDK session never fires session_start or
 * session_shutdown, so pi-crew's CrewRuntime.activeBinding is never set and
 * asynchronous crew results are never delivered (the crew-visibility
 * blocker). The binding carries no UI, command, or action context — only a
 * bounded onError logger.
 */
export class RuntimeSessionHost implements SessionHost {
  private disposed = false;

  private constructor(private readonly runtime: AgentSessionRuntime) {}

  /** Bind the extension runner once (rpc mode, bounded onError), then wrap. */
  static async create(
    runtime: AgentSessionRuntime,
    onError: (error: ExtensionError) => void,
  ): Promise<RuntimeSessionHost> {
    const host = new RuntimeSessionHost(runtime);
    try {
      await runtime.session.bindExtensions({ mode: 'rpc', onError });
    } catch (error) {
      // The runtime was built but bound nothing usable; tear it down so a
      // failed creation cannot leak a live session, then propagate. As `new`:
      // `quit` makes pi-crew abort every subagent, the crew slot's left-running
      // ones included.
      await host.dispose('new');
      throw error;
    }
    return host;
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  /**
   * Session teardown: session_shutdown is emitted before the session is
   * invalidated. Idempotent.
   *
   * `quit` goes through the runtime's own dispose(), which hard-codes that
   * reason. Any other reason does what pi's replacement paths do, through
   * public API: the same event with that reason through the extension runner
   * (skipped when nothing listens, as pi skips it), then `session.dispose()`.
   * pi's replacement teardown also aborts first, which PiChat.disposeHost does
   * before calling this, and runs `beforeSessionInvalidate`, a hook FO never
   * sets (T2.0 spike). Settling credential writes is quit-only in pi as well.
   */
  async dispose(reason: TeardownReason = 'quit', targetSessionFile?: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (reason === 'quit') {
      await this.runtime.dispose();
      return;
    }
    const session = this.runtime.session;
    if (session.extensionRunner.hasHandlers('session_shutdown')) {
      await session.extensionRunner.emit({
        type: 'session_shutdown',
        reason,
        ...(targetSessionFile !== undefined ? { targetSessionFile } : {}),
      });
    }
    session.dispose();
  }
}

/**
 * Test/injected-session host: raw disposal, no extension binding.
 *
 * Used only for sessions produced by the injected SessionFactory (the
 * deterministic test seam); production sessions always take RuntimeSessionHost.
 */
export class RawSessionHost implements SessionHost {
  private disposed = false;

  constructor(private readonly inner: AgentSession) {}

  get session(): AgentSession {
    return this.inner;
  }

  /** The reason is ignored: an injected session has no extension runner bound. */
  dispose(_reason?: TeardownReason, _targetSessionFile?: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.inner.dispose();
    return Promise.resolve();
  }
}
