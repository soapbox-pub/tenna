import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback } from 'react';

import type { NsiteApp } from '@/hooks/useNsiteApp';
import { useToast } from '@/hooks/useToast';
import { renderAppBadgePng } from '@/lib/appBadgeBitmap';
import { renderAppIconPng } from '@/lib/appIconBitmap';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';

interface UseNsiteWindowResult {
  /** Whether this platform can give the site a window at all. */
  available: boolean;
  /** Open the site's window, or bring the one it has forward. */
  open: (channel?: number) => void;
}

/**
 * Open an nsite in a window of its own.
 *
 * A site is not a page of Tenna's. Given the chance it gets its own task, its
 * own card in the recents switcher, and the whole screen with nothing of
 * Tenna's over it — which is what a site opened from the home screen has
 * always got, and there was never a good reason for the two to differ.
 *
 * The manifest, the tile and the site's monochrome mark all go with it. The
 * window may be started cold, from nothing but its intent, so what it needs to
 * serve the site has to be on disk before it opens; the tile is redrawn here
 * for the same reason it is for the launcher, so that the recents card is the
 * site rather than Tenna again, and the mark for the same reason again, so
 * that its notifications are its own.
 */
export function useNsiteWindow(
  event: NostrEvent,
  name: string,
  app: NsiteApp | undefined,
): UseNsiteWindowResult {
  const { toast } = useToast();

  const open = useCallback((channel?: number) => {
    void (async () => {
      try {
        const [icon, badge] = await Promise.all([
          renderAppIconPng(name, app),
          renderAppBadgePng(app),
        ]);
        await NsiteShortcuts.open({
          siteId: getNsiteSubdomain(event),
          label: name,
          event: JSON.stringify(event),
          icon: icon ?? undefined,
          // The wall is also the only place a site's monochrome mark is read,
          // and a notification can arrive for this site with nothing of the
          // wall's in memory — so it is written down while it is known.
          badge: badge ?? undefined,
          channel,
          // The wall is the only place a site's manifest is read, so it is the
          // only place its share_target can be kept current. A window opened
          // from here refreshes what a pinned shortcut will offer next time.
          shareTarget: app?.shareTarget ? JSON.stringify(app.shareTarget) : undefined,
        });
      } catch (err) {
        toast({
          title: 'Could not open the site',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      }
    })();
  }, [event, name, app, toast]);

  return { available: supportsNsiteWindows(), open };
}
