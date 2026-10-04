import { useMemo, useSyncExternalStore } from 'react';

import { getNsiteEnv, NSITE_ENV_CHANGED, NSITE_ENV_KEY, type NsiteEnvVariable } from '@/lib/nsiteEnv';

function subscribe(callback: () => void): () => void {
  // Changes from another tab.
  const onStorage = (e: StorageEvent) => {
    if (e.key === NSITE_ENV_KEY) callback();
  };
  window.addEventListener('storage', onStorage);

  // Changes from this one, which `storage` never reports.
  window.addEventListener(NSITE_ENV_CHANGED, callback);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(NSITE_ENV_CHANGED, callback);
  };
}

function getSnapshot(): string | null {
  return localStorage.getItem(NSITE_ENV_KEY);
}

/** A site's `window.ENV` variables, ordered by name and kept current. See `nsiteEnv`. */
export function useNsiteEnv(siteId: string): NsiteEnvVariable[] {
  const raw = useSyncExternalStore(subscribe, getSnapshot);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `raw` is what changes when the store does.
  return useMemo(() => getNsiteEnv(siteId), [siteId, raw]);
}
