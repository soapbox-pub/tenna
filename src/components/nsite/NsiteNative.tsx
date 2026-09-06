import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { useEffect, useMemo, useRef } from 'react';

import type { NsiteFrameProps } from '@/components/nsite/types';
import { supportsNappPush } from '@/lib/nappPushPlugin';
import { buildManifest, resolveServers } from '@/lib/nsiteFiles';
import { NsiteWebView, type NsiteRpcEvent } from '@/lib/nsiteNativePlugin';
import { getNsiteNostrProviderScript } from '@/lib/nsiteNostrProvider';
import type { NsiteShareDelivery } from '@/lib/nsiteShareTarget';
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
 * machinery in `@/lib/safeArea` applies to this path. This is the only frame
 * a site in its own window ever gets, and that window is the whole screen.
 */
export function NsiteNative({
  event,
  pubkey,
  onRpc,
  onLoad,
  concealed,
  closing,
  onRequestClose,
  share,
  openPath,
}: NsiteFrameProps) {
  // Kept in refs so the open/close effect depends on the site alone. A
  // re-render must never tear down a loaded site and start it over.
  const onRpcRef = useRef(onRpc);
  const onLoadRef = useRef(onLoad);
  const onCloseRef = useRef(onRequestClose);
  // A notification's path is the same thing to the native side as a GET
  // share: the URL the site opens on. Only the reason for it differs.
  //
  // Memoised because identity is what tells "another one arrived" from "the
  // component re-rendered", and a fresh object every render would reload the
  // site under whoever was using it.
  const entry = useMemo<NsiteShareDelivery | undefined>(
    () => share ?? (openPath ? { kind: 'get', path: openPath } : undefined),
    [share, openPath],
  );

  const shareRef = useRef(entry);
  // The entry the WebView was opened on, so that a later one is told apart
  // from the one already delivered.
  const openedShare = useRef(entry);
  useEffect(() => { onRpcRef.current = onRpc; }, [onRpc]);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);
  useEffect(() => { onCloseRef.current = onRequestClose; }, [onRequestClose]);
  useEffect(() => { shareRef.current = entry; }, [entry]);

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
      );

      // A late unmount would otherwise leave a WebView with no owner.
      if (disposed) return;

      openedShare.current = shareRef.current;

      await NsiteWebView.open({
        siteId: getNsiteSubdomain(event),
        files: Object.fromEntries(buildManifest(event)),
        servers: resolveServers(event),
        // A site in its own WebView can register a service worker, and the
        // push service can wake it, so this is the one frame that offers
        // `window.napp.push` alongside `window.nostr`.
        providerScript: pubkey
          ? getNsiteNostrProviderScript(pubkey, 'webMessage', { napp: supportsNappPush() })
          : undefined,
        // The first URL, when the window was opened out of the share sheet.
        // Held in a ref like the callbacks: a share belongs to the open, and
        // re-reading it later would only reload the site over the user.
        share: shareRef.current,
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

  // A share, or a notification's path, turning up after the site is loaded.
  // The window never closed, so there is nothing to reopen — the site is
  // simply pointed at it, the way any other navigation would be.
  useEffect(() => {
    if (!entry || entry === openedShare.current) return;
    openedShare.current = entry;

    void NsiteWebView.navigate({ siteId: getNsiteSubdomain(event), share: entry }).catch((err) => {
      console.error('[NsiteNative] failed to deliver an entry point:', err);
    });
  }, [entry, event]);

  useEffect(() => {
    void NsiteWebView.setConcealed({ concealed: !!concealed });
  }, [concealed]);

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
