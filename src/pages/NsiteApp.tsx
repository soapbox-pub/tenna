import { useSeoMeta } from '@unhead/react';
import { useCallback, useState } from 'react';

import { NsiteViewer } from '@/components/NsiteViewer';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteOpenPath, useNsiteRefresh, type NsiteLaunch } from '@/hooks/useNsiteLaunch';
import { useNsiteShareDelivery, useShareToken } from '@/hooks/useNsiteShare';
import { NsiteShortcuts } from '@/lib/nsiteShortcutsPlugin';
import { getNsiteName } from '@/lib/nsiteSubdomain';

interface NsiteAppProps {
  launch: NsiteLaunch;
}

/**
 * An nsite in a window of its own, standing in for the whole app.
 *
 * The task belongs to the site — it has its own card in the recents switcher,
 * its own name, and its own icon on the launcher if the user put one there —
 * so there is no chrome of Tenna's over it and nothing to go back to inside
 * it. Leaving means leaving, and takes the task with it.
 *
 * What is behind the window still matters for how it goes. Opened from the
 * channel wall, leaving collapses back to the wall the way tuning off a
 * channel always has; opened from the home screen, there is no wall to
 * collapse to and it simply closes.
 *
 * The manifest comes off disk, written when the site was opened or pinned, so
 * a cold start serves the site without dialling a relay first. Whether it is
 * still the current manifest is settled afterwards, in the background, for
 * next time.
 */
export function NsiteApp({ launch }: NsiteAppProps) {
  // Frozen for the session. `useNsiteRefresh` may turn up a newer manifest a
  // second or two in, and adopting it would tear the site's WebView down and
  // reload it under whatever the user was doing.
  const [cached] = useState(launch.event);
  const fresh = useNsiteRefresh(launch);

  // The cache is the fast path and the usual one; the query is the fallback
  // for a shortcut whose record was lost, where there is nothing to show until
  // the relay answers.
  const event = cached ?? fresh;

  // A window opened from the share sheet opens *on* the share. Which URL that
  // is has to be settled before the site loads, so the wait counts as part of
  // the tune-in rather than being something to load a front page over.
  const shareToken = useShareToken(launch.shareToken);
  const share = useNsiteShareDelivery({ ...launch, shareToken });

  // A window opened by a notification opens where the notification pointed.
  // Nothing has to be resolved for it — the path was settled when the
  // notification was posted — so unlike a share it never holds the tune-in up.
  const openPath = useNsiteOpenPath(launch.path);

  // Only the share the window opened with can hold up the tune-in. A later one
  // arrives at a site already on screen, and taking that back down to work out
  // where it goes would be worse than the wait it saves.
  const tuning = share.status === 'pending' && shareToken === launch.shareToken;

  const name = (event && getNsiteName(event)) ?? launch.label;

  useSeoMeta({ title: name });

  const handleClose = useCallback(() => {
    void NsiteShortcuts.finish();
  }, []);

  if (!event || tuning) {
    // Same static the viewer tunes in behind, for the same reason: the wait is
    // a channel that hasn't come in yet, not a spinner.
    return (
      <div className="fixed inset-0 bg-black">
        <WhiteNoise className="h-full w-full" />
        <div className="crt-scanlines absolute inset-0 opacity-40" />
        <div className="crt-rollbar absolute inset-0" />
        <span className="crt-osd absolute bottom-safe-offset-8 left-1/2 max-w-[80vw] -translate-x-1/2 truncate font-crt text-3xl uppercase tracking-widest text-osd">
          {name}
        </span>
      </div>
    );
  }

  return (
    <NsiteViewer
      event={event}
      channel={launch.channel ?? undefined}
      standalone
      // What the window is called in the recents switcher, for the sheet to
      // fall back to if the site is one the wall has never drawn a tile for.
      label={launch.label}
      shutoff={launch.fromWall}
      share={share.status === 'ready' ? share.delivery ?? undefined : undefined}
      openPath={openPath}
      onClose={handleClose}
    />
  );
}

export default NsiteApp;
