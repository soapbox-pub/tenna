import { useSeoMeta } from '@unhead/react';
import { useCallback, useState } from 'react';

import { NsiteViewer } from '@/components/NsiteViewer';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteRefresh, type NsiteLaunch } from '@/hooks/useNsiteLaunch';
import { NsiteShortcuts } from '@/lib/nsiteShortcutsPlugin';

interface NsiteAppProps {
  launch: NsiteLaunch;
}

/**
 * A pinned nsite, standing in for the whole app.
 *
 * Tenna's home screen is not underneath this. The task belongs to the site —
 * it has its own card in the recents switcher, its own icon on the launcher,
 * and its own name — so there is no channel to have tuned away from and no
 * power button, which is the difference the user asked for by pinning it.
 * Leaving means leaving, and takes the task with it.
 *
 * The manifest comes off disk, written when the shortcut was made, so a cold
 * press starts serving the site without dialling a relay first. Whether it is
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

  const name = event?.tags.find(([n]) => n === 'd')?.[1] ?? launch.label;

  useSeoMeta({ title: name });

  const handleClose = useCallback(() => {
    void NsiteShortcuts.finish();
  }, []);

  if (!event) {
    // Same static the viewer tunes in behind, for the same reason: the wait is
    // a channel that hasn't come in yet, not a spinner.
    return (
      <div className="fixed inset-0 bg-black">
        <WhiteNoise className="h-full w-full" />
        <div className="crt-scanlines absolute inset-0 opacity-40" />
        <div className="crt-rollbar absolute inset-0" />
        <span className="crt-osd absolute bottom-safe-offset-8 left-1/2 -translate-x-1/2 font-crt text-3xl uppercase tracking-widest text-[#7CFC9B]">
          {name}
        </span>
      </div>
    );
  }

  return <NsiteViewer event={event} standalone onClose={handleClose} />;
}

export default NsiteApp;
