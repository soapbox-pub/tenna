import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useInstalledApps } from '@/hooks/useNativeApps';
import type { NativeApp } from '@/lib/nativeAppsPlugin';
import { nsitePointerFilter } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { getNsiteSubdomain, hexToBase36, parseNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { APP_ID, DEFAULT_NSITES, NSITE_RELAY, TEAM_SOAPBOX_PUBKEY } from '@/lib/tenna';
import { nativeAppUri, nsiteUri, parseWallUri, wallUriKey, type WallAddress } from '@/lib/wallUri';

const STORAGE_KEY = `${APP_ID}:wall`;

/** Where the wall was kept when a site and an app were two different lists. */
const LEGACY_NSITES = `${APP_ID}:added-nsites`;
const LEGACY_APPS = `${APP_ID}:added-native-apps`;

/** One tile, with whatever it takes to draw it resolved. */
export type WallItem =
  | {
      uri: string;
      kind: 'nsite';
      event: NostrEvent;
      /** Its place among the sites, which is the channel it tunes to. */
      channel: number;
    }
  | { uri: string; kind: 'app'; app: NativeApp };

/**
 * What a wall nobody has touched starts out with.
 *
 * Three apps and then the plus. A home screen shipped full is a home screen
 * the user reads as furniture rather than as theirs; a few tiles and an
 * obvious empty slot say what the wall is for and leave the rest of it to
 * them. Every one of these can be moved or taken off, and nothing puts them
 * back.
 */
const DEFAULTS = DEFAULT_NSITES.map((identifier) =>
  nsiteUri(`${hexToBase36(TEAM_SOAPBOX_PUBKEY)}${identifier}`),
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

/** The sites on the wall, in wall order, with the relays to look for them on. */
function nsiteAddresses(uris: string[]): Array<{ uri: string; id: string; relays: string[] }> {
  return uris
    .map((uri) => ({ uri, address: parseWallUri(uri) }))
    .filter(
      (entry): entry is { uri: string; address: Extract<WallAddress, { kind: 'nsite' }> } =>
        entry.address?.kind === 'nsite',
    )
    .map(({ uri, address }) => ({ uri, id: address.id, relays: address.relays }));
}

/**
 * Everything on the wall, in the order it sits there.
 *
 * One list, holding both kinds of tile, because that is what the person
 * looking at the screen sees: a phone does not sort its home screen by what
 * technology is behind each icon, and neither does this one. What is stored
 * is an address rather than the thing it names — a site republishes and
 * everything about it changes but its address, an app updates and is renamed
 * — so both are resolved fresh every time the wall is drawn.
 *
 * The list is state, so it must be held in one place: two components calling
 * this hook get two copies of it, and a change in one is invisible to the
 * other until a reload. The wall owns it and hands the verbs down.
 */
export function useWall() {
  const { nostr } = useNostr();
  const [uris, setUris] = useLocalStorage<string[]>(STORAGE_KEY, initialWall(), SERIALIZER);

  const sites = useMemo(() => nsiteAddresses(uris), [uris]);
  const installed = useInstalledApps();

  // Tell the native side what is on the wall.
  //
  // Being on the wall is what keeps a site's record — its manifest, its icon,
  // its place in the share sheet — and none of the code that needs to know
  // can see local storage: a site's own window decides whether to forget its
  // record with no wall in memory, and the share sheet is read by the system
  // when nothing of Tenna's is running at all.
  //
  // The stored addresses rather than the drawn tiles, because a site whose
  // manifest hasn't arrived is still a site the user has.
  const wallSiteIds = useMemo(() => sites.map(({ id }) => id), [sites]);

  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    void NsiteShortcuts.setWall({ siteIds: wallSiteIds }).catch(() => {
      // An older build than this method, or a write that failed. The next
      // change to the wall says the whole thing again.
    });
  }, [wallSiteIds]);

  // Sorted, so the key is the *set* of sites on the wall and not the order
  // they sit in. Dragging one tile past another asks for exactly the same
  // manifests; a key that moved with them would be a cache entry nobody had
  // filled yet, and the whole wall would drop back to static on every drop.
  const queryKey = useMemo(
    () => ['wall-nsites', [...sites.map(({ uri }) => uri)].sort()],
    [sites],
  );

  const filters = useMemo(
    () =>
      sites
        .map(({ id }) => parseNsiteSubdomain(id))
        .filter((pointer) => pointer !== null)
        .map(nsitePointerFilter),
    [sites],
  );

  // The wall is what the app opens on, and a site whose manifest hasn't come
  // back draws nothing at all — so without this the first thing anyone sees on
  // a cold start is an empty screen, held for as long as a relay takes. The
  // manifests are the same ones as last time; they are already on disk.
  useCacheFirstSeedMany<NostrEvent[]>({
    queryKey: sites.length > 0 ? queryKey : undefined,
    filters,
    toData: (events) => {
      const servable = events.filter(isServableNsite);
      return servable.length > 0 ? servable : undefined;
    },
  });

  const manifests = useQuery({
    queryKey,
    // And when the set really does change, the manifests already in hand are
    // still the right ones for the sites that didn't. Adding a tile should
    // add a tile, not blank the wall while a relay answers.
    placeholderData: keepPreviousData,
    enabled: sites.length > 0,
    queryFn: async (c): Promise<NostrEvent[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);

      // Whatever relays the addresses came with, alongside the one the rest of
      // the wall is served from: a site added by an naddr from elsewhere lives
      // where that naddr said it does.
      const urls = [...new Set([NSITE_RELAY, ...sites.flatMap(({ relays }) => relays)])];

      const events = await nostr.group(urls).query(filters, { signal });
      return events.filter(isServableNsite);
    },
    staleTime: 60_000,
  });

  const items = useMemo((): WallItem[] => {
    // One manifest per site, the newest of the ones on offer. A relay may
    // answer with an older replaceable it hasn't caught up on, or not at all.
    const byId = new Map<string, NostrEvent>();
    for (const event of manifests.data ?? []) {
      const id = getNsiteSubdomain(event);
      const seen = byId.get(id);
      if (!seen || seen.created_at < event.created_at) byId.set(id, event);
    }

    const live = installed.data;
    const byAppId = live && new Map(live.map((app) => [app.id, app]));

    const wall: WallItem[] = [];
    let channel = 0;

    for (const uri of uris) {
      const address = parseWallUri(uri);
      if (!address) continue;

      if (address.kind === 'nsite') {
        const event = byId.get(address.id);
        // A site whose manifest hasn't arrived draws nothing, so it holds no
        // slot and takes no channel; it appears when the relay answers.
        if (!event) continue;
        wall.push({ uri, kind: 'nsite', event, channel: ++channel });
        continue;
      }

      const id = `${address.packageName}/${address.activityName}`;

      // Still asking the device. Show the app under the name it was added by
      // rather than leaving a hole; a tile whose app turns out to be gone is
      // corrected a moment later.
      if (!byAppId) {
        wall.push({
          uri,
          kind: 'app',
          app: {
            id,
            packageName: address.packageName,
            activityName: address.activityName,
            label: address.label ?? address.packageName,
          },
        });
        continue;
      }

      const app = byAppId.get(id);
      if (app) wall.push({ uri, kind: 'app', app });
    }

    return wall;
  }, [uris, manifests.data, installed.data]);

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
      setUris((prev) => prev.filter((existing) => existing !== uri));
    },
    [setUris],
  );

  /**
   * Put the tile at `from` where the tile at `to` is, closing the gap behind
   * it — which is what dragging one icon across a home screen does.
   *
   * The indices are into the drawn wall, not the stored list, since those are
   * not the same list: a site whose manifest hasn't arrived is stored but not
   * drawn. So the move is made in terms of the URIs at those positions.
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
    /** The addresses on file, in wall order. */
    uris,
    /** Those of them that resolve to something drawable, in the same order. */
    items,
    isLoading: manifests.isLoading || installed.isLoading,
    add,
    remove,
    move,
  };
}
