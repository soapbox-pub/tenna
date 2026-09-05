import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useToast } from '@/hooks/useToast';
import type { NsiteApp } from '@/hooks/useNsiteApp';
import { renderAppIconPng } from '@/lib/appIconBitmap';
import { impactLight, notificationError } from '@/lib/haptics';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { shareCategories } from '@/lib/nsiteShareTarget';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';

interface UseNsitePinResult {
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
 * Put an nsite on the launcher.
 *
 * The site's tile is redrawn as a bitmap here rather than natively, because
 * the tile is already the answer to what the site looks like — its artwork on
 * its own colour, resolved out of its HTML — and the home screen and the
 * channel wall should not disagree about that.
 */
export function useNsitePin(
  event: NostrEvent,
  name: string,
  app: NsiteApp | undefined,
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

  // Redrawing costs a Blossom round trip for the launcher's own artwork, and
  // the check below runs every time the wall comes back into view. Once for as
  // long as the tile is on screen is enough: what it draws only changes when
  // Tenna does.
  const redrawn = useRef(false);

  /**
   * Reconcile the share sheet with the home screen.
   *
   * A shortcut is only offered to the sheet once it is known to be pinned,
   * because pinning is a request the system answers where we cannot hear it —
   * and a site the user declined has no business in the share menu. Taking one
   * back out leaves its launcher icon alone; a dynamic shortcut and a pinned
   * one are the same object, and removing the first keeps the second.
   *
   * Run for every site whose manifest has been read, not only for the ones
   * that declared a target, because this is also what writes the answer to the
   * site's record. The wall is the only place a manifest is ever read, and it
   * reads one long after the site was pinned — so a site that has since
   * dropped the member is only ever taken back out of the sheet here.
   */
  const syncShare = useCallback(async (isPinned: boolean) => {
    if (!known) return;

    const offered = isPinned && !!shareTarget;
    const { name, app } = tile.current;
    const icon = isPinned ? await renderAppIconPng(name, app) : null;

    // A site is only ever pinned once, so the artwork it was pinned with is
    // whatever Tenna could draw that day. This is where a shortcut already on
    // the home screen catches up with a better drawing — including one made
    // from artwork the site was shipping all along and Tenna passed over.
    if (icon && !redrawn.current) {
      redrawn.current = true;
      await NsiteShortcuts.refreshIcon({
        siteId,
        icon,
        shareCategories: offered && shareTarget ? shareCategories(shareTarget) : undefined,
      }).catch(() => {
        // An older shortcut than this build knows how to update. It keeps the
        // icon it has, which is the one it has always had.
      });
    }

    await NsiteShortcuts.setShareTarget({
      siteId,
      enabled: offered,
      label: name,
      icon: icon ?? undefined,
      shareCategories: shareTarget ? shareCategories(shareTarget) : undefined,
      // The empty string is "read, and hasn't got one" — distinct from
      // omitting it, which is "not read, leave the record alone".
      shareTarget: shareTarget ? JSON.stringify(shareTarget) : '',
    });
  }, [siteId, shareTarget, known]);

  const check = useCallback(async () => {
    const { pinned } = await NsiteShortcuts.isPinned({ siteId });
    setPinned(pinned);
    await syncShare(pinned).catch(() => {
      // The share sheet is a bonus; failing to update it is not worth a toast.
    });
  }, [siteId, syncShare]);

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
        const icon = await renderAppIconPng(name, app);
        await NsiteShortcuts.pin({
          siteId,
          label: name,
          // The whole manifest, so the shortcut can serve the site on a cold
          // press without a relay.
          event: JSON.stringify(event),
          icon: icon ?? undefined,
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
