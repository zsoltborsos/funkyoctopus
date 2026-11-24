import { useEffect, useState } from 'react';
import { useService } from '@core/container/useService.ts';
import { CLAUDE_CODE_PROVIDER, type ModelOption } from '@shared/transport/protocol.ts';
import { CHAT_SESSION } from './chat-session.service.ts';
import { MODELS } from './models.client.ts';

export interface UseModels {
  models: ModelOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Loads the selectable chat models when the composer mounts. A failure
 * (sidecar down, no auth) leaves an empty list — the composer degrades to the
 * sidecar's default model rather than blocking chat.
 *
 * Claude Code can list its models only through a running process, so before its
 * first turn the sidecar offers the list the last run saved, or the three aliases
 * on a first start. When the first turn ends the list is read once more, which is
 * the earliest the live one can exist; pi's list never changes under a turn, so
 * it is not asked again.
 */
export function useModels(): UseModels {
  const client = useService(MODELS);
  const session = useService(CHAT_SESSION);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    client
      .list()
      .then((list) => {
        if (active) {
          setModels(list);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (active) {
          setError(e instanceof Error ? e.message : 'failed to load models');
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client]);

  const claudeListed = models.length > 0 && models.every((model) => model.provider === CLAUDE_CODE_PROVIDER);
  useEffect(() => {
    if (!claudeListed) return undefined;
    let active = true;
    const stop = session.subscribeActivity((activity) => {
      if (activity.kind !== 'turn-ended') return;
      stop();
      // A failed second read keeps the list already shown.
      client.list().then(
        (list) => {
          if (active) setModels(list);
        },
        () => undefined,
      );
    });
    return () => {
      active = false;
      stop();
    };
  }, [claudeListed, client, session]);

  return { models, loading, error };
}
