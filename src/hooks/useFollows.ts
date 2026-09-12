import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useCurrentUser } from '@/hooks/useCurrentUser';

/**
 * How many follows are worth putting in one filter.
 *
 * An `authors` list is sent to the relay verbatim, and a follow list can run
 * to thousands. Past a point the REQ is large enough that a relay may refuse
 * it outright, which would cost the whole catalog rather than its tail, so it
 * is cut here instead.
 */
const MAX_FOLLOWS = 1000;

/**
 * Who the logged-in user follows, by pubkey — the `p` tags of their NIP-02
 * contact list (kind 3).
 *
 * Read from the user's own relays rather than the nsite relay: a contact list
 * is a thing about the person, not about nsites, and it is what the rest of
 * Nostr already has of them.
 *
 * Nobody logged in is not an error, it's an empty list — the query simply
 * stays idle, and so reports neither loading nor failure.
 */
/** The pubkeys a contact list follows, capped at {@link MAX_FOLLOWS}. */
function followsFrom(event: NostrEvent): string[] {
  const follows = new Set<string>();
  for (const [name, value] of event.tags) {
    // Tags come off an event unchecked, and each one here becomes a filter
    // term; anything that isn't a pubkey is not a follow.
    if (name === 'p' && /^[0-9a-f]{64}$/.test(value ?? '')) follows.add(value);
    if (follows.size >= MAX_FOLLOWS) break;
  }
  return [...follows];
}

export function useFollows(options?: { enabled?: boolean }) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  // Nobody logged in is nothing to ask, and so is a caller that hasn't been
  // looked at yet — see `useNsiteCatalog`, which is the only thing that wants
  // this and does not always want it.
  const enabled = (options?.enabled ?? true) && Boolean(pubkey);

  // The catalog waits on this list before it will ask for anything, so a cold
  // start spends a relay round trip here before it can spend another one
  // there. Last launch's contact list is a good enough answer to get moving
  // on, and the query below corrects it.
  useCacheFirstSeedMany<string[]>({
    queryKey: enabled && pubkey ? ['follows', pubkey] : undefined,
    filters: [{ kinds: [3], authors: pubkey ? [pubkey] : [], limit: 1 }],
    toData: ([event]) => followsFrom(event),
  });

  return useQuery({
    queryKey: ['follows', pubkey ?? ''],
    enabled,
    queryFn: async (c): Promise<string[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(5000)]);
      const [event] = await nostr.query([{ kinds: [3], authors: [pubkey!], limit: 1 }], { signal });
      if (!event) return [];

      return followsFrom(event);
    },
    staleTime: 5 * 60_000,
  });
}
