import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { PreferencesService } from './preferences.service.ts';
import { DEFAULT_PREFERENCES } from './preferences.types.ts';

const makeService = () => {
  const storage = new MemoryStorageAdapter();
  return { storage, service: new PreferencesService(storage) };
};

describe('PreferencesService', () => {
  it('starts from defaults when storage is empty', () => {
    const { service } = makeService();
    expect(service.get()).toEqual(DEFAULT_PREFERENCES);
  });

  it('starts with no favourite models: the cockpit stars none on a user\'s behalf', () => {
    const { service } = makeService();
    expect(service.get().favoriteModels).toEqual([]);
  });

  it('keeps the favourite models a user already stored, whatever the defaults are', () => {
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.preferences', { fontSize: 20, favoriteModels: ['alpha::one', 'beta::two'] });

    const service = new PreferencesService(storage);
    expect(service.get().favoriteModels).toEqual(['alpha::one', 'beta::two']);

    // Stored favourites also survive a later, unrelated update.
    service.update({ fontSize: 21 });
    expect(new PreferencesService(storage).get().favoriteModels).toEqual(['alpha::one', 'beta::two']);
  });

  it('defaults to the Brand theme, also for a stored shape from before themes', () => {
    expect(makeService().service.get().theme).toBe('brand');
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.preferences', { fontSize: 20 });
    expect(new PreferencesService(storage).get().theme).toBe('brand');
  });

  it('keeps a chosen theme and falls back to Brand for one no longer in the registry', () => {
    const storage = new MemoryStorageAdapter();
    new PreferencesService(storage).update({ theme: 'matrix' });
    expect(new PreferencesService(storage).get().theme).toBe('matrix');

    storage.set('funkyoctopus.preferences', { theme: 'retired' });
    expect(new PreferencesService(storage).get().theme).toBe('brand');
  });

  it('merges a patch over current preferences', () => {
    const { service } = makeService();
    service.update({ fontSize: 18 });
    expect(service.get()).toEqual({ ...DEFAULT_PREFERENCES, fontSize: 18 });
  });

  it('persists across a fresh instance over the same storage', () => {
    const storage = new MemoryStorageAdapter();
    new PreferencesService(storage).update({ fontSize: 20, showTimestamps: false });

    const revived = new PreferencesService(storage);
    expect(revived.get().fontSize).toBe(20);
    expect(revived.get().showTimestamps).toBe(false);
  });

  it('fills missing fields from defaults when the stored shape is partial', () => {
    const storage = new MemoryStorageAdapter();
    storage.set('funkyoctopus.preferences', { fontSize: 20 });

    const service = new PreferencesService(storage);
    expect(service.get().fontSize).toBe(20);
    expect(service.get().sidebarPosition).toBe(DEFAULT_PREFERENCES.sidebarPosition);
  });

  it('notifies subscribers on update and stops after unsubscribe', () => {
    const { service } = makeService();
    const listener = vi.fn();

    const unsubscribe = service.subscribe(listener);
    service.update({ fontSize: 16 });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 16 }));

    unsubscribe();
    service.update({ fontSize: 22 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
