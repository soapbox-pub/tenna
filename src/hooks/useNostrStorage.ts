import { useContext } from 'react';
import type { NIndexedDB } from '@nostrify/indexeddb';

import { NostrStorageContext } from '@/contexts/NostrStorageContext';

/**
 * The app-wide IndexedDB event store.
 *
 * Everything the app has read off a relay and thought worth keeping is in
 * here — see `CachingPool` for what that is. Reading it is how a hook shows
 * something on the first frame of a cold start instead of after a relay
 * answers; see `useCacheFirstSeed`.
 *
 * ```ts
 * const { store } = useNostrStorage();
 * const [profile] = await store.query([{ kinds: [0], authors: [pubkey] }]);
 * ```
 */
export function useNostrStorage(): { store: NIndexedDB } {
  const store = useContext(NostrStorageContext);
  if (!store) {
    throw new Error('useNostrStorage must be used within a NostrProvider');
  }
  return { store };
}
