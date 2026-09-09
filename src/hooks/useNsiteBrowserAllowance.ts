import { useSyncExternalStore } from 'react';

import {
  getNsiteBrowserAllowance,
  NSITE_BROWSER_PERMISSIONS_KEY,
  type NsiteBrowserAllowance,
} from '@/lib/nsiteBrowserPermissions';

function subscribe(callback: () => void): () => void {
  // Changes from another tab.
  const onStorage = (e: StorageEvent) => {
    if (e.key === NSITE_BROWSER_PERMISSIONS_KEY) callback();
  };
  window.addEventListener('storage', onStorage);

  // Changes from this one. The `storage` event never fires in the tab that
  // wrote, so the store dispatches its own event alongside the write.
  const onLocal = () => callback();
  window.addEventListener('nsite-browser-permissions-changed', onLocal);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('nsite-browser-permissions-changed', onLocal);
  };
}

let snapshotCache: string | null = null;

function getSnapshot(): string | null {
  const current = localStorage.getItem(NSITE_BROWSER_PERMISSIONS_KEY);
  if (current !== snapshotCache) snapshotCache = current;
  return snapshotCache;
}

/**
 * What a site has been allowed to do with the device, kept current.
 *
 * The counterpart of `useNsiteAllowance`, and deliberately without its pubkey
 * argument: these are keyed by site, not by identity, so there is an answer
 * here whether or not anyone is signed in. See `nsiteBrowserPermissions`.
 */
export function useNsiteBrowserAllowance(
  siteId: string,
): NsiteBrowserAllowance | undefined {
  useSyncExternalStore(subscribe, getSnapshot);
  return getNsiteBrowserAllowance(siteId);
}
