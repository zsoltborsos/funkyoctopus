import type {
  ClientMessage,
  ServerMessage,
  WireCalls,
  WireStreams,
  WireError,
} from '../../../src/shared/transport/protocol.ts';
import { WireCallError } from '../../../src/shared/transport/errors.ts';

/**
 * A refused or failed WebSocket connection to the sidecar. Distinct from
 * `WireCallError` so `fo` can map it to "the sidecar is not running"
 * (exit 3) instead of a generic wire failure (exit 1).
 */
export class SidecarUnreachable extends Error {
  /** The URL the connection was attempted against. */
  readonly url: string;

  constructor(url: string, cause?: unknown) {
    super(`sidecar not running at ${url} (start it with npm run dev:all)`);
    this.name = 'SidecarUnreachable';
    this.url = url;
    // Node records the underlying reason on `error.cause` without changing
    // the message; only set it when the caller actually had one
    // (`exactOptionalPropertyTypes` forbids assigning undefined).
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** A call exceeded its time budget. The only cause fo maps to exit 124. */
export class CallTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`call timed out after ${timeoutMs} ms`);
    this.name = 'CallTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

interface Pending {
  /** Routed server frames for this id. */
  onMessage: (msg: ServerMessage) => void;
  /** Connection failure fan-out for this id. */
  onFail: (e: Error) => void;
}

type GlobalWebSocket = InstanceType<(typeof globalThis)['WebSocket']>;

/**
 * The one-connection, no-reconnect client `fo` speaks the sidecar with. Frames
 * match the browser's exactly (`src/core/transport/transport-client.ts`):
 * `{kind:'request', id, method, params}` out; `response`, `stream` and
 * `stream-end` in; `{kind:'cancel', id}` aborts. One process, one connection —
 * failure rejects pending work instead of reconnecting.
 */
export class FoClient {
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly socket: GlobalWebSocket;

  private constructor(socket: GlobalWebSocket) {
    this.socket = socket;
    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('close', this.onSocketLost);
    socket.addEventListener('error', this.onSocketLost);
  }

  /** Open one socket; resolves only after the handshake, rejects on refused/failed. */
  static connect(url: string): Promise<FoClient> {
    return new Promise((resolve, reject) => {
      let socket: GlobalWebSocket;
      try {
        socket = new WebSocket(url);
      } catch (e) {
        reject(new SidecarUnreachable(url, e));
        return;
      }
      const onOpen = (): void => {
        cleanup();
        resolve(new FoClient(socket));
      };
      const onFailure = (): void => {
        cleanup();
        reject(new SidecarUnreachable(url));
      };
      const cleanup = (): void => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onFailure);
        socket.removeEventListener('close', onFailure);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onFailure);
      socket.addEventListener('close', onFailure);
    });
  }

  /** One typed request/response round-trip from the shared wire contract. */
  call<M extends keyof WireCalls>(
    method: M,
    params: WireCalls[M]['params'],
    timeoutMs = 30_000,
  ): Promise<WireCalls[M]['result']> {
    return this.callRaw<WireCalls[M]['result']>(method, params, timeoutMs);
  }

  /**
   * Untyped round-trip reserved for `fo call <method> [json]` and its tests.
   * Resolves the result on `ok:true`, rejects `WireCallError` on `ok:false`,
   * `CallTimeoutError` after `timeoutMs` (which also sends a cancel frame), and
   * `SidecarUnreachable` when the connection dies first.
   */
  callRaw<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (): void => {
        finished = true;
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const id = this.allocate();
      const resolveNow = (value: T): void => {
        if (finished) return;
        finish();
        resolve(value);
      };
      const rejectNow = (e: Error): void => {
        if (finished) return;
        finish();
        reject(e);
      };
      const record: Pending = {
        onMessage: (msg) => {
          if (msg.kind !== 'response') return;
          if (msg.ok) resolveNow(msg.result as T);
          else rejectNow(toWireCallError(msg.error));
        },
        onFail: rejectNow,
      };
      this.pending.set(id, record);
      const timer = setTimeout(() => {
        void this.send({ kind: 'cancel', id });
        rejectNow(new CallTimeoutError(timeoutMs));
      }, timeoutMs);
      void this.send({ kind: 'request', id, method, params });
    });
  }

  /**
   * One server→client stream. Chunks go to `onChunk` as they arrive; the
   * promise resolves on a clean `stream-end` and rejects `WireCallError`
   * when the end carries an error. Aborting sends exactly one cancel frame
   * and keeps the stream pending until the terminal `stream-end` (or the
   * socket dies). A stream never times out.
   */
  stream<M extends keyof WireStreams>(
    method: M,
    params: WireStreams[M]['params'],
    onChunk: (chunk: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.streamRaw(method, params, onChunk, signal);
  }

  /** `stream` for any method name, untyped (as `callRaw` is for calls). */
  streamRaw(
    method: string,
    params: unknown,
    onChunk: (chunk: unknown) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new WireCallError('stream cancelled before it started'));
        return;
      }
      let finished = false;
      let cancelSent = false;
      const onAbort = (): void => {
        sendCancelOnce();
      };
      const sendCancelOnce = (): void => {
        if (!cancelSent) {
          cancelSent = true;
          void this.send({ kind: 'cancel', id });
        }
      };
      const finish = (): void => {
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const resolveNow = (): void => {
        if (finished) return;
        finish();
        resolve();
      };
      const rejectNow = (e: Error): void => {
        if (finished) return;
        finish();
        reject(e);
      };
      const id = this.allocate();
      const record: Pending = {
        onMessage: () => undefined,
        onFail: rejectNow,
      };
      this.pending.set(id, record);
      signal?.addEventListener('abort', onAbort, { once: true });
      record.onMessage = (msg) => {
        if (msg.kind === 'stream') {
          try {
            onChunk(msg.chunk);
          } catch {
            // A throwing consumer must not wedge the router; keep draining.
          }
        } else if (msg.kind === 'stream-end') {
          if (msg.error) rejectNow(toWireCallError(msg.error));
          else resolveNow();
        } else if (msg.kind === 'response' && !msg.ok) {
          // The transport answers an unknown method with a call-shaped reply
          // even for a stream request — surface it as the stream's failure.
          rejectNow(toWireCallError(msg.error));
        }
      };
      void this.send({ kind: 'request', id, method, params });
    });
  }

  /** Close the socket; anything still pending fails with `SidecarUnreachable`. */
  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed — closing is meant to be idempotent
    }
    this.failPending(new SidecarUnreachable(this.socket.url));
  }

  /** Route a frame to its pending record; ignore malformed/unknown frames. */
  private readonly onMessage = (event: { data: unknown }): void => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }
    // Valid JSON that is not a frame (null, a string, a number) is ignored,
    // same as malformed JSON.
    if (typeof msg !== 'object' || msg === null) return;
    const id = (msg as { id?: unknown }).id;
    if (typeof id !== 'string') return;
    const record = this.pending.get(id);
    if (!record) return;
    record.onMessage(msg);
  };

  /** A post-connect socket failure or close rejects everything still pending. */
  private readonly onSocketLost = (): void => {
    this.failPending(new SidecarUnreachable(this.socket.url));
  };

  /** IDs are per-connection only: correlation never leaves this process. */
  private allocate(): string {
    this.nextId += 1;
    return String(this.nextId);
  }

  private send(msg: ClientMessage): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.failPending(new SidecarUnreachable(this.socket.url));
      return;
    }
    try {
      this.socket.send(JSON.stringify(msg));
    } catch (e) {
      this.failPending(new SidecarUnreachable(this.socket.url, e));
    }
  }

  private failPending(e: Error): void {
    for (const record of this.pending.values()) {
      record.onFail(e);
    }
    this.pending.clear();
  }
}

function toWireCallError(error?: WireError): WireCallError {
  return new WireCallError(error?.message ?? 'unknown wire error', error?.code);
}
