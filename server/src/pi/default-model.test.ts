import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { resolvePiModel } from './default-model.ts';

/** pi's own settings, in memory: no file under ~/.pi is read or written. */
const piSettings = (defaults: { defaultProvider?: string; defaultModel?: string } = {}) =>
  SettingsManager.inMemory(defaults);

describe('resolvePiModel', () => {
  it('uses FUNKYOCTOPUS_PROVIDER and FUNKYOCTOPUS_MODEL over pi settings', () => {
    const picked = resolvePiModel(
      { provider: 'env-provider', model: 'env-model' },
      piSettings({ defaultProvider: 'pi-provider', defaultModel: 'pi-model' }),
    );

    expect(picked).toEqual({ provider: 'env-provider', model: 'env-model' });
  });

  it("falls back to pi's defaultProvider and defaultModel when the environment sets neither", () => {
    const picked = resolvePiModel(
      { provider: undefined, model: undefined },
      piSettings({ defaultProvider: 'pi-provider', defaultModel: 'pi-model' }),
    );

    expect(picked).toEqual({ provider: 'pi-provider', model: 'pi-model' });
  });

  it('resolves each half on its own: an env model rides on pi default provider', () => {
    const picked = resolvePiModel(
      { provider: undefined, model: 'env-model' },
      piSettings({ defaultProvider: 'pi-provider', defaultModel: 'pi-model' }),
    );

    expect(picked).toEqual({ provider: 'pi-provider', model: 'env-model' });
  });

  it.each([
    ['nothing is set anywhere', { provider: undefined, model: undefined }, {}],
    ['only a provider is known', { provider: 'env-provider', model: undefined }, {}],
    ['only a model is known', { provider: undefined, model: undefined }, { defaultModel: 'pi-model' }],
  ] as const)('refuses to guess when %s, naming both ways to configure it', (_case, configured, defaults) => {
    const attempt = () => resolvePiModel(configured, piSettings(defaults));

    expect(attempt).toThrow(/FUNKYOCTOPUS_PROVIDER/);
    expect(attempt).toThrow(/FUNKYOCTOPUS_MODEL/);
    expect(attempt).toThrow(/defaultProvider/);
    expect(attempt).toThrow(/defaultModel/);
  });
});
