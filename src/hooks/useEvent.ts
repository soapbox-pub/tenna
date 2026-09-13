import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';

import { useCacheFirstSeed } from '@/hooks/useCacheFirstSeed';
import { HEX64 } from '@/lib/draftEvent';

/**
 * One event, by id.
 *
 * Wanted by exactly one thing: the card that draws an event about to be
 * signed. A reaction, a repost, or a reply is a sentence about somebody else's
 * note, and the note is the half that decides whether a person wants to sign
 * it — "React ❤️ to note1qqq…" is not a question anybody can answer.
 *
 * So this is deliberately impatient. The prompt is already on screen when the
 * request goes out, the card reads perfectly well without it, and the window
 * it is in exists to be closed. A relay that has not answered in two seconds
 * has missed its chance rather than earned a spinner.
 *
 * `enabled` is for the callers that have no id to look up, which is most of
 * them: the tag may be absent, or hold something that is not an event id.
 */
export function useEvent(id: string | undefined, options?: { enabled?: boolean }) {
  const { nostr } = useNostr();

  const valid = Boolean(id && HEX64.test(id));
  const enabled = (options?.enabled ?? true) && valid;

  // Whatever the app already has of it. A note being replied to is very often
  // one this device fetched before, and drawing it on the first frame is the
  // difference between context and a placeholder that arrives too late to
  // inform the decision.
  useCacheFirstSeed<NostrEvent | null>({
    queryKey: enabled && id ? ['nostr', 'event', id] : undefined,
    filter: { ids: id ? [id] : [] },
    toData: (event) => event,
    getEvent: (data) => data ?? undefined,
  });

  return useQuery<NostrEvent | null>({
    enabled,
    queryKey: ['nostr', 'event', id ?? ''],
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(2000)]);
      const [event] = await nostr.query([{ ids: [id!], limit: 1 }], { signal });
      return event ?? null;
    },
    // An event is immutable, so what was fetched once is true for as long as
    // the window lives.
    staleTime: Infinity,
    retry: false,
  });
}
