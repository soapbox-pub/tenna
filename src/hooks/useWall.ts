import { useCallback, useEffect, useMemo } from 'react';

import { useLocalStorage } from '@/hooks/useLocalStorage';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { hexToBase36, parseNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { APP_ID, DEFAULT_NSITES, TEAM_SOAPBOX_PUBKEY } from '@/lib/tenna';
import { nativeAppUri, nsiteUri, parseWallUri, wallUriKey } from '@/lib/wallUri';

const STORAGE_KEY = `${APP_ID}:wall`;

/** Where the wall was kept when a site and an app were two different lists. */
const LEGACY_NSITES = `${APP_ID}:added-nsites`;
const LEGACY_APPS = `${APP_ID}:added-native-apps`;

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

/**
 * Everything on the wall, in the order it sits there.
 *
 * One list, holding both kinds of tile, because that is what the person
 * looking at the screen sees: a phone does not sort its home screen by what
 * technology is behind each icon, and neither does this one.
 *
 * The list is the wall. It is on the device, it is read in one synchronous
 * call, and every address on it is drawn — nothing here asks a relay or the
 * package manager, and nothing a relay says can take a tile away. What is
 * stored is an address rather than the thing it names, so each tile resolves
 * its own (see `WallTile`), and a tile whose site hasn't answered yet is
 * still a tile: its place, its name as best it can be known, and its menu.
 *
 * The list is state, so it must be held in one place: two components calling
 * this hook get two copies of it, and a change in one is invisible to the
 * other until a reload. The wall owns it and hands the verbs down.
 */
export function useWall() {
  const [uris, setUris] = useLocalStorage<string[]>(STORAGE_KEY, initialWall(), SERIALIZER);

  // Tell the native side what is on the wall.
  //
  // Being on the wall is what keeps a site's record — its manifest, its icon,
  // its place in the share sheet — and none of the code that needs to know
  // can see local storage: a site's own window decides whether to forget its
  // record with no wall in memory, and the share sheet is read by the system
  // when nothing of Tenna's is running at all.
  const wallSiteIds = useMemo(
    () =>
      uris.flatMap((uri) => {
        const address = parseWallUri(uri);
        return address?.kind === 'nsite' ? [address.id] : [];
      }),
    [uris],
  );

  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    void NsiteShortcuts.setWall({ siteIds: wallSiteIds }).catch(() => {
      // An older build than this method, or a write that failed. The next
      // change to the wall says the whole thing again.
    });
  }, [wallSiteIds]);

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
    add,
    remove,
    move,
  };
}
