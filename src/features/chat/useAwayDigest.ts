import { useEffect } from 'react';
import { useService } from '@core/container/useService.ts';
import { AWAY_DIGEST } from './away-digest.ts';

/** Keeps capture alive at the app level, even while Chat is not the active view. */
export function useAwayDigestLifecycle(): void {
  const digest = useService(AWAY_DIGEST);
  useEffect(() => digest.start(), [digest]);
}
