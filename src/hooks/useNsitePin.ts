import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '@/hooks/useToast';
import type { NsiteApp } from '@/hooks/useNsiteApp';
import { renderAppIconPng } from '@/lib/appIconBitmap';
import { impactLight, notificationError } from '@/lib/haptics';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
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
        const icon = await renderAppIconPng(name, app);
        await NsiteShortcuts.pin({
          siteId,
          label: name,
          // The whole manifest, so the shortcut can serve the site on a cold
          // press without a relay.
          event: JSON.stringify(event),
          icon: icon ?? undefined,
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
  }, [event, name, app, siteId, check, toast]);

  return { available, pinned, pin };
}
