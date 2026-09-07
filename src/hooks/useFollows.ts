import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

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
export function useFollows() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  return useQuery({
    queryKey: ['follows', pubkey ?? ''],
    enabled: Boolean(pubkey),
    queryFn: async (c): Promise<string[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(5000)]);
      const [event] = await nostr.query([{ kinds: [3], authors: [pubkey!], limit: 1 }], { signal });
      if (!event) return [];

      const follows = new Set<string>();
      for (const [name, value] of event.tags) {
        // Tags come off an event unchecked, and each one here becomes a filter
        // term; anything that isn't a pubkey is not a follow.
        if (name === 'p' && /^[0-9a-f]{64}$/.test(value ?? '')) follows.add(value);
        if (follows.size >= MAX_FOLLOWS) break;
      }

      return [...follows];
    },
    staleTime: 5 * 60_000,
  });
}
