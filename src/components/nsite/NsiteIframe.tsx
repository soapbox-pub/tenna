import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SandboxFrame, type SandboxFrameHandle } from '@/components/SandboxFrame';
import type { NsiteFrameProps } from '@/components/nsite/types';
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

/**
 * Renders an nsite in a cross-origin sandbox iframe.
 *
 * This is the portable implementation: it runs unchanged on the web and
 * inside a WebView, because the sandbox is built out of nothing but an
 * iframe on an isolated origin plus a Service Worker fetch proxy.
 *
 * The cost of that portability is the safe area. A nested browsing context
 * never receives the device's insets — `env(safe-area-inset-*)` resolves to
 * `0px` inside any iframe, same-origin or not, fullscreen or not — and no API
 * exists to define an environment variable from inside a document. So the
 * insets have to be substituted into the site's stylesheets as they're served,
 * and sites that don't ask to draw under the system bars are shrunk to fit
 * inside them instead. See `@/lib/safeArea`.
 */
export function NsiteIframe({
  event,
  name,
  pubkey,
  onRpc,
  onLoad,
  concealed,
  onRequestClose,
  topBar,
  className,
}: NsiteFrameProps) {
  const measured = useSafeAreaInsets();

  // The bar runs under the status bar in the site's place, so the site's top
  // inset is spent before it ever sees it. Handing it the device's would pad
  // the same strip twice — once by the bar, once by the page under it.
  const insets = useMemo<SafeAreaInsets>(
    () => (topBar ? { ...measured, top: 0 } : measured),
    [measured, topBar],
  );

  const frameRef = useRef<SandboxFrameHandle>(null);
  const [frameReady, setFrameReady] = useState(false);

  // What the site's own HTML says about how it wants to be framed. Unknown
  // until its index.html arrives; until then assume it doesn't handle insets,
  // which is the option that can't hide content behind a system bar.
  const [edgeToEdge, setEdgeToEdge] = useState(false);
  const [themeColor, setThemeColor] = useState<string | null>(null);

  const siteId = useMemo(() => getNsiteSubdomain(event), [event]);
  const frameId = useMemo(
    () => deriveIframeSubdomain(APP_ID, 'nsite', siteId),
    [siteId],
  );

  const manifest = useMemo(() => buildManifest(event), [event]);
  const servers = useMemo(() => resolveServers(event), [event]);

  // `resolveFile` serves every asset off the back of these, so they live in
  // refs it can read without being rebuilt on each change.
  const edgeToEdgeRef = useRef(false);
  const insetsRef = useRef<SafeAreaInsets>(insets);
  const onLoadRef = useRef(onLoad);
  useEffect(() => { insetsRef.current = insets; }, [insets]);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);

  const injectedScripts = useMemo<InjectedScript[]>(() => {
    const scripts: InjectedScript[] = [{
      path: '__injected__/preview.js',
      content: getPreviewInjectedScript(),
    }, {
      path: '__injected__/safe-area.js',
      content: getSafeAreaInjectedScript(),
    }];
    if (pubkey) {
      scripts.push({
        path: '__injected__/nostr-provider.js',
        content: getNsiteNostrProviderScript(pubkey),
      });
    }
    return scripts;
  }, [pubkey]);

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

      let body = await fetchFromBlossom(sha256, servers);
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
        if (edgeToEdgeRef.current) {
          if (contentType === 'text/html') {
            body = new TextEncoder().encode(
              rewriteSafeAreaEnvInHtml(text, insetsRef.current),
            );
          } else if (mentionsSafeArea(text)) {
            body = new TextEncoder().encode(
              rewriteSafeAreaEnvInCss(text, insetsRef.current),
            );
          }
        }
      }

      if (servingPath === '/index.html') {
        onLoadRef.current?.();
      }

      return { status: 200, contentType, body };
    },
    [manifest, servers],
  );

  const handleRpc = useCallback(
    (method: string, params: unknown) => onRpc!(method, params),
    [onRpc],
  );

  // Keep an edge-to-edge site's insets honest across rotation. Its stylesheets
  // were rewritten with the values measured at load, but they read them
  // through a custom property the injected script can re-set.
  //
  // Gated on the handshake (until the frame has navigated to its own origin a
  // targeted postMessage is refused as an origin mismatch) and on the site
  // actually being edge to edge — a letterboxed one is already inside the
  // safe area, so its insets are genuinely zero.
  useEffect(() => {
    if (!frameReady || !edgeToEdge) return;
    frameRef.current?.postMessage({
      jsonrpc: '2.0',
      method: SAFE_AREA_RPC_METHOD,
      params: insets,
    });
  }, [insets, frameReady, edgeToEdge]);

  // Back closes the viewer outright: the site is a cross-origin frame, so
  // whether it has any history of its own is not something we can ask.
  useEffect(() => {
    if (!onRequestClose) return;
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', onRequestClose)
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [onRequestClose]);

  return (
    <div
      className={cn(
        className,
        concealed && 'pointer-events-none opacity-0',
      )}
      style={{
        // The strips left by shrinking a site take its theme colour, so the
        // reveal reads as framing rather than a gap around it.
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
        onRpc={pubkey && onRpc ? handleRpc : undefined}
        onReady={() => setFrameReady(true)}
        injectedScripts={injectedScripts}
        className="h-full w-full border-0"
        title={name}
      />
    </div>
  );
}
