import { useSyncExternalStore } from 'react';

import { getRecents, subscribeRecents } from '@/lib/recents';

/**
 * What was opened lately, newest first, kept current while it is on screen.
 *
 * The list is written by whatever launches an app, which is several components
 * away from the one that reads it, so it is watched rather than passed down.
 */
export function useRecents(): string[] {
  return useSyncExternalStore(subscribeRecents, getRecents, getRecents);
}
