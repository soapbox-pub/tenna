import type { NostrEvent } from '@nostrify/nostrify';
import { Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Nsite } from '@/components/Nsite';
import { NsitePermissionManager } from '@/components/NsitePermissionManager';
import { NsitePermissionPrompt } from '@/components/NsitePermissionPrompt';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteSignerRpc } from '@/hooks/useNsiteSignerRpc';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { cn } from '@/lib/utils';

interface NsiteViewerProps {
  /** The NIP-5A manifest event for the site being viewed. */
  event: NostrEvent;
  /** 1-based channel number, shown in the tuning OSD. Omitted off the wall. */
  channel?: number;
  /**
   * The site is the whole app here, opened from its own home screen shortcut.
   *
   * There is no channel wall behind it, so it is given no power button and no
   * shutoff — leaving is the back gesture, and it leaves for the launcher.
   */
  standalone?: boolean;
  /** Called after the shutoff animation completes, or at once when standalone. */
  onClose: () => void;
}

/**
 * Fullscreen nsite viewer — the television around the picture.
 *
 * Owns the set-top controls, the permission prompts, and the CRT tune-in and
 * shutoff animations. How the site's files actually get served, and where its
 * origin lives, belongs to `<Nsite>`.
 */
export function NsiteViewer({ event, channel, standalone, onClose }: NsiteViewerProps) {
  const { user } = useCurrentUser();
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [noiseGone, setNoiseGone] = useState(false);

  // The permissions panel, and whether it was opened from a frame's own
  // controls rather than from the trigger here. Only in that case is the
  // frame painting over the viewer, and only then does it have to be
  // concealed for the panel to be visible at all.
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionsOverFrame, setPermissionsOverFrame] = useState(false);

  const name = event.tags.find(([n]) => n === 'd')?.[1] ?? 'nsite';
  const siteId = useMemo(() => getNsiteSubdomain(event), [event]);

  const signerRpc = useNsiteSignerRpc({ siteId, siteName: name });

  // The shutoff is the picture collapsing back to the wall it came from. A
  // pinned site has no wall behind it — the animation would play over the
  // launcher's own — so leaving one is immediate.
  const handleClose = useCallback(() => {
    if (standalone) onClose();
    else setClosing(true);
  }, [standalone, onClose]);

  const handleRequestPermissions = useCallback(() => {
    setPermissionsOverFrame(true);
    setPermissionsOpen(true);
  }, []);

  const handlePermissionsOpenChange = useCallback((open: boolean) => {
    setPermissionsOpen(open);
    if (!open) setPermissionsOverFrame(false);
  }, []);

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
        className={cn('absolute inset-0', closing ? 'animate-crt-off' : 'animate-crt-on')}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onClose();
        }}
      >
        <Nsite
          event={event}
          name={name}
          pubkey={user?.pubkey}
          onRpc={user ? signerRpc.onRpc : undefined}
          onLoad={handleLoad}
          // A frame that owns its own pixels has to get out of the way of
          // anything the viewer draws over it, panels included.
          concealed={!!signerRpc.pendingPrompt || permissionsOverFrame}
          closing={closing}
          onRequestClose={handleClose}
          onRequestPermissions={handleRequestPermissions}
          showPowerButton={!standalone}
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
              <span className="crt-osd absolute left-safe-offset-6 top-safe-offset-5 font-crt text-4xl text-[#7CFC9B]">
                CH {ch}
              </span>
            )}
            <span className="crt-osd absolute bottom-safe-offset-8 left-1/2 -translate-x-1/2 font-crt text-3xl uppercase tracking-widest text-[#7CFC9B]">
              {name}
            </span>
          </div>
        )}

        {signerRpc.pendingPrompt && (
          <NsitePermissionPrompt
            appName={name}
            prompt={signerRpc.pendingPrompt}
            onResolve={signerRpc.resolvePrompt}
          />
        )}
      </div>

      {/* Set-top controls. Clear of the status bar, which otherwise both hides
          them and swallows taps meant for them.

          A pinned site keeps the shield — a site with a signer needs somewhere
          to show what it has been granted, wherever it was opened from — but
          loses the power button, and with it the whole pill when nobody is
          logged in. */}
      {!closing && (user || !standalone) && (
        <div className="absolute right-safe-offset-3 top-safe-offset-3 z-10 flex items-center gap-1 rounded-full border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
          {user && (
            <NsitePermissionManager
              siteId={siteId}
              open={permissionsOpen}
              onOpenChange={handlePermissionsOpenChange}
            />
          )}
          {!standalone && (
            <button
              type="button"
              onClick={handleClose}
              aria-label="Turn off"
              title="Turn off"
              className="flex size-7 items-center justify-center rounded-full text-[#DA1F52] outline-none transition-colors hover:bg-[#DA1F52] hover:text-white focus-visible:ring-2 focus-visible:ring-[#FEF960]"
            >
              <Power className="size-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
