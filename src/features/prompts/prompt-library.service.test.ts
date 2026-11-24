import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PromptLibraryService } from './prompt-library.service.ts';

describe('PromptLibraryService', () => {
  it('adds prompts newest-first and persists them', () => {
    const storage = new MemoryStorageAdapter();
    const svc = new PromptLibraryService(storage);
    svc.add({ title: 'first', body: 'a' });
    svc.add({ title: 'second', body: 'b' });

    expect(svc.list().map((p) => p.title)).toEqual(['second', 'first']);

    // a fresh service over the same storage reloads them
    const reloaded = new PromptLibraryService(storage);
    expect(reloaded.list()).toHaveLength(2);
  });

  it('defaults a blank title and removes by id', () => {
    const svc = new PromptLibraryService(new MemoryStorageAdapter());
    const p = svc.add({ title: '   ', body: 'x' });
    expect(p.title).toBe('Untitled');
    svc.remove(p.id);
    expect(svc.list()).toEqual([]);
  });

  it('notifies subscribers and ignores corrupt stored shapes', () => {
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.prompts', [{ nonsense: true }, 'garbage']);
    const svc = new PromptLibraryService(storage);
    expect(svc.list()).toEqual([]);

    const listener = vi.fn();
    svc.subscribe(listener);
    svc.add({ title: 't', body: 'b' });
    expect(listener).toHaveBeenCalledOnce();
  });
});
