import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';
import { useService } from '@core/container/useService.ts';
import { PROMPT_LIBRARY } from './prompt-library.service.ts';
import type { NewPrompt, SavedPrompt } from './prompt.types.ts';

export interface UsePromptLibrary {
  prompts: SavedPrompt[];
  add: (input: NewPrompt) => void;
  remove: (id: string) => void;
}

/** React-bound view of the saved-prompt library. */
export function usePromptLibrary(): UsePromptLibrary {
  const service = useService(PROMPT_LIBRARY);
  const prompts = useSyncExternalStore(service.subscribe, service.list);
  const add = useCallback((input: NewPrompt) => service.add(input), [service]);
  const remove = useCallback((id: string) => service.remove(id), [service]);
  return { prompts, add, remove };
}
