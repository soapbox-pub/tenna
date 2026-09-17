import { App } from '@capacitor/app';
import { useCallback, useEffect, useRef, useState } from 'react';

import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';

/** One set, shared, so a wall with nothing out never re-renders on identity. */
const NONE: ReadonlySet<string> = new Set<string>();

/**
 * Which sites on the wall have a notification waiting in the shade.
 *
 * This is the dot on a tile, and it is the same fact the launcher draws on
 * Tenna's own icon — so the two agree, including about when it goes away.
 * Dismissing the notification clears it, whether that is a swipe, Clear All,
 * or the tap that opens the site; opening the site from its tile does not,
 * any more than opening an app from the launcher clears its dot. A site that
 * wants the dot gone when the user has seen the thing closes its own
 * notification, which is what `notification.close()` is for.
 *
 * Nothing is remembered here or below. The shade is read every time, because
 * it is the only copy that cannot go stale: a tap takes a row away by
 * `setAutoCancel`, with nothing of Tenna's running to be told, so read-ness
 * written down anywhere would outlive the thing it described.
 *
 * Android only, where notifications are. Everywhere else this is the empty
 * set and costs a comparison.
 */
export function useNappUnread(siteIds: string[]): ReadonlySet<string> {
  const [unread, setUnread] = useState<ReadonlySet<string>>(NONE);

  // The wall as it stands, for the listeners below — they are registered once
  // and must not be torn down and rebuilt every time a tile moves.
  const wall = useRef<string[]>(siteIds);

  // The read in flight, so an answer overtaken by a later one is dropped
  // rather than drawn. A push and a resume can land within a frame of each
  // other, and the shade may have moved between them.
  const generation = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++generation.current;
    const wanted = wall.current;

    if (wanted.length === 0) {
      setUnread((previous) => (previous.size === 0 ? previous : NONE));
      return;
    }

    void NappPush.unread({ siteIds: wanted })
      .then(({ siteIds: out }) => {
        if (mine !== generation.current) return;
        setUnread((previous) => (same(previous, out) ? previous : new Set(out)));
      })
      .catch(() => {
        // An older build than this method, or a shade that refused to be
        // enumerated. No dots rather than wrong ones.
      });
  }, []);

  // The wall changing, which is also the first read.
  useEffect(() => {
    if (!supportsNappPush()) return;
    wall.current = siteIds;
    refresh();
  }, [siteIds, refresh]);

  // A notification arriving, being replaced, or being swiped away while the
  // wall is on screen. The shade pulled down over the wall does not pause
  // anything, so a swipe there is only heard about this way.
  useEffect(() => {
    if (!supportsNappPush()) return;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      listener = await NappPush.addListener('nappNotificationsChanged', () => {
        // The event names a site, but the whole wall is read back: it is a
        // nudge rather than a diff, and a read is one call to the system.
        if (!disposed) refresh();
      });
      if (disposed) void listener.remove();
    })().catch(() => {
      // Nothing to listen to on this build.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [refresh]);

  // Everything that happened while the wall was not on screen: a notification
  // tapped, which opened the site's own window over this one and took its row
  // down on the way, or a shade cleared in another app entirely.
  useEffect(() => {
    if (!supportsNappPush()) return;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      listener = await App.addListener('appStateChange', ({ isActive }) => {
        if (!disposed && isActive) refresh();
      });
      if (disposed) void listener.remove();
    })().catch(() => {
      // Nothing to listen to on this build.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [refresh]);

  return unread;
}

/** Whether a fresh answer says what the last one did. */
function same(previous: ReadonlySet<string>, next: string[]): boolean {
  return previous.size === next.length && next.every((siteId) => previous.has(siteId));
}
