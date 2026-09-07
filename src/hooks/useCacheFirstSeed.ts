import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useNostrStorage } from '@/hooks/useNostrStorage';

/**
 * Fill a query from the local event store while the network answers.
 *
 * Every hook here keeps its own `useQuery` and its own relay call; that query
 * stays the authority and overwrites whatever this put there the moment it
 * resolves. All this does is stop the first frame of a cold start from being
 * blank, using events the app already fetched on some previous launch. What
 * it must never do is go backwards — a seed that landed after a fresh network
 * result would undo it — so each variant below says how it decides that.
 */

interface CacheFirstSeedOptions<T> {
  /**
   * The query to fill. `undefined` disables the seed, for when a hook has no
   * key yet — no pubkey to look up, nothing on the wall.
   */
  queryKey: QueryKey | undefined;
  /** How to find the event in the store. The newest match is used. */
  filter: NostrFilter;
  /** Turn the stored event into the shape the query holds. */
  toData: (event: NostrEvent) => T;
  /** Find the event inside existing query data, to compare ages against. */
  getEvent: (data: T) => NostrEvent | undefined;
}

/**
 * Seed a query that holds a single event — a profile, a contact list, one
 * site's manifest.
 *
 * Never downgrades: if the query already holds an event at least as new as
 * the stored one, the stored one is dropped. That is also what closes the
 * race where a slow store read lands after a fast relay answer.
 */
export function useCacheFirstSeed<T>(opts: CacheFirstSeedOptions<T>): void {
  const { queryKey, filter, toData, getEvent } = opts;
  const queryClient = useQueryClient();
  const { store } = useNostrStorage();

  // Serialized so the effect re-runs when the key changes by value rather
  // than by identity — call sites build these inline.
  const queryKeyString = queryKey ? JSON.stringify(queryKey) : '';

  useEffect(() => {
    if (!queryKey) return;

    let cancelled = false;

    void (async () => {
      const [cached] = await store.query([filter]).catch(() => []);
      if (cancelled || !cached) return;

      const current = queryClient.getQueryData<T>(queryKey);
      const currentEvent = current ? getEvent(current) : undefined;
      if (currentEvent && currentEvent.created_at >= cached.created_at) return;

      queryClient.setQueryData<T>(queryKey, toData(cached));
    })();

    return () => {
      cancelled = true;
    };
    // `filter`, `toData` and `getEvent` are rebuilt every render at the call
    // sites; `queryKeyString` is what actually identifies this seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKeyString, store, queryClient]);
}

interface CacheFirstSeedManyOptions<T> {
  /** The query to fill, or `undefined` to disable the seed. */
  queryKey: QueryKey | undefined;
  /** How to find the events in the store. Filters are OR'd, as on a relay. */
  filters: NostrFilter[];
  /**
   * Turn the stored events into the shape the query holds. Return `undefined`
   * to decline — for a result set that isn't worth showing on its own.
   */
  toData: (events: NostrEvent[]) => T | undefined;
}

/**
 * Seed a query that holds a set of events — the wall, the catalog.
 *
 * Only ever fills a query that holds nothing at all. There is no general way
 * to tell whether a cached *set* is older than one in hand: it may be missing
 * a site the network just found, or hold one the network no longer returns.
 * Filling only the empty case is the version of this that cannot be wrong,
 * and the empty case is the one that matters — the cold start.
 */
export function useCacheFirstSeedMany<T>(opts: CacheFirstSeedManyOptions<T>): void {
  const { queryKey, filters, toData } = opts;
  const queryClient = useQueryClient();
  const { store } = useNostrStorage();

  const queryKeyString = queryKey ? JSON.stringify(queryKey) : '';

  useEffect(() => {
    if (!queryKey || filters.length === 0) return;
    // Asked before the read as well as after: no point going to disk for a
    // query that is already answered.
    if (queryClient.getQueryData(queryKey) !== undefined) return;

    let cancelled = false;

    void (async () => {
      const cached = await store.query(filters).catch(() => []);
      if (cancelled || cached.length === 0) return;
      if (queryClient.getQueryData(queryKey) !== undefined) return;

      const data = toData(cached);
      if (data !== undefined) queryClient.setQueryData<T>(queryKey, data);
    })();

    return () => {
      cancelled = true;
    };
    // As above: the key is what identifies the seed, and `filters` and
    // `toData` are rebuilt per render alongside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKeyString, store, queryClient]);
}
