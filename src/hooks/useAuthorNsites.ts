import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { buildCatalog, type NsiteCatalogEntry } from '@/lib/nsiteCatalog';
import { isServableNsite } from '@/lib/nsiteFiles';
import { getNsiteName, NSITE_NAMED_KIND, NSITE_ROOT_KIND } from '@/lib/nsiteSubdomain';
import { NSITE_RELAY } from '@/lib/tenna';

/** Nobody publishes more sites than a page can list. */
const LIMIT = 200;

/**
 * Everything one person has published, as rows to pick from.
 *
 * The catalog narrowed to a single key — which is what a publisher's page is.
 * Snapshots are left out, as they are in the catalog: a snapshot is one
 * version of a site rather than a site, and a list of them would be the same
 * app over and over under the same name.
 *
 * `authors` is the whole point and not merely a filter. A manifest is signed,
 * so the key behind the signature is the only claim on this page anyone can
 * make; a `d` tag is not, and asking for one without the author would list
 * whatever anybody had published under that name.
 *
 * Asked of the nsite relay alone, where the manifests are, and where the
 * catalog asks the same question about everybody at once — so a publisher
 * whose site is already in the catalog is answered off the query cache before
 * the page has finished opening.
 */
export function useAuthorNsites(pubkey: string | undefined) {
  const { nostr } = useNostr();

  const queryKey = useMemo(() => ['author-nsites', pubkey ?? ''], [pubkey]);

  const filters = useMemo(
    () =>
      pubkey
        ? [
            { kinds: [NSITE_ROOT_KIND, NSITE_NAMED_KIND], authors: [pubkey], limit: LIMIT },
            { kinds: [0], authors: [pubkey] },
          ]
        : [],
    [pubkey],
  );

  // Off the disk first. A publisher reached from the App info screen of one
  // of their own apps has at least that app's manifest stored already, so the
  // list arrives with something in it rather than as a screen of skeletons.
  useCacheFirstSeedMany<NsiteCatalogEntry[]>({
    queryKey: pubkey ? queryKey : undefined,
    filters,
    toData: (events) => {
      const manifests = events.filter((e) => e.kind !== 0);
      return manifests.length > 0
        ? buildCatalog(manifests, events.filter((e) => e.kind === 0))
        : undefined;
    },
  });

  return useQuery({
    enabled: !!pubkey,
    queryKey,
    queryFn: async (c): Promise<NsiteCatalogEntry[]> => {
      if (!pubkey) return [];

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);

      const events = await nostr
        .relay(NSITE_RELAY)
        .query(
          [{ kinds: [NSITE_ROOT_KIND, NSITE_NAMED_KIND], authors: [pubkey], limit: LIMIT }],
          { signal },
        );

      const sites = events.filter(isServableNsite);

      // Only worth asking when something here has no name of its own; the
      // page has already fetched this profile to put a face at the top of it,
      // so this is a cache hit far more often than a request.
      const profiles = sites.some((event) => !getNsiteName(event))
        ? await nostr
            .query([{ kinds: [0], authors: [pubkey], limit: 1 }], { signal })
            .catch(() => [] as NostrEvent[])
        : [];

      return buildCatalog(sites, profiles);
    },
    staleTime: 60_000,
  });
}
