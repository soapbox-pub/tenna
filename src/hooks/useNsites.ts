import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { NSITE_NAMED_KIND } from '@/lib/nsiteSubdomain';
import { CHANNEL_CURATOR_PUBKEY, NSITE_RELAY } from '@/lib/tenna';

/** A servable nsite needs a `d` tag and at least an `/index.html` entry. */
function isValidNsite(event: NostrEvent): boolean {
  const d = event.tags.find(([name]) => name === 'd')?.[1];
  const hasIndex = event.tags.some(
    ([name, path, sha256]) => name === 'path' && path === '/index.html' && sha256,
  );
  return Boolean(d && hasIndex);
}

/**
 * Fetch the curator's named nsites (NIP-5A kind 35128) — the channel lineup.
 *
 * Sorted oldest-first so channel numbers stay stable as new sites launch.
 */
export function useNsites() {
  const { nostr } = useNostr();

  return useQuery({
    queryKey: ['nsites', CHANNEL_CURATOR_PUBKEY],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.relay(NSITE_RELAY).query(
        [{ kinds: [NSITE_NAMED_KIND], authors: [CHANNEL_CURATOR_PUBKEY], limit: 100 }],
        { signal },
      );
      return events
        .filter(isValidNsite)
        .sort((a, b) => a.created_at - b.created_at);
    },
    staleTime: 60_000,
  });
}
