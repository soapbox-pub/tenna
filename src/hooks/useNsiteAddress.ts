import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useNostrStorage } from '@/hooks/useNostrStorage';
import { lookupNip05 } from '@/lib/nip05';
import { nip05Pointer, nsitePointerFilter, parseNsiteAddress, type NsiteAddress } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { NSITE_RELAY } from '@/lib/tenna';

/** The newest servable manifest among some events, or null if there is none. */
function newestServable(events: NostrEvent[]): NostrEvent | null {
  return events.filter(isServableNsite).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/**
 * What an address turned out to name.
 *
 * The relays are in here rather than read off the parsed address because an
 * address does not always know its own hints: a NIP-05 name picks them up from
 * the document that resolved it, which is a fetch away.
 */
interface NsiteAddressResult {
  event: NostrEvent | null;
  relays: string[];
}

/** The filter an address names, as far as it can be known without asking. */
function filterFor(address: NsiteAddress | null): NostrFilter | null {
  return address?.type === 'filter' ? address.filter : null;
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
 *
 * An `nsite://` URL that names its author by NIP-05 costs one more round trip
 * than the rest, because the name has to be resolved to a key before there is
 * a filter to ask a relay for. The key is what the site is: the manifest that
 * comes back is re-derived into a `siteId` by whoever uses it, so the name
 * never reaches the site's origin, its storage, or its grants.
 */
export function useNsiteAddress(input: string) {
  const { nostr } = useNostr();
  const { store } = useNostrStorage();

  const trimmed = input.trim();
  const address = useMemo(() => parseNsiteAddress(trimmed), [trimmed]);

  // A snapshot is named by its own event id, so it is already exactly the
  // bytes it will always be. Once one is on disk there is no newer version to
  // go looking for, and the relays have nothing to add.
  const known = filterFor(address);
  const immutable = known !== null && 'ids' in known;

  const filters = useMemo(() => (known ? [known] : []), [known]);

  // Pasting back an address that was pasted before — which is most of them,
  // since an address is something a person keeps and re-uses.
  //
  // Only for an address that already knows its filter. A NIP-05 name has none
  // until a web server has answered, and seeding the query with a site fetched
  // under the name's *previous* key would be the one thing this grammar is
  // arranged to prevent.
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
    queryFn: async (c): Promise<NsiteAddressResult> => {
      if (!address) return { event: null, relays: [] };

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);

      // Resolve the name first, if the address is one. Whatever relays the
      // document named ride along with the key it named them for.
      let filter: NostrFilter;
      let relays: string[];

      if (address.type === 'nip05') {
        const resolved = await lookupNip05(address.domain, address.name, signal);
        if (!resolved) return { event: null, relays: [] };
        filter = nsitePointerFilter(nip05Pointer(resolved.pubkey, address.identifier));
        relays = resolved.relays;
      } else {
        filter = address.filter;
        relays = address.relays;

        if (immutable) {
          const cached = newestServable(await store.query([filter]).catch(() => []));
          if (cached) return { event: cached, relays };
        }
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
    relays: query.data?.relays ?? (address?.type === 'filter' ? address.relays : []),
    /** Where inside the site the address pointed, if it pointed anywhere. */
    path: address?.path ?? null,
    event: query.data?.event ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}
