import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@/hooks/useToast';
import type { NsiteApp } from '@/hooks/useNsiteApp';
import { renderAppBadgePng } from '@/lib/appBadgeBitmap';
import { renderAppIconPng } from '@/lib/appIconBitmap';
import { impactLight, notificationError } from '@/lib/haptics';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { shareCategories } from '@/lib/nsiteShareTarget';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { APP_ID } from '@/lib/tenna';

/**
 * Bump when what `sync` writes down changes — the tile drawing, the badge —
 * so every site is told again on the next launch.
 */
const SYNC_VERSION = 1;

const syncKey = (siteId: string) => `${APP_ID}:synced:${siteId}`;

/**
 * Forget that a site was told to the system, so the next tile drawn for it
 * says everything again. For the wall, when a site comes off it: the record
 * is swept then, and a site added back would otherwise be taken as known.
 */
export function forgetSynced(siteId: string): void {
  try {
    localStorage.removeItem(syncKey(siteId));
  } catch {
    // Nothing to forget.
  }
}

export interface UseNsitePinResult {
  /**
   * Whether putting this site on the home screen is on offer at all.
   *
   * False everywhere but Android, and false there on launchers that decline
   * pinned shortcuts. Android provides no fallback worth showing, so the
   * caller hides the action rather than disabling it.
   */
  available: boolean;
  /** Whether a shortcut for this site is already on the home screen. */
  pinned: boolean;
  pin: () => void;
}

/**
 * Put an nsite on the launcher, and keep what the system knows about it true.
 *
 * The site's tile is redrawn as a bitmap here rather than natively, because
 * the tile is already the answer to what the site looks like — its artwork on
 * its own colour, resolved out of its HTML — and the home screen and the
 * channel wall should not disagree about that.
 *
 * The second job is the larger one. The wall is the only place a site's web
 * app manifest is ever read, so it is the only place that can tell the system
 * what a site is called, what it looks like and what it will take from the
 * share sheet — and it is the only place that reads one for a site sitting on
 * the wall that has never been opened. So this runs for every tile, whether or
 * not the site is on the home screen and whether or not it can be put there.
 *
 * `onWall` says whether this tile is one the user has, rather than one they
 * are merely looking at. It is what decides whether the site is offered to the
 * share sheet, so a site being browsed in the picker must never pass true.
 * `rank` is the tile's place on the wall, which decides which site loses its
 * place in the sheet when Android's cap on share targets is reached.
 */
export function useNsitePin(
  event: NostrEvent,
  name: string,
  app: NsiteApp | undefined,
  onWall: boolean,
  rank = 0,
): UseNsitePinResult {
  const { toast } = useToast();
  const [available, setAvailable] = useState(false);
  const [pinned, setPinned] = useState(false);

  const siteId = getNsiteSubdomain(event);
  const shareTarget = app?.shareTarget ?? null;

  // Whether the site's manifest has been read at all. Until it has, nothing
  // here knows the difference between a site with no share target and one
  // whose target simply hasn't arrived yet.
  const known = !!app;

  // Held in a ref so that re-checking the launcher does not depend on the
  // tile's artwork, which resolves separately and later.
  const tile = useRef({ name, app });
  useEffect(() => { tile.current = { name, app }; }, [name, app]);

  // Drawing the icon costs a Blossom round trip. Once for as long as the tile
  // is on screen is enough: what it draws only changes when Tenna does.
  const drawn = useRef(false);

  /**
   * Tell the system what this site is, and put it in the share sheet or take
   * it back out.
   *
   * Run for every site whose manifest has been read, not only for the ones
   * that declared a share target, because the manifest is also where the
   * site's name and artwork come from — and this is the only place either is
   * ever read. A site added to the wall and never opened has nothing on disk
   * until this runs, and a site that has since dropped its `share_target` is
   * only ever taken back out of the sheet here.
   *
   * Being on the wall is what earns a place in the sheet. It used to be a
   * shortcut on the home screen, which meant a share menu that only listed
   * sites the user had gone to the further trouble of pinning — the launcher
   * is a question about where an icon lives, not about which apps they have.
   * A site that has been taken off the wall but is still on the home screen
   * keeps its place too, but not from here: nothing draws a tile for it, so
   * nothing runs this. It is held by the record its shortcut needs anyway.
   */
  const sync = useCallback(async () => {
    if (!known) return;

    const offered = onWall && !!shareTarget;
    const { name, app } = tile.current;

    // Everything below is a bitmap drawn from Blossom and two trips over the
    // bridge, for every tile, on every launch — and nearly always to say what
    // was said last time. What the system is told is a function of these, so
    // when none of them has changed, it already knows.
    const stamp = JSON.stringify([SYNC_VERSION, event.id, name, rank, offered, shareTarget]);
    try {
      if (localStorage.getItem(syncKey(siteId)) === stamp) return;
    } catch {
      // No memory of it; tell it again.
    }
    const icon = drawn.current ? null : await renderAppIconPng(name, app);
    if (icon) drawn.current = true;

    await NsiteShortcuts.syncSite({
      siteId,
      enabled: offered,
      label: name,
      icon: icon ?? undefined,
      rank,
      shareCategories: shareTarget ? shareCategories(shareTarget) : undefined,
      // Only used if the site hasn't got a record yet, which is the case this
      // exists for: one added to the wall and never opened.
      event: JSON.stringify(event),
      // The empty string is "read, and hasn't got one" — distinct from
      // omitting it, which is "not read, leave the record alone".
      shareTarget: shareTarget ? JSON.stringify(shareTarget) : '',
    });

    // A site is only ever pinned once, so a shortcut on the home screen wears
    // whatever artwork Tenna could draw that day. This is where it catches up
    // with a better drawing — including one made from artwork the site was
    // shipping all along and Tenna passed over. It also carries the site's
    // monochrome mark down, which nothing else writes: a notification arrives
    // for a site with no window open, long after this manifest was read.
    //
    // After the sync above, so that a site whose record was only just made is
    // found rather than passed over.
    if (icon) {
      await NsiteShortcuts.refreshIcon({
        siteId,
        icon,
        // Also how a site pinned before Tenna read monochrome manifest icons
        // stops wearing Tenna's mark in the status bar.
        badge: (await renderAppBadgePng(app)) ?? undefined,
        shareCategories: offered && shareTarget ? shareCategories(shareTarget) : undefined,
        rank,
      }).catch(() => {
        // An older shortcut than this build knows how to update. It keeps the
        // icon it has, which is the one it has always had.
      });
    }

    try {
      localStorage.setItem(syncKey(siteId), stamp);
    } catch {
      // Said again next launch, which is what happened before this existed.
    }
  }, [siteId, shareTarget, known, onWall, rank, event]);

  // Told to the system as soon as the manifest is read, and not behind
  // `isSupported`: what a site is called and what it takes from the share
  // sheet is no longer a question about the home screen. A launcher that
  // declines pinned shortcuts still has a share sheet, and the site still
  // needs a record for its notifications to be served from.
  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    void sync().catch(() => {
      // The share sheet is a bonus; failing to update it is not worth a toast.
    });
  }, [sync]);

  const check = useCallback(async () => {
    const { pinned } = await NsiteShortcuts.isPinned({ siteId });
    setPinned(pinned);
  }, [siteId]);

  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    let disposed = false;

    // Whether a shortcut exists is the launcher's business, and the launcher
    // is where the user goes to remove one. Asking again every time the grid
    // comes back into view is what keeps the answer true — including after
    // the system's own confirmation dialog, which resolves out of our sight.
    const recheck = () => {
      if (document.visibilityState === 'visible') void check().catch(() => {});
    };

    void NsiteShortcuts.isSupported()
      .then(({ supported }) => {
        if (disposed || !supported) return;
        setAvailable(true);
        document.addEventListener('visibilitychange', recheck);
        return check();
      })
      .catch(() => {
        // No launcher integration is not an error worth showing anyone.
      });

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', recheck);
    };
  }, [check]);

  const pin = useCallback(() => {
    void (async () => {
      try {
        const [icon, badge] = await Promise.all([
          renderAppIconPng(name, app),
          renderAppBadgePng(app),
        ]);
        await NsiteShortcuts.pin({
          siteId,
          label: name,
          // The whole manifest, so the shortcut can serve the site on a cold
          // press without a relay.
          event: JSON.stringify(event),
          icon: icon ?? undefined,
          badge: badge ?? undefined,
          // Stored now, acted on when the pin is confirmed. The share sheet is
          // the one thing about a site that cannot be worked out from its
          // manifest event, and the wall is the only place it is read.
          shareTarget: shareTarget ? JSON.stringify(shareTarget) : undefined,
          shareCategories: shareTarget ? shareCategories(shareTarget) : undefined,
        });

        // Resolving means the ask was made, not that a shortcut exists — the
        // system puts its own question in front of the user and answers it
        // nowhere we can hear. Some launchers pin silently, which this catches;
        // for the rest the recheck above does, when the dialog goes away.
        impactLight();
        await check().catch(() => {});
      } catch (err) {
        notificationError();
        toast({
          title: 'Could not add to the home screen',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      }
    })();
  }, [event, name, app, siteId, shareTarget, check, toast]);

  return { available, pinned, pin };
}
