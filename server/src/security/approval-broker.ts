import { randomUUID } from 'node:crypto';
import type { ChatChunk } from '../../../src/shared/transport/protocol.ts';
import type { VaultEscalation } from './vault.ts';

interface PendingApproval {
  resolve: (approved: boolean) => void;
  removeAbort?: () => void;
}

/** Suspends only Vault escalations and resolves them from the browser response. */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private emit: ((chunk: ChatChunk) => void) | null = null;
  private readonly listeners = new Set<(chunk: ChatChunk) => void>();
  private readonly resolvedListeners = new Set<(chunk: ChatChunk) => void>();

  setEmitter(emit: ((chunk: ChatChunk) => void) | null): void {
    this.emit = emit;
  }

  /**
   * A standing listener of every request, besides the turn's emitter: how an
   * engine broadcasts the request to every view of its slot. Returns the
   * unsubscribe.
   */
  onRequest(listener: (chunk: ChatChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * A standing listener of every answer given through `resolve`: how an engine
   * tells every view of its slot that a card it shows was settled. Returns the
   * unsubscribe.
   */
  onResolved(listener: (chunk: ChatChunk) => void): () => void {
    this.resolvedListeners.add(listener);
    return () => this.resolvedListeners.delete(listener);
  }

  request(request: VaultEscalation, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    // Minted, not the tool-call id: providers reuse index-style call ids
    // (`read:5`, `call_00_…`) across turns and sessions, and an answer must
    // reach exactly this request, whichever chat it comes from.
    const requestId = randomUUID();
    const chunk: ChatChunk = {
      kind: 'approval-request',
      requestId,
      callId: request.callId,
      tool: request.tool,
      target: request.target,
      args: request.args,
    };
    this.emit?.(chunk);
    for (const listener of this.listeners) listener(chunk);
    return new Promise<boolean>((resolve) => {
      const settle = (approved: boolean): void => {
        const pending = this.pending.get(requestId);
        pending?.removeAbort?.();
        this.pending.delete(requestId);
        resolve(approved);
      };
      const pending: PendingApproval = { resolve: settle };
      if (signal) {
        const abort = (): void => settle(false);
        signal.addEventListener('abort', abort, { once: true });
        pending.removeAbort = () => signal.removeEventListener('abort', abort);
      }
      this.pending.set(requestId, pending);
    });
  }

  resolve(requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    pending.resolve(approved);
    const chunk: ChatChunk = { kind: 'approval-resolved', requestId, approved };
    for (const listener of this.resolvedListeners) listener(chunk);
    return true;
  }
}
