import { describe, expect, it, vi } from 'vitest';
import { MemoryStorageAdapter } from '@shared/storage/memory-storage.adapter.ts';
import { TabModels } from './tab-models.ts';

const PI_FAST = { provider: 'opencode-go', id: 'deepseek-v4.1-flash' };
const PI_BIG = { provider: 'openai-codex', id: 'gpt-6-sol' };
const OPUS = { provider: 'claude-code', id: 'opus' };

describe('TabModels', () => {
  it('keeps a model and effort per tab, so two tabs drive two models', () => {
    const models = new TabModels(new MemoryStorageAdapter());
    models.forTab('main', () => 'pi').selectModel(PI_FAST);
    models.forTab('b', () => 'pi').selectModel(PI_BIG);
    models.forTab('b', () => 'pi').selectEffort('high');

    expect(models.forTab('main', () => 'pi').get()).toEqual({ model: PI_FAST, effort: null });
    expect(models.forTab('b', () => 'pi').get()).toEqual({ model: PI_BIG, effort: 'high' });
  });

  it('survives a reload: the picks are read back from storage', () => {
    const storage = new MemoryStorageAdapter();
    new TabModels(storage).forTab('c', () => 'claude-code').selectModel(OPUS);

    expect(new TabModels(storage).forTab('c', () => 'claude-code').get().model).toEqual(OPUS);
  });

  it('starts a new tab on the last pick made in a tab of its engine, never the other engine’s', () => {
    const models = new TabModels(new MemoryStorageAdapter());
    models.forTab('main', () => 'pi').selectModel(PI_BIG);
    models.forTab('c', () => 'claude-code').selectModel(OPUS);

    expect(models.forTab('new-pi', () => 'pi').get().model).toEqual(PI_BIG);
    expect(models.forTab('new-claude', () => 'claude-code').get().model).toEqual(OPUS);
  });

  it('ignores a pick of the wrong engine (main changed engine across a sidecar restart)', () => {
    const models = new TabModels(new MemoryStorageAdapter());
    models.forTab('main', () => 'pi').selectModel(PI_FAST);

    expect(models.forTab('main', () => 'claude-code').get()).toEqual({ model: null, effort: null });
  });

  it('forgets the picks of tabs that no longer exist, and a vanished tab falls back gracefully', () => {
    const storage = new MemoryStorageAdapter();
    const models = new TabModels(storage);
    models.forTab('gone', () => 'pi').selectModel(PI_BIG);
    models.forTab('main', () => 'pi').selectModel(PI_FAST);

    models.retain(['main']);

    // The engine's last pick is kept: a new tab still starts where you left off.
    expect(new TabModels(storage).forTab('gone', () => 'pi').get().model).toEqual(PI_FAST);
    expect(storage.get<{ tabs: Record<string, unknown> }>('funkyoctopus.chat.tab-models')?.tabs).toEqual({
      main: { model: PI_FAST, effort: null },
    });
  });

  it('tells subscribers when a pick changes', () => {
    const models = new TabModels(new MemoryStorageAdapter());
    const heard = vi.fn();
    models.subscribe(heard);
    const before = models.getVersion();

    models.forTab('main', () => 'pi').selectEffort('medium');

    expect(heard).toHaveBeenCalledTimes(1);
    expect(models.getVersion()).not.toBe(before);
  });

  it.each(['__proto__', 'constructor', 'toString'])('a tab named %s reads as no pick, not a property of Object', (chatId) => {
    const models = new TabModels(new MemoryStorageAdapter());
    expect(models.forTab(chatId, () => 'pi').get()).toEqual({ model: null, effort: null });
    models.forTab(chatId, () => 'pi').selectModel(PI_FAST);
    expect(models.forTab(chatId, () => 'pi').get()).toEqual({ model: PI_FAST, effort: null });
  });
});
