import type { NostrEvent } from '@nostrify/nostrify';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { type NsiteApp, nsiteAppQuery } from '@/hooks/useNsiteApp';
import { useToast } from '@/hooks/useToast';
import { renderAppBadgePng } from '@/lib/appBadgeBitmap';
import { renderAppIconPng } from '@/lib/appIconBitmap';
import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import { shareCategories } from '@/lib/nsiteShareTarget';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';

/** Sites whose artwork has already been redrawn, this process. */
const redrawn = new Set<string>();

interface UseNsiteWindowResult {
  /** Whether this platform can give the site a window at all. */
  available: boolean;
  /** Open the site's window, or bring the one it has forward. */
  open: (channel?: number) => void;
}

interface UseNsiteOpenerResult {
  /** Whether this platform can give a site a window at all. */
  available: boolean;
  /**
   * Open a site's window, or bring the one it has forward.
   *
   * `path` opens the site somewhere other than its front page, which is what
   * an `nsite://` link naming one asks for. Omitted everywhere else: a tile
   * and a search result name a site and not a place in it.
   */
  open: (
    event: NostrEvent,
    name: string,
    app?: NsiteApp,
    channel?: number,
    path?: string,
  ) => void;
}

/**
 * Open a window for whichever site is named at the time.
 *
 * The same thing {@link useNsiteWindow} does, asked the other way round. A
 * tile is one site and knows which before it is drawn; a search result is
 * whichever row the finger lands on, out of a list that isn't fetched yet when
 * the hooks run. So the site is an argument here rather than a parameter of
 * the hook.
 *
 * What a caller in that position hasn't got is the site's {@link NsiteApp} —
 * the document is fetched per row and may not have arrived — and nothing
 * needs it to open: it carries the share target and the artwork, and both are
 * things the record already holds from the last time the site was drawn.
 */
export function useNsiteOpener(): UseNsiteOpenerResult {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const open = useCallback(
    (event: NostrEvent, name: string, app?: NsiteApp, channel?: number, path?: string) => {
      const siteId = getNsiteSubdomain(event);

      void (async () => {
        try {
          await NsiteShortcuts.open({
            siteId,
            label: name,
            event: JSON.stringify(event),
            channel,
            path,
            // The wall is the only place a site's manifest is read, so it is
            // the only place its share_target can be kept current. A window
            // opened from here refreshes what a pinned shortcut will offer
            // next time. Unlike the artwork it costs nothing to carry: it is
            // already here.
            shareTarget: app?.shareTarget ? JSON.stringify(app.shareTarget) : undefined,
          });
        } catch (err) {
          toast({
            title: 'Could not open the site',
            description: err instanceof Error ? err.message : String(err),
            variant: 'destructive',
          });
          return;
        }

        // A caller with no document read — a link, or a search result that
        // was pressed before its row had fetched one — would otherwise leave
        // the site with no artwork at all until it was opened from a tile,
        // and a site that is never on the wall never is. Its notifications
        // then wear no face of the site's. Read it here instead, after the
        // window is already up, so nothing is waited on.
        const drawn = app ?? await queryClient.fetchQuery(nsiteAppQuery(event)).catch(() => undefined);
        void redrawArtwork(siteId, name, drawn, channel);
      })();
    },
    [toast, queryClient],
  );

  return { available: supportsNsiteWindows(), open };
}

/**
 * Open an nsite in a window of its own.
 *
 * A site is not a page of Tenna's. Given the chance it gets its own task, its
 * own card in the recents switcher, and the whole screen with nothing of
 * Tenna's over it — which is what a site opened from the home screen has
 * always got, and there was never a good reason for the two to differ.
 *
 * The manifest goes with it, because the window may be started cold from
 * nothing but its intent and that is what it serves the site from. It is also
 * all that has to be there before the window can open, which is the whole of
 * what this waits on.
 *
 * The tile and the site's monochrome mark follow afterwards — see
 * {@link redrawArtwork}. They used to go first, and drawing them means
 * fetching artwork the wall had no reason to fetch, so a site being opened for
 * the first time this process paid a Blossom round trip before anything
 * happened on screen. On a fast connection that is a hundred milliseconds and
 * invisible; on a bad one it is seconds of a tap that appears to have missed.
 * Nothing about the window needs them to have arrived: the record's artwork is
 * only read when the recents card is drawn and when a notification is posted,
 * and whatever was stored last time stands until these land.
 */
export function useNsiteWindow(
  event: NostrEvent,
  name: string,
  app: NsiteApp | undefined,
): UseNsiteWindowResult {
  const { available, open } = useNsiteOpener();

  return {
    available,
    open: useCallback(
      (channel?: number) => open(event, name, app, channel),
      [open, event, name, app],
    ),
  };
}

/**
 * Bring the site's stored artwork up to date, once the window is already up.
 *
 * Both drawings cost a Blossom fetch of artwork nothing else asked for — the
 * launcher wants a different icon from the one on the tile, and the monochrome
 * mark is never shown on the wall at all — so neither is waited on before the
 * window opens. Nor is either urgent: what they are for is the recents card and
 * the status bar, and the record already holds whatever was drawn last time.
 *
 * Once per site per process. The renders themselves are memoised, so a second
 * tap would cost only the bridge call and a bitmap decode, but saying the same
 * thing twice is still not worth saying.
 *
 * Quiet about failing, and deliberately: this is the artwork, and a site that
 * opened is a site that opened. A failure is put back so the next tap tries
 * again.
 */
async function redrawArtwork(
  siteId: string,
  name: string,
  app: NsiteApp | undefined,
  channel?: number,
): Promise<void> {
  // Nothing fetched is nothing to redraw. A site opened before its document
  // arrived — from the search bar, which doesn't wait for one, or from a tile
  // pressed the moment it appeared — would otherwise have its stored artwork
  // replaced by the lettered tile `renderAppIconPng` falls back to, which is
  // the picture for a site that *has* no artwork rather than for one whose
  // artwork nobody has read yet. What was stored last time stands instead.
  if (!app) return;

  if (redrawn.has(siteId)) return;
  redrawn.add(siteId);

  try {
    const [icon, badge] = await Promise.all([
      renderAppIconPng(name, app),
      renderAppBadgePng(app),
    ]);
    if (!icon) return;

    await NsiteShortcuts.refreshIcon({
      siteId,
      icon,
      // A notification can arrive for this site with nothing of the wall's in
      // memory, long after the manifest this was picked out of was read, and
      // nowhere else writes one down.
      badge: badge ?? undefined,
      // Carried because updating a shortcut replaces it wholesale: a site in
      // the share sheet would otherwise quietly drop out of it, or fall to the
      // bottom of the ranking and be the next one evicted. The channel is the
      // site's place on the wall, which is what that ranking is. See
      // `useNsitePin`.
      shareCategories: app?.shareTarget ? shareCategories(app.shareTarget) : undefined,
      rank: channel && channel > 0 ? channel - 1 : 0,
    });
  } catch {
    redrawn.delete(siteId);
  }
}
