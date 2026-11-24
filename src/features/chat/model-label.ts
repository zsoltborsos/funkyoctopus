import { CLAUDE_CODE_PROVIDER, type ModelOption } from '@shared/transport/protocol.ts';

/**
 * A model as a transcript label: the picker's name for a Claude Code model, found
 * by the alias it was asked for or the full id a stored turn recorded, else the id
 * as it is. Another provider's ids are left alone.
 */
export function modelLabel(models: readonly ModelOption[], id: string): string {
  // Claude Code lists its own `default` as a model, "Default (recommended)": it is whichever model
  // is current, so a turn is never named by it.
  const match = models.find(
    (model) =>
      model.provider === CLAUDE_CODE_PROVIDER &&
      model.id !== 'default' &&
      (model.id === id || model.resolvedId === id),
  );
  return match?.name ?? id;
}
