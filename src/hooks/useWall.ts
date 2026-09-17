import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { forgetSynced } from '@/hooks/useNsitePin';
import { useNostrStorage } from '@/hooks/useNostrStorage';
import { nsitePointerFilter } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { getNsiteSubdomain, hexToBase36, parseNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { APP_ID, DEFAULT_NSITES, NSITE_RELAY } from '@/lib/tenna';
import { removeTileSnapshot } from '@/lib/tileSnapshot';
import { nativeAppUri, nsiteUri, parseWallUri, wallUriKey } from '@/lib/wallUri';

const STORAGE_KEY = `${APP_ID}:wall`;

/** Where the wall was kept when a site and an app were two different lists. */
const LEGACY_NSITES = `${APP_ID}:added-nsites`;
const LEGACY_APPS = `${APP_ID}:added-native-apps`;

/**
 * What a wall nobody has touched starts out with.
 *
 * Apps, and then the plus. A starting set rather than a lineup: enough that
 * the first screen shows what a site on a wall looks like and is worth
 * opening, with the empty slot after it saying the rest is theirs. Every one
 * of these can be moved or taken off, and nothing puts them back.
 */
const DEFAULTS = DEFAULT_NSITES.map(({ pubkey, identifier }) =>
  nsiteUri(`${hexToBase36(pubkey)}${identifier}`),
);

/** Only the shape survives a round trip through localStorage; check it. */
function tidy(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((uri): uri is string => typeof uri === 'string' && parseWallUri(uri) !== null);
}

/** Stable across renders, so the storage listener isn't rebound on each one. */
const SERIALIZER = {
  serialize: JSON.stringify,
  deserialize: (value: string): string[] => tidy(JSON.parse(value)),
};

/**
 * The wall as the two old lists left it: sites first, then device apps.
 *
 * That is the order they were drawn in when they were separate, so a wall
 * carried across looks exactly as it did before it could be rearranged. Read
 * once, and only when there is no combined list yet — after that the two old
 * keys are dead weight nobody reads, left in place rather than deleted so a
 * downgrade still finds them.
 */
function migrate(): string[] | null {
  const uris: string[] = [];

  try {
    const sites: unknown = JSON.parse(localStorage.getItem(LEGACY_NSITES) ?? 'null');
    if (Array.isArray(sites)) {
      for (const site of sites) {
        const { id, relays } = (site ?? {}) as { id?: unknown; relays?: unknown };
        if (typeof id !== 'string' || !parseNsiteSubdomain(id)) continue;
        uris.push(nsiteUri(id, Array.isArray(relays) ? relays.filter((r) => typeof r === 'string') : []));
      }
    }

    const apps: unknown = JSON.parse(localStorage.getItem(LEGACY_APPS) ?? 'null');
    if (Array.isArray(apps)) {
      for (const app of apps) {
        const { packageName, activityName, label } = (app ?? {}) as Record<string, unknown>;
        if (typeof packageName !== 'string' || !packageName) continue;
        if (typeof activityName !== 'string' || !activityName) continue;
        uris.push(
          nativeAppUri({
            packageName,
            activityName,
            label: typeof label === 'string' ? label : null,
          }),
        );
      }
    }
  } catch {
    // Unreadable legacy state is the same as none.
  }

  return uris.length > 0 ? uris : null;
}

/** Worked out once, since it is the initial value of a piece of state. */
let initial: string[] | undefined;

function initialWall(): string[] {
  if (!initial) {
    const stored = (() => {
      try {
        return localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    })();

    initial = stored !== null ? DEFAULTS : (migrate() ?? DEFAULTS);
  }
  return initial;
}

/** One manifest per site, the newest of those on offer. */
function newestPerSite(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (!isServableNsite(event)) continue;
    const id = getNsiteSubdomain(event);
    const seen = byId.get(id);
    if (!seen || seen.created_at < event.created_at) byId.set(id, event);
  }
  return [...byId.values()];
}

/**
 * Everything on the wall, in the order it sits there.
 *
 * One list, holding both kinds of tile, because that is what the person
 * looking at the screen sees: a phone does not sort its home screen by what
 * technology is behind each icon, and neither does this one.
 *
 * The list is the wall. It is on the device, it is read in one synchronous
 * call, and every address on it is drawn. What is stored is an address rather
 * than the thing it names, so the sites' manifests are looked up alongside —
 * one query for all of them — and handed back by site; a site whose manifest
 * hasn't arrived is still a tile, and nothing a relay says can take one away.
 *
 * The list is state, so it must be held in one place: two components calling
 * this hook get two copies of it, and a change in one is invisible to the
 * other until a reload. The wall owns it and hands the verbs down.
 */
export function useWall() {
  const { nostr } = useNostr();
  const { store } = useNostrStorage();
  const queryClient = useQueryClient();
  const [uris, setUris] = useLocalStorage<string[]>(STORAGE_KEY, initialWall(), SERIALIZER);

  const sites = useMemo(
    () =>
      uris.flatMap((uri) => {
        const address = parseWallUri(uri);
        return address?.kind === 'nsite' ? [address] : [];
      }),
    [uris],
  );

  // Tell the native side what is on the wall.
  //
  // Being on the wall is what keeps a site's record — its manifest, its icon,
  // its place in the share sheet — and none of the code that needs to know
  // can see local storage: a site's own window decides whether to forget its
  // record with no wall in memory, and the share sheet is read by the system
  // when nothing of Tenna's is running at all.
  const wallSiteIds = useMemo(() => sites.map(({ id }) => id), [sites]);

  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    void NsiteShortcuts.setWall({ siteIds: wallSiteIds }).catch(() => {
      // An older build than this method, or a write that failed. The next
      // change to the wall says the whole thing again.
    });
  }, [wallSiteIds]);

  // The sites' manifests, all in one query. Keyed by the *set* of sites, so
  // dragging one past another asks for nothing new.
  const queryKey = useMemo(() => ['wall-nsites', [...wallSiteIds].sort()], [wallSiteIds]);

  const filters = useMemo(
    () =>
      sites
        .map(({ id }) => parseNsiteSubdomain(id))
        .filter((pointer) => pointer !== null)
        .map(nsitePointerFilter),
    [sites],
  );

  // Off the disk first, so the wall is whole before any relay has answered.
  useCacheFirstSeedMany<NostrEvent[]>({
    queryKey: sites.length > 0 ? queryKey : undefined,
    filters,
    toData: (events) => {
      const servable = newestPerSite(events);
      return servable.length > 0 ? servable : undefined;
    },
  });

  const manifests = useQuery({
    queryKey,
    placeholderData: keepPreviousData,
    enabled: sites.length > 0,
    queryFn: async (c): Promise<NostrEvent[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const urls = [...new Set([NSITE_RELAY, ...sites.flatMap(({ relays }) => relays)])];

      // The pool returns whatever had arrived when its timeout fired as
      // though it were the whole answer. So the relay's reply is one input
      // among three — with what the query already holds and what is on disk
      // — and the newest manifest per site wins. A short reply adds nothing
      // and takes nothing.
      const [fetched, stored] = await Promise.all([
        nostr.group(urls).query(filters, { signal }).catch((): NostrEvent[] => []),
        store.query(filters).catch((): NostrEvent[] => []),
      ]);
      const held = queryClient.getQueryData<NostrEvent[]>(queryKey) ?? [];

      return newestPerSite([...held, ...stored, ...fetched]);
    },
    staleTime: 60_000,
  });

  const events = useMemo(
    () => new Map((manifests.data ?? []).map((event) => [getNsiteSubdomain(event), event])),
    [manifests.data],
  );

  const add = useCallback(
    (uri: string) => {
      const address = parseWallUri(uri);
      if (!address) return;
      const key = wallUriKey(address);

      setUris((prev) => {
        const already = prev.some((existing) => {
          const parsed = parseWallUri(existing);
          return parsed !== null && wallUriKey(parsed) === key;
        });
        return already ? prev : [...prev, uri];
      });
    },
    [setUris],
  );

  const remove = useCallback(
    (uri: string) => {
      const address = parseWallUri(uri);
      if (address?.kind === 'nsite') {
        removeTileSnapshot(address.id);
        forgetSynced(address.id);
      }
      setUris((prev) => prev.filter((existing) => existing !== uri));
    },
    [setUris],
  );

  /**
   * Put the tile at `from` where the tile at `to` is, closing the gap behind
   * it — which is what dragging one icon across a home screen does.
   *
   * In terms of the URIs rather than their indices, so a caller holding a
   * stale copy of the list still names the tiles it meant.
   */
  const move = useCallback(
    (fromUri: string, toUri: string) => {
      setUris((prev) => {
        const from = prev.indexOf(fromUri);
        const to = prev.indexOf(toUri);
        if (from < 0 || to < 0 || from === to) return prev;

        const next = [...prev];
        next.splice(from, 1);
        next.splice(to, 0, fromUri);
        return next;
      });
    },
    [setUris],
  );

  return {
    /** The addresses on the wall, in wall order. Every one of them is drawn. */
    uris,
    /** The sites on the wall, in wall order. The device's own apps are not here. */
    siteIds: wallSiteIds,
    /** The sites' manifests, by subdomain, as far as they have arrived. */
    events,
    add,
    remove,
    move,
  };
}
