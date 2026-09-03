import type { NostrEvent } from '@nostrify/nostrify';
import { Power } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { NsitePermissionManager } from '@/components/NsitePermissionManager';
import { NsitePermissionPrompt } from '@/components/NsitePermissionPrompt';
import { SandboxFrame, type SandboxFrameHandle } from '@/components/SandboxFrame';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteSignerRpc } from '@/hooks/useNsiteSignerRpc';
import { useSafeAreaInsets } from '@/hooks/useSafeAreaInsets';
import { deriveIframeSubdomain } from '@/lib/iframeSubdomain';
import { buildManifest, fetchFromBlossom, resolveServers } from '@/lib/nsiteFiles';
import { getNsiteNostrProviderScript } from '@/lib/nsiteNostrProvider';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { getPreviewInjectedScript } from '@/lib/previewInjectedScript';
import {
  getSafeAreaInjectedScript,
  mentionsSafeArea,
  readSiteChrome,
  rewriteSafeAreaEnvInCss,
  rewriteSafeAreaEnvInHtml,
  SAFE_AREA_RPC_METHOD,
  type SafeAreaInsets,
} from '@/lib/safeArea';
import { getMimeType } from '@/lib/sandbox';
import type { FileResponse, InjectedScript } from '@/lib/sandbox';
import { APP_ID } from '@/lib/tenna';
import { cn } from '@/lib/utils';

/**
 * Content types carrying CSS that may reference `env(safe-area-inset-*)`.
 *
 * JS is deliberately excluded. A bundle contains the same call inside Tailwind
 * class names, and rewriting one there renames the class out of existence —
 * so a site's CSS-in-JS insets go unfixed, which costs it some padding, rather
 * than its utility classes going dead, which costs it the layout.
 */
const CSS_BEARING_TYPES = new Set(['text/css', 'text/html']);

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

  const insets = useSafeAreaInsets();
  const frameRef = useRef<SandboxFrameHandle>(null);
  const [frameReady, setFrameReady] = useState(false);

  // What the site's own HTML says about how it wants to be framed. Unknown
  // until its index.html arrives; until then assume it doesn't handle insets,
  // which is the option that can't hide content behind a system bar.
  const [edgeToEdge, setEdgeToEdge] = useState(false);
  const [themeColor, setThemeColor] = useState<string | null>(null);

  // `resolveFile` serves every subsequent asset off the back of these, so they
  // also live in refs it can read without being rebuilt on each change.
  const edgeToEdgeRef = useRef(false);
  const insetsRef = useRef<SafeAreaInsets>(insets);
  useEffect(() => { insetsRef.current = insets; }, [insets]);

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
    }, {
      path: '__injected__/safe-area.js',
      // Injected unconditionally: the scripts are chosen before the site's
      // HTML has been read, so we don't yet know whether it's edge to edge.
      // For a site that isn't, nothing references these properties.
      content: getSafeAreaInjectedScript(insets),
    }];
    if (user) {
      scripts.push({
        path: '__injected__/nostr-provider.js',
        content: getNsiteNostrProviderScript(user.pubkey),
      });
    }
    return scripts;
  }, [user, insets]);

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
      let body = new Uint8Array(await res.arrayBuffer());
      const contentType = getMimeType(servingPath);

      if (CSS_BEARING_TYPES.has(contentType)) {
        const text = new TextDecoder().decode(body);

        if (servingPath === '/index.html') {
          // index.html is always the first thing served, so the rest of the
          // site's assets are resolved knowing which way to frame it.
          const chrome = readSiteChrome(text);
          edgeToEdgeRef.current = chrome.edgeToEdge;
          setEdgeToEdge(chrome.edgeToEdge);
          setThemeColor(chrome.themeColor);
        }

        // Only a site that asked to draw under the system bars gets real
        // insets. One that didn't is served inside a shrunken iframe, where
        // an inset of zero is the truth.
        if (edgeToEdgeRef.current && mentionsSafeArea(text)) {
          const rewritten = contentType === 'text/html'
            ? rewriteSafeAreaEnvInHtml(text, insetsRef.current)
            : rewriteSafeAreaEnvInCss(text, insetsRef.current);
          body = new TextEncoder().encode(rewritten);
        }
      }

      if (servingPath === '/index.html') {
        // The document is on its way; give the app a beat to paint before
        // lifting the static.
        setTimeout(() => setLoaded(true), 600);
      }

      return { status: 200, contentType, body };
    },
    [manifest, servers],
  );

  const handleClose = useCallback(() => setClosing(true), []);

  // Keep an edge-to-edge site's insets honest across rotation. Its stylesheets
  // were rewritten with the values measured at load, but they read them
  // through custom properties the injected script can re-set.
  //
  // Gated on the handshake: until the frame has navigated to its own origin,
  // a targeted postMessage is refused as an origin mismatch.
  useEffect(() => {
    if (!frameReady) return;
    frameRef.current?.postMessage({
      jsonrpc: '2.0',
      method: SAFE_AREA_RPC_METHOD,
      params: insets,
    });
  }, [insets, frameReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClosing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The viewer covers the channel wall but doesn't stop it scrolling, so the
  // page keeps a second scrollbar alongside the site's own. Locked for the
  // whole mount, shutoff animation included — the wall is still hidden then.
  useEffect(() => {
    document.documentElement.classList.add('scroll-locked');
    return () => document.documentElement.classList.remove('scroll-locked');
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
        {/* A site that doesn't handle insets itself is shrunk to the safe
            area, so its own viewport is the region it can safely paint. The
            strips this leaves take the site's theme colour, so the reveal
            reads as part of the site rather than a gap around it. */}
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: themeColor ?? undefined,
            paddingTop: edgeToEdge ? 0 : insets.top,
            paddingRight: edgeToEdge ? 0 : insets.right,
            paddingBottom: edgeToEdge ? 0 : insets.bottom,
            paddingLeft: edgeToEdge ? 0 : insets.left,
          }}
        >
          <SandboxFrame
            ref={frameRef}
            id={frameId}
            resolveFile={resolveFile}
            onRpc={user ? signerRpc.onRpc : undefined}
            onReady={() => setFrameReady(true)}
            injectedScripts={injectedScripts}
            className="h-full w-full border-0"
            title={name}
          />
        </div>

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
            <span className="crt-osd absolute left-safe-offset-6 top-safe-offset-5 font-crt text-4xl text-[#7CFC9B]">
              CH {ch}
            </span>
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
          them and swallows taps meant for them. */}
      {!closing && (
        <div className="absolute right-safe-offset-3 top-safe-offset-3 z-10 flex items-center gap-1 rounded-full border border-white/10 bg-black/60 p-1 backdrop-blur-sm">
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
