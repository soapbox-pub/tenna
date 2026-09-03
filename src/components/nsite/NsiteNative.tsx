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
 * machinery in `@/lib/safeArea` applies to this path.
 */
export function NsiteNative({
  event,
  pubkey,
  onRpc,
  onLoad,
  concealed,
  closing,
  onRequestClose,
}: NsiteFrameProps) {
  // Kept in refs so the open/close effect depends on the site alone. A
  // re-render must never tear down a loaded site and start it over.
  const onRpcRef = useRef(onRpc);
  const onLoadRef = useRef(onLoad);
  useEffect(() => { onRpcRef.current = onRpc; }, [onRpc]);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);

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
      const load = await NsiteWebView.addListener('nsiteLoad', () => onLoadRef.current?.());
      const rpc = await NsiteWebView.addListener('nsiteRpc', (e) => { void handleRpc(e); });
      listeners.push(load, rpc);

      // A late unmount would otherwise leave a WebView with no owner.
      if (disposed) return;

      await NsiteWebView.open({
        siteId: getNsiteSubdomain(event),
        files: Object.fromEntries(buildManifest(event)),
        servers: resolveServers(event),
        providerScript: pubkey
          ? getNsiteNostrProviderScript(pubkey, 'webMessage')
          : undefined,
      });
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

  // Start the shutoff as soon as the viewer does, rather than waiting for
  // unmount. The viewer's own animation is playing underneath this view, so
  // deferring would show the site sitting untouched through all of it.
  useEffect(() => {
    if (closing) void NsiteWebView.close();
  }, [closing]);

  // Back belongs to the site while the site has somewhere to go.
  useEffect(() => {
    if (!onRequestClose) return;
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', () => {
      void NsiteWebView.goBack().then(({ moved }) => {
        if (!moved) onRequestClose();
      });
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
