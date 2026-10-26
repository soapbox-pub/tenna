import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useNostrStorage } from '@/hooks/useNostrStorage';
import { parseNsiteAddress } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { NSITE_RELAY } from '@/lib/tenna';

/** The newest servable manifest among some events, or null if there is none. */
function newestServable(events: NostrEvent[]): NostrEvent | null {
  return events.filter(isServableNsite).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/** What an address turned out to name. */
interface NsiteAddressResult {
  event: NostrEvent | null;
  relays: string[];
}

/**
 * The site an address names, if what was typed is an address at all.
 *
 * This is the other half of the search box: a name is looked for in the
 * catalog, and an `naddr`, `npub`, `nsite://` URL or gateway URL is looked for
 * on the relays. The two answer the same question — which site did you mean —
 * so they are one field, and this hook simply stays idle for anything that
 * doesn't parse.
 *
 * Nothing partial parses, so typing an address a character at a time costs one
 * query, at the end.
 */
export function useNsiteAddress(input: string) {
  const { nostr } = useNostr();
  const { store } = useNostrStorage();

  const trimmed = input.trim();
  const address = useMemo(() => parseNsiteAddress(trimmed), [trimmed]);

  // A snapshot is named by its own event id, so it is already exactly the
  // bytes it will always be. Once one is on disk there is no newer version to
  // go looking for, and the relays have nothing to add.
  const known = address?.filter ?? null;
  const immutable = known !== null && 'ids' in known;

  const filters = useMemo(() => (known ? [known] : []), [known]);

  // Pasting back an address that was pasted before — which is most of them,
  // since an address is something a person keeps and re-uses.
  useCacheFirstSeedMany<NsiteAddressResult>({
    queryKey: known ? ['nsite-address', trimmed] : undefined,
    filters,
    toData: (events) => {
      const event = newestServable(events);
      return event ? { event, relays: [] } : undefined;
    },
  });

  const query = useQuery({
    queryKey: ['nsite-address', trimmed],
    enabled: address !== null,
    queryFn: async (): Promise<NsiteAddressResult> => {
      if (!address) return { event: null, relays: [] };

      // Not the query's own signal. A link that opens a site is answered out
      // of the cache at once and then cleared, which unmounts this query and
      // would abort the relay call — so the newer manifest it was going to
      // bring back never reached the cache, and every later link opened the
      // same old version of the site. Let it finish; it is one request.
      const signal = AbortSignal.timeout(8000);

      const { filter, relays } = address;

      if (immutable) {
        const cached = newestServable(await store.query([filter]).catch(() => []));
        if (cached) return { event: cached, relays };
      }

      const urls = [...new Set([NSITE_RELAY, ...relays])];
      const events = await nostr.group(urls).query([filter], { signal });

      return { event: newestServable(events), relays };
    },
    staleTime: 60_000,
    retry: 1,
  });

  return {
    /** Whether the box holds an address, and so whether the list is this. */
    isAddress: address !== null,
    /** Relays this site came from, to be kept with it if it is added. */
    relays: query.data?.relays ?? address?.relays ?? [],
    /** Where inside the site the address pointed, if it pointed anywhere. */
    path: address?.path ?? null,
    event: query.data?.event ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}
