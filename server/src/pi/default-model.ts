import type { SettingsManager } from '@earendil-works/pi-coding-agent';

export interface PiModelPick {
  provider: string;
  model: string;
}

/**
 * The provider and model pi routes to. `FUNKYOCTOPUS_PROVIDER` and
 * `FUNKYOCTOPUS_MODEL` win, each on its own; pi's own `defaultProvider` and
 * `defaultModel` settings fill what the environment leaves out, so a user who
 * already set up pi needs no FunkyOctopus setting. With neither source there is
 * no model to guess, so it throws a message that names both ways to set one.
 */
export function resolvePiModel(
  configured: { provider: string | undefined; model: string | undefined },
  settings: Pick<SettingsManager, 'getDefaultProvider' | 'getDefaultModel'>,
): PiModelPick {
  const provider = configured.provider ?? settings.getDefaultProvider();
  const model = configured.model ?? settings.getDefaultModel();
  if (provider === undefined || model === undefined) {
    throw new Error(
      'no pi model is configured: set FUNKYOCTOPUS_PROVIDER and FUNKYOCTOPUS_MODEL, ' +
        "or defaultProvider and defaultModel in pi's settings",
    );
  }
  return { provider, model };
}
