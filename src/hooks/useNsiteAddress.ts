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

/**
 * The site an address names, if what was typed is an address at all.
 *
 * This is the other half of the search box: a name is looked for in the
 * catalog, and an `naddr`, `npub` or gateway URL is looked for on the relays.
 * The two answer the same question — which site did you mean — so they are one
 * field, and this hook simply stays idle for anything that doesn't parse.
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
  const immutable = address !== null && 'ids' in address.filter;

  const filters = useMemo(() => (address ? [address.filter] : []), [address]);

  // Pasting back an address that was pasted before — which is most of them,
  // since an address is something a person keeps and re-uses.
  useCacheFirstSeedMany<NostrEvent | null>({
    queryKey: address ? ['nsite-address', trimmed] : undefined,
    filters,
    toData: (events) => newestServable(events) ?? undefined,
  });

  const query = useQuery({
    queryKey: ['nsite-address', trimmed],
    enabled: address !== null,
    queryFn: async (c): Promise<NostrEvent | null> => {
      if (!address) return null;

      if (immutable) {
        const cached = newestServable(await store.query([address.filter]).catch(() => []));
        if (cached) return cached;
      }

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const urls = [...new Set([NSITE_RELAY, ...address.relays])];
      const events = await nostr.group(urls).query([address.filter], { signal });

      return newestServable(events);
    },
    staleTime: 60_000,
    retry: 1,
  });

  return {
    /** Whether the box holds an address, and so whether the list is this. */
    isAddress: address !== null,
    /** Relays this site came from, to be kept with it if it is added. */
    relays: address?.relays ?? [],
    event: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}
