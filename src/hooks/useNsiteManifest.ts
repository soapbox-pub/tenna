import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { useNostrStorage } from '@/hooks/useNostrStorage';
import { nsitePointerFilter } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { NSITE_SNAPSHOT_KIND, parseNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { NSITE_RELAY } from '@/lib/tenna';

/** The newest servable manifest among some events, or null if there is none. */
function newestServable(events: NostrEvent[]): NostrEvent | null {
  return events.filter(isServableNsite).sort((a, b) => b.created_at - a.created_at)[0] ?? null;
}

/**
 * One site's manifest, by its subdomain.
 *
 * Per site rather than per wall, so that adding, removing or dragging a tile
 * touches no other tile's answer, and so that each tile can be drawn the
 * moment its own manifest is in hand rather than when the last of them is.
 *
 * The answer only ever gets newer. What is on disk is put up first, and the
 * relay's reply is taken only where it is at least as new as what is already
 * held — a relay that answers late, short or not at all on a bad connection
 * says nothing about whether the site exists, and a manifest the app served
 * from last week is a manifest it can serve from today. When nothing has
 * come back from anywhere the query fails rather than resolving to "no
 * site", so the tile keeps its place and the lookup is tried again.
 */
export function useNsiteManifest(id: string, relays: readonly string[] = []) {
  const { nostr } = useNostr();
  const { store } = useNostrStorage();
  const queryClient = useQueryClient();

  const pointer = useMemo(() => parseNsiteSubdomain(id), [id]);
  const filter = useMemo(() => (pointer ? nsitePointerFilter(pointer) : null), [pointer]);
  const queryKey = useMemo(() => ['nsite-manifest', id], [id]);

  // Relays are hints: the same site named by two naddrs is one site, and its
  // key must not say otherwise.
  const relayKey = [...new Set([NSITE_RELAY, ...relays])].sort().join(' ');

  // Straight off the disk on the first frame, if it has been fetched before.
  // Never downgrades: the relay may already have answered by the time the
  // store does, and a newer manifest is not replaced by an older one.
  useEffect(() => {
    if (!filter) return;

    let cancelled = false;

    void (async () => {
      const cached = newestServable(await store.query([filter]).catch(() => []));
      if (cancelled || !cached) return;

      const held = queryClient.getQueryData<NostrEvent>(queryKey);
      if (held && held.created_at >= cached.created_at) return;

      queryClient.setQueryData<NostrEvent>(queryKey, cached);
    })();

    return () => {
      cancelled = true;
    };
  }, [filter, queryKey, store, queryClient]);

  return useQuery({
    queryKey,
    enabled: filter !== null,
    queryFn: async (c): Promise<NostrEvent> => {
      if (!filter || !pointer) throw new Error(`Not an nsite: ${id}`);

      const held = queryClient.getQueryData<NostrEvent>(queryKey);

      // A snapshot is named by its own event id, so it is already exactly the
      // bytes it will always be. One in hand is the whole answer.
      if (held && pointer.kind === NSITE_SNAPSHOT_KIND) return held;

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const urls = relayKey.split(' ');
      const fetched = await nostr.group(urls).query([filter], { signal });

      // The relay's answer, what the query holds, and what is on disk: the
      // newest wins. The pool returns whatever had arrived when its timeout
      // fired as though it were the whole answer, so an empty or stale reply
      // is a reply to be outranked, not one to be believed.
      const stored = await store.query([filter]).catch(() => []);
      const best = newestServable([...fetched, ...(held ? [held] : []), ...stored]);

      if (!best) throw new Error(`No manifest found for ${id}`);
      return best;
    },
    staleTime: 60_000,
  });
}
