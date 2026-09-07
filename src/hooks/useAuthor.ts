import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useCacheFirstSeed } from '@/hooks/useCacheFirstSeed';
import { useNostrStorage } from '@/hooks/useNostrStorage';

export type AuthorResult = { event?: NostrEvent; metadata?: NostrMetadata };

/** A kind 0 event as its metadata, or as itself if the content won't parse. */
export function parseAuthorEvent(event: NostrEvent): AuthorResult {
  try {
    const metadata = n.json().pipe(n.metadata()).parse(event.content);
    return { metadata, event };
  } catch {
    return { event };
  }
}

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const { store } = useNostrStorage();
  const queryClient = useQueryClient();

  // A name and a face the app has seen before are drawn on the first frame
  // rather than after a relay answers. The query below still runs, and still
  // wins when it does.
  useCacheFirstSeed<AuthorResult>({
    queryKey: pubkey ? ['nostr', 'author', pubkey] : undefined,
    filter: { kinds: [0], authors: pubkey ? [pubkey] : [] },
    toData: parseAuthorEvent,
    getEvent: (data) => data.event,
  });

  return useQuery<AuthorResult>({
    queryKey: ['nostr', 'author', pubkey ?? ''],
    queryFn: async (c) => {
      if (!pubkey) {
        return {};
      }

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(1500)]);
      const [event] = await nostr.query([{ kinds: [0], authors: [pubkey], limit: 1 }], { signal });

      if (!event) {
        // A miss is not a failure. Plenty of pubkeys have no profile at all,
        // and the answer for one of those is "nothing", arrived at once —
        // throwing here meant three more rounds of the same 1.5s timeout
        // before the caller was told what the first attempt already knew.
        // What must not happen is losing a profile already on screen, so
        // whatever is in hand or on disk stands in.
        const existing = queryClient.getQueryData<AuthorResult>(['nostr', 'author', pubkey]);
        if (existing?.event) return existing;

        const [cached] = await store.query([{ kinds: [0], authors: [pubkey] }]).catch(() => []);
        return cached ? parseAuthorEvent(cached) : {};
      }

      // Never go back to an older profile than one already held. Relays lag,
      // so in the moments after the user edits their own profile a relay may
      // still be serving the previous kind 0 — taking it would blank whatever
      // they just saved. The newest of what the relay said, what the query
      // holds, and what is on disk wins.
      const [stored] = await store.query([{ kinds: [0], authors: [pubkey] }]).catch(() => []);
      const existing = queryClient.getQueryData<AuthorResult>(['nostr', 'author', pubkey]);

      let newest = event;
      if (existing?.event && existing.event.created_at > newest.created_at) newest = existing.event;
      if (stored && stored.created_at > newest.created_at) newest = stored;

      return parseAuthorEvent(newest);
    },
    staleTime: 5 * 60 * 1000, // Keep cached data fresh for 5 minutes
    retry: 1,
  });
}
