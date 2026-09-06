import { useSyncExternalStore } from 'react';

import { getNsiteAllowance, type NsiteAllowance } from '@/lib/nsitePermissions';

const STORAGE_KEY = 'nostr:nsite-permissions';

function subscribe(callback: () => void): () => void {
  // Changes from another tab.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener('storage', onStorage);

  // Changes from this one. The `storage` event never fires in the tab that
  // wrote, so `nsitePermissions` dispatches its own event alongside the write.
  const onLocal = () => callback();
  window.addEventListener('nsite-permissions-changed', onLocal);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('nsite-permissions-changed', onLocal);
  };
}

let snapshotCache: string | null = null;

function getSnapshot(): string | null {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current !== snapshotCache) snapshotCache = current;
  return snapshotCache;
}

/**
 * What a site has been granted by the logged-in user, kept current.
 *
 * The store is localStorage, which nothing re-renders on its own, so this
 * subscribes to both the cross-tab `storage` event and the same-tab one the
 * writes dispatch. Without it a permission granted through a prompt wouldn't
 * show up in a settings dialog that was already open.
 *
 * Undefined for a logged-out user: an allowance is scoped to a pubkey, and
 * with no identity there is nothing to have granted anything.
 */
export function useNsiteAllowance(
  siteId: string,
  userPubkey: string | undefined,
): NsiteAllowance | undefined {
  useSyncExternalStore(subscribe, getSnapshot);
  return userPubkey ? getNsiteAllowance(siteId, userPubkey) : undefined;
}
