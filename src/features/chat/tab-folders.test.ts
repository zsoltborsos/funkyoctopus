import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { folderProject, TabFolders } from './tab-folders.ts';

const FO = { id: '/work/fo', name: 'funkyoctopus', path: '/work/fo', envTier: 'normal' as const };
const SQ = { id: '/work/sq', name: 'helmraiser', path: '/work/sq', envTier: 'normal' as const };

describe('TabFolders', () => {
  it('keeps a working folder per tab: setting one tab’s never moves another’s', () => {
    const folders = new TabFolders(new MemoryStorageAdapter());
    folders.forTab('main').set(FO);
    folders.forTab('b').set(SQ);

    expect(folders.forTab('main').get()).toEqual(FO);
    expect(folders.forTab('b').get()).toEqual(SQ);
    expect(folders.forTab('c').get()).toBeNull();
  });

  it('keeps Global (null) as a choice of its own, and survives a reload', () => {
    const storage = new MemoryStorageAdapter();
    const legacy = () => FO;
    new TabFolders(storage, legacy).forTab('main').set(null);

    expect(new TabFolders(storage, legacy).forTab('main').get()).toBeNull();
  });

  it('starts main on the old single global folder, and only main', () => {
    const folders = new TabFolders(new MemoryStorageAdapter(), () => FO);
    expect(folders.forTab('main').get()).toEqual(FO);
    expect(folders.forTab('b').get()).toBeNull();
  });

  it('forgets the folders of tabs that no longer exist', () => {
    const storage = new MemoryStorageAdapter();
    const folders = new TabFolders(storage);
    folders.forTab('main').set(FO);
    folders.forTab('gone').set(SQ);
    folders.retain(['main']);

    expect(new TabFolders(storage).forTab('gone').get()).toBeNull();
    expect(new TabFolders(storage).forTab('main').get()).toEqual(FO);
  });

  it('tells subscribers when a folder changes', () => {
    const folders = new TabFolders(new MemoryStorageAdapter());
    const heard = vi.fn();
    folders.forTab('main').subscribe(heard);
    folders.forTab('b').set(SQ);
    expect(heard).toHaveBeenCalledOnce();
  });

  it('names a bare path by its last segment', () => {
    expect(folderProject('/work/runs/wt-1')).toEqual({ id: '/work/runs/wt-1', name: 'wt-1', path: '/work/runs/wt-1', envTier: 'normal' });
  });

  it.each(['__proto__', 'constructor', 'toString'])('a tab named %s reads as no folder, not a property of Object', (chatId) => {
    const folders = new TabFolders(new MemoryStorageAdapter(), () => FO);
    expect(folders.forTab(chatId).get()).toBeNull();
    folders.follow(chatId, '/work/sq', true);
    expect(folders.forTab(chatId).get()?.path).toBe('/work/sq');
  });
});
