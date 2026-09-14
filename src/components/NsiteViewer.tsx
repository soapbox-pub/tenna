import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Nsite } from '@/components/Nsite';
import { NsitePermissionPrompt } from '@/components/NsitePermissionPrompt';
import { NsiteTopBar } from '@/components/NsiteTopBar';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { nsiteIdentity, useNsiteTile } from '@/hooks/useNsiteIdentity';
import { useNsiteSignerRpc } from '@/hooks/useNsiteSignerRpc';
import type { NsiteShareDelivery } from '@/lib/nsiteShareTarget';
import { getNsiteName, getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { cn } from '@/lib/utils';

interface NsiteViewerProps {
  /** The NIP-5A manifest event for the site being viewed. */
  event: NostrEvent;
  /** 1-based channel number, shown in the tuning OSD. Omitted off the wall. */
  channel?: number;
  /**
   * The site is the whole app here, in a window of its own.
   *
   * Nothing of Tenna's is behind it to be given a bar back to, so the screen
   * is the site's, safe area included, the same as any other app's. Leaving is
   * the back gesture, and it takes the window with it.
   */
  standalone?: boolean;
  /**
   * The name the window was opened under, where the caller knows it.
   *
   * Only a fallback, and only for a site whose manifest hasn't been read and
   * that the wall has never drawn — a site pinned to the home screen and later
   * taken off the wall, whose tile went with it. See `useNsiteIdentity`.
   */
  label?: string;
  /**
   * Whether leaving plays the shutoff first.
   *
   * True by default, and for a window opened from the channel wall: the
   * collapse is how a channel has always been tuned off, and it plays against
   * the viewer's own backdrop, so it reads the same whether the wall is a
   * component underneath or a task behind. False for a site opened from the
   * home screen, where the animation would be playing over the launcher's own.
   */
  shutoff?: boolean;
  /**
   * A share from the OS for the site to open on, instead of its front page.
   *
   * Passed straight through to the frame. The viewer has nothing to do with
   * it — the tune-in plays the same either way, and a share is just a
   * different first URL.
   */
  share?: NsiteShareDelivery;
  /**
   * A path inside the site to open at, from a notification the user tapped.
   *
   * Passed straight through, like `share`, and for the same reason: where the
   * site opens is the frame's business, and the tune-in plays the same either
   * way.
   */
  openPath?: string;
  /** Called after the shutoff animation completes, or at once without one. */
  onClose: () => void;
}

/**
 * Fullscreen nsite viewer — the television around the picture.
 *
 * Owns the bar over the site, the permission prompts, and the CRT tune-in and
 * shutoff animations. How the site's files actually get served, and where its
 * origin lives, belongs to `<Nsite>`.
 */
export function NsiteViewer({
  event,
  channel,
  standalone,
  label,
  shutoff = true,
  share,
  openPath,
  onClose,
}: NsiteViewerProps) {
  const { user } = useCurrentUser();
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [noiseGone, setNoiseGone] = useState(false);

  const name = getNsiteName(event) ?? 'nsite';
  const siteId = useMemo(() => getNsiteSubdomain(event), [event]);

  // The site as the wall knows it, off the disk and on the first frame.
  const tile = useNsiteTile(event, label);

  // Told the name the user knows the site by rather than the one its manifest
  // event carries. It is what a remembered permission is written down under,
  // and the name on every notification Tenna posts for the site — which lands
  // in the shade beside a launcher shortcut already wearing it.
  //
  // The tile's name rather than the site's own, which may still be a round
  // trip away: a site that asks the moment it loads must not be written down
  // under a worse name for having asked early.
  const signerRpc = useNsiteSignerRpc({ siteId, siteName: tile.name });

  // Whether the site's own manifest is worth going and reading.
  //
  // Always, where there is a bar over the site to put its name and mark in. A
  // window of its own has no bar, and a Blossom round trip to decorate nothing
  // would only be in the way of the site itself — right up until the site asks
  // for something, because then Tenna has to say whose request it is, and it
  // should say what the site says rather than what was written down about it
  // last week. Kept once fetched, so the second question costs nothing.
  const { data: app } = useNsiteApp(event, {
    enabled: !standalone || !!signerRpc.pendingPrompt,
  });

  const identity = useMemo(() => nsiteIdentity(app, tile), [app, tile]);
  const title = identity.name;

  const topBar = useMemo(
    () => (standalone ? undefined : { title }),
    [standalone, title],
  );

  // The shutoff is the picture collapsing back to the wall it came from.
  const handleClose = useCallback(() => {
    if (shutoff) setClosing(true);
    else onClose();
  }, [shutoff, onClose]);

  // The document is on its way; give the site a beat to paint before lifting
  // the static.
  const handleLoad = useCallback(() => {
    setTimeout(() => setLoaded(true), 600);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  // The viewer covers the channel wall but doesn't stop it scrolling, so the
  // page keeps a second scrollbar alongside the site's own. Locked for the
  // whole mount, shutoff animation included — the wall is still hidden then.
  useEffect(() => {
    document.documentElement.classList.add('scroll-locked');
    return () => document.documentElement.classList.remove('scroll-locked');
  }, []);

  // A pinned site is not on the wall, so it has no number to tune to.
  const ch = channel === undefined ? null : String(channel).padStart(2, '0');

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div
        className={cn(
          'absolute inset-0 flex flex-col',
          closing ? 'animate-crt-off' : 'animate-crt-on',
        )}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onClose();
        }}
      >
        {topBar && <NsiteTopBar identity={identity} onBack={handleClose} />}

        {/* The picture: everything below the bar, and everything there is
            without one. */}
        <div className="relative min-h-0 flex-1">
          <Nsite
            event={event}
            name={name}
            pubkey={user?.pubkey}
            onRpc={user ? signerRpc.onRpc : undefined}
            // Not gated on being signed in, unlike the signer: what this
            // answers for is the device, and a logged-out reader has one.
            onCapability={signerRpc.onCapability}
            onLoad={handleLoad}
            // A frame that owns its own pixels has to get out of the way of
            // the prompt, which the viewer draws over it.
            concealed={!!signerRpc.pendingPrompt}
            closing={closing}
            onRequestClose={handleClose}
            topBar={topBar}
            share={share}
            openPath={openPath}
            className="absolute inset-0"
          />

          {/* Tuning static, lifted once the channel comes in */}
          {!noiseGone && (
            <div
              className={cn(
                'pointer-events-none absolute inset-0 transition-opacity duration-700',
                loaded ? 'opacity-0' : 'opacity-100',
              )}
              onTransitionEnd={() => setNoiseGone(true)}
            >
              <WhiteNoise className="h-full w-full" />
              <div className="crt-scanlines absolute inset-0 opacity-40" />
              <div className="crt-rollbar absolute inset-0" />
              {ch && (
                <span
                  className={cn(
                    'crt-osd absolute left-safe-offset-6 font-crt text-4xl text-osd',
                    // Only a site without a bar has the status bar to clear.
                    topBar ? 'top-5' : 'top-safe-offset-5',
                  )}
                >
                  CH {ch}
                </span>
              )}
              {/* A `d` tag could never be longer than the screen; a `title`
                  tag can, so the name is cut rather than run off both edges. */}
              <span className="crt-osd absolute bottom-safe-offset-8 left-1/2 max-w-[80vw] -translate-x-1/2 truncate font-crt text-3xl uppercase tracking-widest text-osd">
                {name}
              </span>
            </div>
          )}
        </div>

        {/* Whose request this is — the same identity the bar over the site
            shows, and the same one on the tile that opened it. A prompt that
            named the site differently from the thing the user pressed would be
            asking about something else as far as anyone reading could tell. */}
        {signerRpc.pendingPrompt && (
          <NsitePermissionPrompt
            // One question per sheet: keyed so that the next one in the queue
            // is asked fresh rather than wearing the previous answer's
            // "Remember for this site".
            key={signerRpc.pendingPromptId}
            identity={identity}
            prompt={signerRpc.pendingPrompt}
            onResolve={signerRpc.resolvePrompt}
          />
        )}
      </div>
    </div>
  );
}
