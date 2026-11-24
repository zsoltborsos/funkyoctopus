import type { WireCalls } from '../../../src/shared/transport/protocol.ts';

/**
 * The method table the transport dispatches against. Seams register handlers
 * here at boot; the transport never knows what a method does, only how to route
 * to it. Two shapes: `call` resolves one value, `stream` yields many.
 *
 * Params arrive as `unknown` — the wire can't be trusted — so each handler
 * validates and narrows its own input at the boundary.
 */

export interface CallContext {
  /** Aborted when the client cancels or disconnects mid-flight. */
  readonly signal: AbortSignal;
}

export type CallHandler = (params: unknown, ctx: CallContext) => unknown;
export type StreamHandler = (params: unknown, ctx: CallContext) => AsyncIterable<unknown>;

type WireCallHandler<M extends keyof WireCalls> = (
  params: WireCalls[M]['params'],
  ctx: CallContext,
) => WireCalls[M]['result'] | Promise<WireCalls[M]['result']>;

interface CallEntry {
  readonly kind: 'call';
  readonly handler: CallHandler;
}
interface StreamEntry {
  readonly kind: 'stream';
  readonly handler: StreamHandler;
}
export type MethodEntry = CallEntry | StreamEntry;

export class MethodRegistry {
  private readonly methods = new Map<string, MethodEntry>();

  call<M extends keyof WireCalls>(name: M, handler: WireCallHandler<M>): this {
    this.assertFree(name);
    // The table is deliberately erased at this one boundary: incoming params
    // remain untrusted, and seam handlers still perform runtime validation.
    this.methods.set(name, { kind: 'call', handler: handler as unknown as CallHandler });
    return this;
  }

  stream(name: string, handler: StreamHandler): this {
    this.assertFree(name);
    this.methods.set(name, { kind: 'stream', handler });
    return this;
  }

  get(name: string): MethodEntry | undefined {
    return this.methods.get(name);
  }

  names(): string[] {
    return [...this.methods.keys()];
  }

  private assertFree(name: string): void {
    if (this.methods.has(name)) {
      throw new Error(`Transport method already registered: ${name}`);
    }
  }
}
