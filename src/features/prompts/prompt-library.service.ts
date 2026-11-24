import { token } from '@core/container/container.ts';
import type { StorageAdapter } from '@shared/storage/storage-adapter.ts';
import type { NewPrompt, SavedPrompt } from './prompt.types.ts';

const STORAGE_KEY = 'funkyoctopus.prompts';

function isSavedPrompt(value: unknown): value is SavedPrompt {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === 'string' &&
    typeof p.title === 'string' &&
    typeof p.body === 'string' &&
    typeof p.createdAt === 'number'
  );
}

/**
 * A small library of reusable prompts, persisted through the StorageAdapter seam.
 *
 * Reshaped from the original PromptService (221 lines: categories, favourites,
 * Date objects, deprecated substr ids) down to what the shell actually needs —
 * save, list, remove — with number timestamps and a defaults-first load that
 * tolerates outdated stored shapes. A deep module: small surface, all state
 * kept immutable so useSyncExternalStore sees stable snapshots.
 */
export class PromptLibraryService {
  private prompts: SavedPrompt[];
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: StorageAdapter) {
    this.prompts = this.load();
  }

  list = (): SavedPrompt[] => this.prompts;

  add(input: NewPrompt): SavedPrompt {
    const prompt: SavedPrompt = {
      id: `p_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      title: input.title.trim() || 'Untitled',
      body: input.body,
      createdAt: Date.now(),
    };
    this.prompts = [prompt, ...this.prompts];
    this.persist();
    return prompt;
  }

  remove(id: string): void {
    const next = this.prompts.filter((p) => p.id !== id);
    if (next.length !== this.prompts.length) {
      this.prompts = next;
      this.persist();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private load(): SavedPrompt[] {
    const raw = this.storage.get<unknown>(STORAGE_KEY);
    return Array.isArray(raw) ? raw.filter(isSavedPrompt) : [];
  }

  private persist(): void {
    this.storage.set(STORAGE_KEY, this.prompts);
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const PROMPT_LIBRARY = token<PromptLibraryService>('PromptLibraryService');
