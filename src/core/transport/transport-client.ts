import { token } from '@core/container/container.ts';
import type {
  ClientMessage,
  ServerMessage,
  WireError,
  WireCalls,
  WireStreams,
} from '@shared/transport/protocol.ts';
import { WireCallError } from '@shared/transport/errors.ts';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** Minimal surface of a WebSocket the client depends on — lets tests inject a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface StreamHandlers {
  onChunk: (chunk: unknown) => void;
  onEnd: (error?: WireError) => void;
}

interface StreamEntry {
  handlers: StreamHandlers;
  /**
   * True once the stream's request frame was actually written to the socket.
   * A queued request (socket still connecting) has never reached the server,
   * so cancelling it must drop the queued frame instead of sending a cancel.
   */
  dispatched: boolean;
}

const OPEN = 1;
const RECONNECT_DELAY_MS = 1000;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/**
 * The browser's single line to the sidecar. Owns one reconnecting WebSocket and
 * multiplexes every seam's calls and streams over it, correlating replies by id.
 * Seam clients depend on this, never on the raw socket — so the whole transport
 * can be swapped or faked in one place.
 */
export class TransportClient {
  private socket: SocketLike | null = null;
  private seq = 0;
  private state: ConnectionState = 'closed';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  /**
   * Requests raised before the socket finished opening.
   *
   * Every seam client fetches on mount — projects, models, chat history — and a
   * page load races the WebSocket handshake. Rejecting those (as this used to)
   * meant each caller's `.catch` quietly produced an empty list, so a refresh
   * intermittently came up with no projects and no models until something
   * remounted and refetched. Queue instead, and flush on open.
   */
  private outbox: ClientMessage[] = [];

  private readonly pending = new Map<string, PendingCall>();
  private readonly streams = new Map<string, StreamEntry>();
  private readonly stateListeners = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly createSocket: SocketFactory = (u) => new WebSocket(u) as unknown as SocketLike,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.outbox = [];
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
  }

  getState = (): ConnectionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  /** Invoke a typed request/response method and await its mapped result. */
  call<M extends keyof WireCalls>(
    method: M,
    ...[params]: undefined extends WireCalls[M]['params']
      ? [params?: WireCalls[M]['params']]
      : [params: WireCalls[M]['params']]
  ): Promise<WireCalls[M]['result']> {
    const id = this.nextId();
    return new Promise<WireCalls[M]['result']>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.dispatch({ kind: 'request', id, method, params });
    });
  }

  /** Invoke a typed `stream` method; returns a cancel function. */
  stream<M extends keyof WireStreams>(
    method: M,
    params: WireStreams[M]['params'],
    handlers: StreamHandlers,
  ): () => void {
    const id = this.nextId();
    this.streams.set(id, { handlers, dispatched: false });
    this.dispatch({ kind: 'request', id, method, params });
    return () => {
      const entry = this.streams.get(id);
      if (!entry) {
        return;
      }
      this.streams.delete(id);
      if (entry.dispatched) {
        // The request reached the server; tell it to stop the stream.
        this.dispatch({ kind: 'cancel', id });
      } else {
        // The request never left the outbox: drop the exact queued frame so
        // neither a request nor a cancel ever reaches the server — no zombie.
        this.outbox = this.outbox.filter(
          (msg) => !(msg.kind === 'request' && msg.id === id),
        );
      }
    };
  }

  // --- internals ---

  private nextId(): string {
    this.seq += 1;
    return `${this.seq}`;
  }

  private open(): void {
    this.setState('connecting');
    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.setState('open');
      this.flush();
    };
    socket.onmessage = (ev) => this.receive(ev.data);
    socket.onerror = () => socket.close();
    socket.onclose = () => this.handleClose();
  }

  private flush(): void {
    const queued = this.outbox;
    this.outbox = [];
    for (const msg of queued) {
      this.dispatch(msg);
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.setState('closed');
    this.outbox = [];
    this.failAllInflight(new Error('Transport disconnected'));
    if (!this.closedByUser) {
      this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_DELAY_MS);
    }
  }

  private dispatch(msg: ClientMessage): void {
    if (this.socket && this.socket.readyState === OPEN) {
      this.socket.send(JSON.stringify(msg));
      // Only a frame that actually went over the wire counts as dispatched —
      // the outbox flush also funnels through here, so queued requests get
      // marked the moment they are really sent.
      if (msg.kind === 'request') {
        const stream = this.streams.get(msg.id);
        if (stream) stream.dispatched = true;
      }
      return;
    }
    // Still connecting, or waiting on a scheduled reconnect: hold the message
    // and send it on open. `handleClose` clears the queue and rejects everything
    // in flight, so a queued request fails loudly rather than hanging forever
    // once a connection attempt actually fails.
    if (!this.closedByUser) {
      this.outbox.push(msg);
      return;
    }
    // Deliberately disconnected: nothing is coming, so reject rather than
    // silently drop; streams surface the same via onEnd.
    if (msg.kind === 'request') {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        pending.reject(new Error('Transport not connected'));
      }
      const stream = this.streams.get(msg.id);
      if (stream) {
        this.streams.delete(msg.id);
        stream.handlers.onEnd({ message: 'Transport not connected' });
      }
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      return;
    }
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'response': {
        const pending = this.pending.get(msg.id);
        if (!pending) {
          return;
        }
        this.pending.delete(msg.id);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(
            new WireCallError(msg.error?.message ?? 'Request failed', msg.error?.code),
          );
        }
        return;
      }
      case 'stream': {
        this.streams.get(msg.id)?.handlers.onChunk(msg.chunk);
        return;
      }
      case 'stream-end': {
        const stream = this.streams.get(msg.id);
        if (!stream) {
          return;
        }
        this.streams.delete(msg.id);
        stream.handlers.onEnd(msg.error);
        return;
      }
    }
  }

  private failAllInflight(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.handlers.onEnd({ message: error.message });
    }
    this.streams.clear();
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    for (const listener of this.stateListeners) {
      listener();
    }
  }
}

export const TRANSPORT = token<TransportClient>('TransportClient');

/** Inputs `sidecarUrl` reads; injected by tests so browser globals stay alone. */
export interface SidecarUrlInputs {
  /** VITE_SIDECAR_URL at build time; wins over everything. */
  readonly override: string | undefined;
  /** True when the page is served by Vite's dev server. */
  readonly dev: boolean;
  /** Page protocol ('http:' | 'https:'); only read when not dev. */
  readonly protocol: string;
  /** Page host including port; only read when not dev. */
  readonly host: string;
}

/** The explicit sidecar URL Vite dev connects to (the dev-sidecar port). */
const DEV_SIDECAR_URL = 'ws://127.0.0.1:14788/ws';

/**
 * Default sidecar URL. `VITE_SIDECAR_URL` still wins; otherwise a page served
 * by the sidecar itself (not Vite dev) reaches the WebSocket through its own
 * origin, and Vite dev uses the explicit development URL.
 */
export function sidecarUrl(inputs?: Partial<SidecarUrlInputs>): string {
  const merged: SidecarUrlInputs = {
    override: import.meta.env.VITE_SIDECAR_URL as string | undefined,
    dev: import.meta.env.DEV,
    protocol: globalThis.location?.protocol ?? 'http:',
    host: globalThis.location?.host ?? '127.0.0.1:14787',
    ...inputs,
  };
  if (merged.override) {
    return merged.override;
  }
  if (merged.dev) {
    return DEV_SIDECAR_URL;
  }
  const scheme = merged.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${merged.host}/ws`;
}
