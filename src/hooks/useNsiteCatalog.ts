import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useFollows } from '@/hooks/useFollows';
import { buildCatalog, type NsiteCatalogEntry } from '@/lib/nsiteCatalog';
import { isServableNsite } from '@/lib/nsiteFiles';
import { getNsiteName, NSITE_NAMED_KIND, NSITE_ROOT_KIND } from '@/lib/nsiteSubdomain';
import { NSITE_CATALOG_PUBKEYS, NSITE_RELAY } from '@/lib/tenna';

/**
 * The nsites Tenna offers to install — Team Soapbox's apps, the clients Nsite
 * Packagers puts on Nostr, the publishers of the sites Tenna ships on the
 * wall, and whatever the people the user follows publish.
 *
 * The named ones are a catalog in the ordinary sense: someone packaged these
 * to be installed. Follows are not that, and are the better half of the list
 * anyway — the web a person already keeps up with is a far better guess at
 * which sites they want on their wall than anything a publisher could pick for
 * them, and it is a list nobody has to curate.
 *
 * Root sites are here as well as named ones, because a root site is what a
 * person publishing for themselves ends up with: one site at their npub, no
 * `d` tag, and often no `title` either. Those are named after their author, so
 * a follow's site reads as the follow.
 *
 * A list to pick from rather than a lineup: nothing here is on the wall until
 * someone puts it there. Sorted by name, because that is the only order a
 * person scanning a list for one app can follow, and it is the order the
 * search box narrows.
 */
export function useNsiteCatalog() {
  const { nostr } = useNostr();
  const { data: follows, isLoading: followsLoading } = useFollows();

  const authors = useMemo(
    () => [...new Set([...NSITE_CATALOG_PUBKEYS, ...(follows ?? [])])],
    [follows],
  );

  const queryKey = useMemo(() => ['nsite-catalog', authors], [authors]);

  // Two round trips deep — the follow list, then the catalog, then the
  // profiles — this is the slowest list in the app to arrive, and almost all
  // of it was the same last time. Both halves come off disk at once: the
  // manifests, and every profile that might name one of them.
  useCacheFirstSeedMany<NsiteCatalogEntry[]>({
    queryKey: authors.length > 0 ? queryKey : undefined,
    filters: [
      { kinds: [NSITE_ROOT_KIND, NSITE_NAMED_KIND], authors, limit: 500 },
      { kinds: [0], authors },
    ],
    toData: (events) => {
      const manifests = events.filter((e) => e.kind !== 0);
      return manifests.length > 0
        ? buildCatalog(manifests, events.filter((e) => e.kind === 0))
        : undefined;
    },
  });

  return useQuery({
    // Waits for the follow list rather than running twice: a catalog that
    // arrives short and then reshuffles under the finger is worse than one
    // that arrives a moment later whole.
    enabled: !followsLoading,
    queryKey,
    queryFn: async (c): Promise<NsiteCatalogEntry[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.relay(NSITE_RELAY).query(
        [{ kinds: [NSITE_ROOT_KIND, NSITE_NAMED_KIND], authors, limit: 500 }],
        { signal },
      );

      const sites = events.filter(isServableNsite);

      // Only the sites that don't name themselves send us looking for their
      // author, and one query covers all of them.
      const anonymous = [...new Set(sites.filter((e) => !getNsiteName(e)).map((e) => e.pubkey))];

      const profiles = anonymous.length
        ? await nostr
            .query([{ kinds: [0], authors: anonymous, limit: anonymous.length }], { signal })
            .catch(() => [] as NostrEvent[])
        : [];

      return buildCatalog(sites, profiles);
    },
    staleTime: 60_000,
  });
}
