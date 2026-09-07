import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { isServableNsite } from '@/lib/nsiteFiles';
import { getNsiteName, getNsiteSubdomain, NSITE_NAMED_KIND } from '@/lib/nsiteSubdomain';
import { NSITE_CATALOG_PUBKEYS, NSITE_RELAY } from '@/lib/tenna';

/**
 * The named nsites Tenna offers to install — Team Soapbox's apps and the
 * clients Nsite Packagers puts on Nostr.
 *
 * A list to pick from rather than a lineup: nothing here is on the wall until
 * someone puts it there. Sorted by name, because that is the only order a
 * person scanning a list for one app can follow, and it is the order the
 * search box narrows.
 */
export function useNsiteCatalog() {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['nsite-catalog'],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.relay(NSITE_RELAY).query(
        [{ kinds: [NSITE_NAMED_KIND], authors: NSITE_CATALOG_PUBKEYS, limit: 200 }],
        { signal },
      );
      // One row per site, the newest manifest of any a relay offers for it.
      const latest = new Map<string, NostrEvent>();
      for (const event of events.filter(isServableNsite)) {
        const id = getNsiteSubdomain(event);
        const seen = latest.get(id);
        if (!seen || seen.created_at < event.created_at) latest.set(id, event);
      }

      return [...latest.values()].sort((a, b) =>
        (getNsiteName(a) ?? '').localeCompare(getNsiteName(b) ?? ''),
      );
    },
    staleTime: 60_000,
  });
}
