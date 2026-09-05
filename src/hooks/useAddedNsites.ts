import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useLocalStorage } from '@/hooks/useLocalStorage';
import { nsitePointerFilter } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { getNsiteSubdomain, parseNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { APP_ID, NSITE_RELAY } from '@/lib/tenna';

const STORAGE_KEY = `${APP_ID}:added-nsites`;

/** A site the user put on the wall themselves. */
export interface AddedNsite {
  /** Canonical NIP-5A subdomain — a site's identity everywhere in Tenna. */
  id: string;
  /** Relays the address it was added by named, if it named any. */
  relays?: string[];
}

/** Only the shape survives a round trip through localStorage; check it. */
function tidy(value: unknown): AddedNsite[] {
  if (!Array.isArray(value)) return [];

  const sites: AddedNsite[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, relays } = entry as Partial<AddedNsite>;
    if (typeof id !== 'string' || !parseNsiteSubdomain(id)) continue;
    sites.push({
      id,
      relays: Array.isArray(relays) ? relays.filter((r) => typeof r === 'string') : undefined,
    });
  }

  return sites;
}

/** Stable across renders, so the storage listener isn't rebound on each one. */
const SERIALIZER = {
  serialize: JSON.stringify,
  deserialize: (value: string): AddedNsite[] => tidy(JSON.parse(value)),
};

/**
 * The sites the user added by hand, and the manifests they currently resolve
 * to.
 *
 * What is kept is the address, not the manifest. A site publishes again and
 * everything about it changes but the address, so storing the manifest would
 * be storing the day it was added — the wall would show a version of the site
 * that no longer exists and no amount of the site publishing would fix it.
 *
 * The list is state, so it must be held in one place: two components calling
 * this hook get two copies of it, and an addition in one is invisible to the
 * other until a reload. The wall owns it and hands `add` down.
 */
export function useAddedNsites() {
  const { nostr } = useNostr();
  const [stored, setStored] = useLocalStorage<AddedNsite[]>(STORAGE_KEY, [], SERIALIZER);

  const query = useQuery({
    queryKey: ['added-nsites', stored],
    enabled: stored.length > 0,
    queryFn: async (c): Promise<NostrEvent[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);

      const filters = stored
        .map(({ id }) => parseNsiteSubdomain(id))
        .filter((pointer) => pointer !== null)
        .map(nsitePointerFilter);

      // Whatever relays the addresses came with, alongside the one the rest of
      // the wall is served from: a site added by an naddr from elsewhere lives
      // where that naddr said it does.
      const relays = [NSITE_RELAY, ...stored.flatMap(({ relays }) => relays ?? [])];
      const urls = [...new Set(relays)];

      const events = await nostr.group(urls).query(filters, { signal });
      const servable = events.filter(isServableNsite);

      // Back into the order the user added them, one manifest per site, the
      // newest of the ones on offer. A relay may answer with an older
      // replaceable it hasn't caught up on, or with nothing at all.
      return stored
        .map(({ id }) =>
          servable
            .filter((event) => getNsiteSubdomain(event) === id)
            .sort((a, b) => b.created_at - a.created_at)[0],
        )
        .filter((event) => event !== undefined);
    },
    staleTime: 60_000,
  });

  const add = useCallback(
    (site: AddedNsite) => {
      setStored((prev) => (prev.some(({ id }) => id === site.id) ? prev : [...prev, site]));
    },
    [setStored],
  );

  const remove = useCallback(
    (id: string) => {
      setStored((prev) => prev.filter((site) => site.id !== id));
    },
    [setStored],
  );

  return {
    /** The addresses on file, in the order they were added. */
    stored,
    /** The manifests those addresses resolve to right now. */
    events: query.data,
    isLoading: query.isLoading,
    add,
    remove,
  };
}
