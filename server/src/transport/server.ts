import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { MethodRegistry } from './registry.ts';
import {
  WS_PATH,
  type ClientMessage,
  type ServerMessage,
  type WireError,
} from '../../../src/shared/transport/protocol.ts';
import { wireErrorCode } from '../../../src/shared/transport/errors.ts';

// Only the routing envelope is validated here; params belong to the method.
function isClientMessage(value: unknown): value is ClientMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.id === 'string' && (
    msg.kind === 'cancel' || (msg.kind === 'request' && typeof msg.method === 'string')
  );
}

/**
 * Envelope for a thrown value. A seam's typed code (`WireCallError`) rides
 * along so the browser can name the missing backend; the key is omitted
 * entirely when there is no code, keeping untyped failures the shape they
 * always had.
 */
function toWireError(e: unknown): WireError {
  const message = e instanceof Error ? e.message : String(e);
  const code = wireErrorCode(e);
  return code === undefined ? { message } : { message, code };
}

/**
 * Route-level Origin guard: the browser may connect only
 * when its Origin exactly matches `allowedOrigins`. Runs as preValidation,
 * before the connection is upgraded, so a rejected Origin never reaches the
 * socket handler below. An absent Origin stays allowed for trusted
 * non-browser local automation; `Origin: null` and foreign Origins get HTTP
 * 403. No wildcards, tokens, or path policy — this is a narrow browser guard.
 */
function originGuard(allowedOrigins: readonly string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (origin === undefined) return; // non-browser automation
    if (!Array.isArray(origin) && allowedOrigins.includes(origin)) return;
    // An async hook is required: a synchronous two-arg hook never invokes the
    // runner's `next`, so a passing request would hang before the upgrade.
    await reply.code(403).send();
  };
}

/**
 * Bridges one WebSocket route onto the method registry. Each socket keeps its
 * own table of in-flight AbortControllers so a client can cancel a stream — or
 * a disconnect can abort everything — without leaking work.
 */
export function attachTransport(
  app: FastifyInstance,
  registry: MethodRegistry,
  allowedOrigins: readonly string[],
): void {
  app.get(
    WS_PATH,
    {
      websocket: true,
      preValidation: originGuard(allowedOrigins),
    },
    (socket: WebSocket) => {
      const inflight = new Map<string, AbortController>();

      const send = (msg: ServerMessage): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      };

      const handle = async (msg: ClientMessage): Promise<void> => {
        if (msg.kind === 'cancel') {
          inflight.get(msg.id)?.abort();
          return;
        }

        const entry = registry.get(msg.method);
        const ac = new AbortController();
        inflight.set(msg.id, ac);
        try {
          if (!entry) {
            throw new Error(`Unknown method: ${msg.method}`);
          }
          if (entry.kind === 'call') {
            const result = await entry.handler(msg.params, { signal: ac.signal });
            send({ kind: 'response', id: msg.id, ok: true, result });
          } else {
            for await (const chunk of entry.handler(msg.params, { signal: ac.signal })) {
              if (ac.signal.aborted) break;
              send({ kind: 'stream', id: msg.id, chunk });
            }
            send({ kind: 'stream-end', id: msg.id });
          }
        } catch (e) {
          const error = toWireError(e);
          if (entry?.kind === 'stream') {
            send({ kind: 'stream-end', id: msg.id, error });
          } else {
            send({ kind: 'response', id: msg.id, ok: false, error });
          }
        } finally {
          inflight.delete(msg.id);
        }
      };

      socket.on('message', (raw) => {
        const text = Buffer.isBuffer(raw)
          ? raw.toString('utf8')
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw).toString('utf8');
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return; // ignore malformed frames
        }
        if (!isClientMessage(msg)) return;
        void handle(msg);
      });

      socket.on('close', () => {
        for (const ac of inflight.values()) {
          ac.abort();
        }
        inflight.clear();
      });
    },
  );
}
