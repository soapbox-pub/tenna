import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback } from 'react';

import type { NsiteApp } from '@/hooks/useNsiteApp';
import { useToast } from '@/hooks/useToast';
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
 * The manifest and the tile go with it. The window may be started cold, from
 * nothing but its intent, so what it needs to serve the site has to be on disk
 * before it opens; the tile is redrawn here for the same reason it is for the
 * launcher, so that the recents card is the site rather than Tenna again.
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
        const icon = await renderAppIconPng(name, app);
        await NsiteShortcuts.open({
          siteId: getNsiteSubdomain(event),
          label: name,
          event: JSON.stringify(event),
          icon: icon ?? undefined,
          channel,
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
