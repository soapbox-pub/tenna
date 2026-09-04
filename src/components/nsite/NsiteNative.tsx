import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { useEffect, useRef } from 'react';

import type { NsiteFrameProps } from '@/components/nsite/types';
import { buildManifest, resolveServers } from '@/lib/nsiteFiles';
import { NsiteWebView, type NsiteRpcEvent } from '@/lib/nsiteNativePlugin';
import { getNsiteNostrProviderScript } from '@/lib/nsiteNostrProvider';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';

/**
 * Renders an nsite in a native WebView of its own.
 *
 * Nothing is drawn here. The site's pixels belong to a native view layered
 * over the whole Capacitor WebView, so this component is only the lifecycle:
 * it opens the view, relays signer calls, and closes it again.
 *
 * What that buys is the safe area. The site is its own top-level document, so
 * `viewport-fit=cover` and `env(safe-area-inset-*)` resolve to the real device
 * insets with nothing injected and no stylesheet rewritten — none of the
 * machinery in `@/lib/safeArea` applies to this path. Where a bar is drawn
 * over the site, the plugin hands the WebView the insets from where the site
 * actually starts, so the strip the bar already covers is not offered twice.
 */
export function NsiteNative({
  event,
  pubkey,
  onRpc,
  onLoad,
  concealed,
  closing,
  onRequestClose,
  onRequestPermissions,
  topBar,
}: NsiteFrameProps) {
  // Kept in refs so the open/close effect depends on the site alone. A
  // re-render must never tear down a loaded site and start it over.
  const onRpcRef = useRef(onRpc);
  const onLoadRef = useRef(onLoad);
  const onCloseRef = useRef(onRequestClose);
  const onPermissionsRef = useRef(onRequestPermissions);
  const topBarRef = useRef(topBar);
  // Read once, when the view is built. Whether there is a bar decides how the
  // site is laid out under it, and no site is torn down and rebuilt to change
  // its mind about that — only what the bar says can change.
  const hasTopBarRef = useRef(!!topBar);
  useEffect(() => { onRpcRef.current = onRpc; }, [onRpc]);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);
  useEffect(() => { onCloseRef.current = onRequestClose; }, [onRequestClose]);
  useEffect(() => { onPermissionsRef.current = onRequestPermissions; }, [onRequestPermissions]);
  useEffect(() => { topBarRef.current = topBar; }, [topBar]);

  useEffect(() => {
    let disposed = false;
    const listeners: PluginListenerHandle[] = [];

    const handleRpc = async ({ id, method, params }: NsiteRpcEvent) => {
      const handler = onRpcRef.current;
      if (!handler) {
        await NsiteWebView.respond({ id, error: 'No signer available' });
        return;
      }
      try {
        const result = await handler(method, JSON.parse(params) as unknown);
        await NsiteWebView.respond({ id, result: JSON.stringify(result ?? null) });
      } catch (err) {
        await NsiteWebView.respond({ id, error: String(err) });
      }
    };

    (async () => {
      listeners.push(
        await NsiteWebView.addListener('nsiteLoad', () => onLoadRef.current?.()),
        await NsiteWebView.addListener('nsiteRpc', (e) => { void handleRpc(e); }),
        // The site's WebView covers the viewer's own chrome, so the plugin
        // draws it natively over the site and reports presses back here.
        await NsiteWebView.addListener('nsiteBack', () => onCloseRef.current?.()),
        await NsiteWebView.addListener('nsitePermissions', () => onPermissionsRef.current?.()),
      );

      // A late unmount would otherwise leave a WebView with no owner.
      if (disposed) return;

      await NsiteWebView.open({
        siteId: getNsiteSubdomain(event),
        files: Object.fromEntries(buildManifest(event)),
        servers: resolveServers(event),
        providerScript: pubkey
          ? getNsiteNostrProviderScript(pubkey, 'webMessage')
          : undefined,
        topBar: hasTopBarRef.current ? topBarRef.current : undefined,
      });

      // The site's icon is read out of the document it ships and may well have
      // arrived while the view was being built. The effect below fires before
      // there is a bar to put it on, so the bar asks once more for itself.
      if (hasTopBarRef.current && topBarRef.current) {
        await NsiteWebView.setTopBar(topBarRef.current);
      }
    })().catch((err) => {
      console.error('[NsiteNative] failed to open:', err);
    });

    return () => {
      disposed = true;
      void NsiteWebView.close();
      for (const listener of listeners) void listener.remove();
    };
  }, [event, pubkey]);

  useEffect(() => {
    void NsiteWebView.setConcealed({ concealed: !!concealed });
  }, [concealed]);

  // The bar opens with the site's name and fills in the rest as it is read.
  useEffect(() => {
    if (!topBar) return;
    void NsiteWebView.setTopBar(topBar).catch(() => {});
  }, [topBar]);

  // Start the shutoff as soon as the viewer does, rather than waiting for
  // unmount. The viewer's own animation is playing underneath this view, so
  // deferring would show the site sitting untouched through all of it.
  useEffect(() => {
    if (closing) void NsiteWebView.close();
  }, [closing]);

  // Back belongs to the site while the site has somewhere to go — the swipe
  // from the edge walks the site's own history. Once it has none left the
  // gesture means what it means anywhere else, and leaves.
  useEffect(() => {
    if (!onRequestClose) return;
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', () => {
      void NsiteWebView.goBack()
        .then(({ moved }) => {
          if (!moved) onRequestClose();
        })
        // A frame that can't answer has nowhere to go back to either, and a
        // back gesture that does nothing at all is a site with no way out.
        .catch(() => onRequestClose());
    }).then((listener) => {
      if (disposed) void listener.remove();
      else handle = listener;
    }).catch(() => {});

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [onRequestClose]);

  return null;
}
