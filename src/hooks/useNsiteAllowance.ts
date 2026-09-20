import { useEffect, useState } from 'react';

import { getNsiteAllowance, type NsiteAllowance } from '@/lib/nsitePermissions';

const STORAGE_KEY = 'nostr:nsite-permissions';

/**
 * What a site has been granted by the logged-in user, kept current.
 *
 * The store is asynchronous — natively held on Android, so that the site's
 * service worker can read it with no window open — so this is a read into
 * state rather than a `useSyncExternalStore` over localStorage, which is what
 * it was while the records lived up here.
 *
 * Re-read on three things: the cross-tab `storage` event, the same-tab event
 * every write in `nsitePermissions` dispatches, and the app coming back to the
 * front. The last one is what covers a grant made in the native sheet a
 * signing notification opens, which nothing in the web layer hears about.
 * Without any of it, a permission granted through a prompt wouldn't show up in
 * a settings dialog that was already open.
 *
 * Undefined for a logged-out user: an allowance is scoped to a pubkey, and
 * with no identity there is nothing to have granted anything.
 */
export function useNsiteAllowance(
  siteId: string,
  userPubkey: string | undefined,
): NsiteAllowance | undefined {
  /**
   * The last read, and what it was a read of.
   *
   * Kept together so that switching account or site does not show the previous
   * answer while the next one is in flight — which, for a screen listing what
   * somebody has been given a key for, would be showing one identity's grants
   * under another's name.
   */
  const [read, setRead] = useState<{
    siteId: string;
    userPubkey: string;
    allowance: NsiteAllowance | undefined;
  } | null>(null);

  useEffect(() => {
    if (!userPubkey) return;

    let disposed = false;

    const read = () => {
      void getNsiteAllowance(siteId, userPubkey).then((allowance) => {
        if (!disposed) setRead({ siteId, userPubkey, allowance });
      });
    };

    read();

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) read();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener('nsite-permissions-changed', read);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('nsite-permissions-changed', read);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [siteId, userPubkey]);

  if (!userPubkey) return undefined;
  if (!read || read.siteId !== siteId || read.userPubkey !== userPubkey) return undefined;
  return read.allowance;
}
