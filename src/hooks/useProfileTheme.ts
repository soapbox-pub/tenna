import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { DITTO_THEME_KIND, parseDittoTheme, type DittoTheme } from '@/lib/dittoTheme';

/**
 * The theme somebody publishes for their own profile, for wearing on their
 * page.
 *
 * The same kind 16767 `NostrSync` reads for the logged-in user, asked about
 * anybody. Kept as a query rather than in the config, which is the difference
 * between the two: the user's own theme decides what colour the first frame of
 * a cold start is and has to be on disk before the relay is reached, and a
 * stranger's is only ever wanted while their page is open.
 *
 * `authors` is the whole of the trust here. A theme is a replaceable event, so
 * the pubkey is what makes it theirs; anything else answering this filter is
 * not this person's theme.
 *
 * Resolves to `null` for somebody who has published none, and for somebody
 * whose theme doesn't parse — a missing colour, a font behind a URL that isn't
 * https. Both mean the same thing to the page that asked: there is nothing of
 * theirs to wear.
 */
export function useProfileTheme(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<DittoTheme | null>({
    enabled: !!pubkey,
    queryKey: ['profile-theme', pubkey ?? ''],
    queryFn: async (c) => {
      if (!pubkey) return null;

      const events = await nostr.query(
        [{ kinds: [DITTO_THEME_KIND], authors: [pubkey], limit: 1 }],
        { signal: AbortSignal.any([c.signal, AbortSignal.timeout(5000)]) },
      );

      const event = events[0];
      return event ? parseDittoTheme(event) : null;
    },
    staleTime: 5 * 60 * 1000,
  });
}
