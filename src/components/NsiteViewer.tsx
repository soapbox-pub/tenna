import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Nsite } from '@/components/Nsite';
import { NsitePermissionManager } from '@/components/NsitePermissionManager';
import { NsitePermissionPrompt } from '@/components/NsitePermissionPrompt';
import { NsiteTopBar } from '@/components/NsiteTopBar';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useNsiteIconPng } from '@/hooks/useNsiteIconPng';
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
   * There is no channel wall behind it, so it is given no bar and no shutoff —
   * leaving is the back gesture, and it leaves for the launcher. The screen is
   * the site's, safe area included, the same as any other app's.
   */
  standalone?: boolean;
  /** Called after the shutoff animation completes, or at once when standalone. */
  onClose: () => void;
}

/**
 * Fullscreen nsite viewer — the television around the picture.
 *
 * Owns the bar over the site, the permission prompts, and the CRT tune-in and
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

  // What goes in the bar, for as long as there is one. The site's own name for
  // itself where it has one, since that is what it is called on the wall the
  // user pressed. The tile is drawn twice over: as pixels here, and as bytes
  // for a frame that has to draw the bar in native views.
  const { data: app } = useNsiteApp(event, { enabled: !standalone });
  const title = app?.label ?? name;
  const icon = useNsiteIconPng(title, app, !standalone);

  const topBar = useMemo(
    () => (standalone ? undefined : { title, icon }),
    [standalone, title, icon],
  );

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

  const permissions = user ? (
    <NsitePermissionManager
      siteId={siteId}
      open={permissionsOpen}
      onOpenChange={handlePermissionsOpenChange}
    />
  ) : null;

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
        {topBar && (
          <NsiteTopBar title={topBar.title} app={app} onBack={handleClose}>
            {permissions}
          </NsiteTopBar>
        )}

        {/* The picture: everything below the bar, and everything there is
            without one. */}
        <div className="relative min-h-0 flex-1">
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
            topBar={topBar}
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
                    'crt-osd absolute left-safe-offset-6 font-crt text-4xl text-[#7CFC9B]',
                    // Only a site without a bar has the status bar to clear.
                    topBar ? 'top-5' : 'top-safe-offset-5',
                  )}
                >
                  CH {ch}
                </span>
              )}
              <span className="crt-osd absolute bottom-safe-offset-8 left-1/2 -translate-x-1/2 font-crt text-3xl uppercase tracking-widest text-[#7CFC9B]">
                {name}
              </span>
            </div>
          )}
        </div>

        {signerRpc.pendingPrompt && (
          <NsitePermissionPrompt
            appName={name}
            prompt={signerRpc.pendingPrompt}
            onResolve={signerRpc.resolvePrompt}
          />
        )}
      </div>

      {/* A pinned site has no bar to hang the shield off, but a site with a
          signer still needs somewhere to show what it has been granted. So it
          keeps the floating pill, clear of the status bar — which would
          otherwise both hide it and swallow taps meant for it. */}
      {standalone && !closing && permissions && (
        <div className="absolute right-safe-offset-3 top-safe-offset-3 z-10 flex items-center rounded-full border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
          {permissions}
        </div>
      )}
    </div>
  );
}
