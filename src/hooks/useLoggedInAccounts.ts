import { useNostr } from '@nostrify/react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQuery } from '@tanstack/react-query';
import { NSchema as n, NostrEvent, NostrMetadata } from '@nostrify/nostrify';
import { useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useNostrStorage } from '@/hooks/useNostrStorage';

export interface Account {
  id: string;
  pubkey: string;
  event?: NostrEvent;
  metadata: NostrMetadata;
}

/** Pair each login with the newest kind 0 among `events` for its pubkey. */
function accountsFrom(
  logins: ReadonlyArray<{ id: string; pubkey: string }>,
  events: NostrEvent[],
): Account[] {
  return logins.map(({ id, pubkey }): Account => {
    const event = events
      .filter((e) => e.pubkey === pubkey)
      .sort((a, b) => b.created_at - a.created_at)[0];
    try {
      const metadata = n.json().pipe(n.metadata()).parse(event?.content);
      return { id, pubkey, metadata, event };
    } catch {
      return { id, pubkey, metadata: {}, event };
    }
  });
}

export function useLoggedInAccounts() {
  const { nostr } = useNostr();
  const { store } = useNostrStorage();
  const { logins, setLogin, removeLogin } = useNostrLogin();

  const queryKey = useMemo(
    () => ['nostr', 'logins', logins.map((l) => l.id).join(';')],
    [logins],
  );

  const pubkeys = useMemo(() => logins.map((l) => l.pubkey), [logins]);

  // Whose account this is should not be a question the app has to ask a relay
  // every time it starts. The user's own name and avatar sit in the corner of
  // every screen, and they are the one profile guaranteed to have been fetched
  // before.
  useCacheFirstSeedMany<Account[]>({
    queryKey: logins.length > 0 ? queryKey : undefined,
    filters: [{ kinds: [0], authors: pubkeys }],
    toData: (events) => accountsFrom(logins, events),
  });

  const { data: authors = [], isLoading } = useQuery({
    queryKey,
    queryFn: async (c) => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(1500)]);
      const events = await nostr.query([{ kinds: [0], authors: pubkeys }], { signal });

      // A relay that didn't answer for one of these must not cost that account
      // its name. Anything it didn't return is filled in from disk.
      const missing = pubkeys.filter((pubkey) => !events.some((e) => e.pubkey === pubkey));
      const cached = missing.length
        ? await store.query([{ kinds: [0], authors: missing }]).catch(() => [])
        : [];

      return accountsFrom(logins, [...events, ...cached]);
    },
    retry: 1,
  });

  // Current user is the first login
  const currentUser: Account | undefined = (() => {
    const login = logins[0];
    if (!login) return undefined;
    const author = authors.find((a) => a.id === login.id);
    return { metadata: {}, ...author, id: login.id, pubkey: login.pubkey };
  })();

  // Other users are all logins except the current one
  const otherUsers = (authors || []).slice(1) as Account[];

  return {
    authors,
    currentUser,
    otherUsers,
    isLoading,
    setLogin,
    removeLogin,
  };
}
