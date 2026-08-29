import type { NostrEvent } from '@nostrify/nostrify';
import { Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NsitePermissionManager } from '@/components/NsitePermissionManager';
import { NsitePermissionPrompt } from '@/components/NsitePermissionPrompt';
import { SandboxFrame } from '@/components/SandboxFrame';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteSignerRpc } from '@/hooks/useNsiteSignerRpc';
import { deriveIframeSubdomain } from '@/lib/iframeSubdomain';
import { buildManifest, fetchFromBlossom, resolveServers } from '@/lib/nsiteFiles';
import { getNsiteNostrProviderScript } from '@/lib/nsiteNostrProvider';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { getPreviewInjectedScript } from '@/lib/previewInjectedScript';
import { getMimeType } from '@/lib/sandbox';
import type { FileResponse, InjectedScript } from '@/lib/sandbox';
import { APP_ID } from '@/lib/tenna';
import { cn } from '@/lib/utils';

interface NsiteViewerProps {
  /** The NIP-5A manifest event for the site being viewed. */
  event: NostrEvent;
  /** 1-based channel number, shown in the tuning OSD. */
  channel: number;
  /** Called after the shutoff animation completes. */
  onClose: () => void;
}

/**
 * Fullscreen nsite viewer. Files are served straight from Blossom into a
 * sandboxed iframe; static plays while the channel tunes in, and closing
 * collapses the picture like a tube switching off.
 */
export function NsiteViewer({ event, channel, onClose }: NsiteViewerProps) {
  const { user } = useCurrentUser();
  const [closing, setClosing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [noiseGone, setNoiseGone] = useState(false);

  const name = event.tags.find(([n]) => n === 'd')?.[1] ?? 'nsite';
  const siteId = useMemo(() => getNsiteSubdomain(event), [event]);
  const frameId = useMemo(
    () => deriveIframeSubdomain(APP_ID, 'nsite', siteId),
    [siteId],
  );

  const signerRpc = useNsiteSignerRpc({ siteId, siteName: name });

  const manifest = useMemo(() => buildManifest(event), [event]);
  const servers = useMemo(() => resolveServers(event), [event]);

  const injectedScripts = useMemo<InjectedScript[]>(() => {
    const scripts: InjectedScript[] = [{
      path: '__injected__/preview.js',
      content: getPreviewInjectedScript(),
    }];
    if (user) {
      scripts.push({
        path: '__injected__/nostr-provider.js',
        content: getNsiteNostrProviderScript(user.pubkey),
      });
    }
    return scripts;
  }, [user]);

  const resolveFile = useCallback(
    async (pathname: string): Promise<FileResponse | null> => {
      // Fall back to /index.html for SPA client-side routes.
      let sha256 = manifest.get(pathname);
      let servingPath = pathname;

      if (!sha256) {
        sha256 = manifest.get('/index.html');
        servingPath = '/index.html';
      }
      if (!sha256) return null;

      const res = await fetchFromBlossom(sha256, servers);
      const body = new Uint8Array(await res.arrayBuffer());

      if (servingPath === '/index.html') {
        // The document is on its way; give the app a beat to paint before
        // lifting the static.
        setTimeout(() => setLoaded(true), 600);
      }

      return { status: 200, contentType: getMimeType(servingPath), body };
    },
    [manifest, servers],
  );

  const handleClose = useCallback(() => setClosing(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClosing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ch = String(channel).padStart(2, '0');

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <div
        className={cn('absolute inset-0', closing ? 'animate-crt-off' : 'animate-crt-on')}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onClose();
        }}
      >
        <SandboxFrame
          id={frameId}
          resolveFile={resolveFile}
          onRpc={user ? signerRpc.onRpc : undefined}
          injectedScripts={injectedScripts}
          className="h-full w-full border-0"
          title={name}
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
            <span className="crt-osd absolute left-6 top-5 font-crt text-4xl text-[#7CFC9B]">
              CH {ch}
            </span>
            <span className="crt-osd absolute bottom-8 left-1/2 -translate-x-1/2 font-crt text-3xl uppercase tracking-widest text-[#7CFC9B]">
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

      {/* Set-top controls */}
      {!closing && (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
          {user && <NsitePermissionManager siteId={siteId} />}
          <button
            type="button"
            onClick={handleClose}
            aria-label="Turn off"
            title="Turn off"
            className="flex size-7 items-center justify-center rounded-full text-[#DA1F52] outline-none transition-colors hover:bg-[#DA1F52] hover:text-white focus-visible:ring-2 focus-visible:ring-[#FEF960]"
          >
            <Power className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
