import { App } from '@capacitor/app';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { NsiteFrameProps } from '@/components/nsite/types';
import { nsiteAppQuery } from '@/hooks/useNsiteApp';
import { renderAppIconPng } from '@/lib/appIconBitmap';
import { supportsNappPush, supportsNappWorkerShim, supportsPeriodicSync } from '@/lib/nappPushPlugin';
import { getNsiteBrowserPermission } from '@/lib/nsiteBrowserPermissions';
import { buildManifest, resolveServers } from '@/lib/nsiteFiles';
import {
  NsiteWebView,
  supportsNappFetch,
  type NsiteCapabilityEvent,
  type NsiteFrameRect,
  type NsiteRpcEvent,
} from '@/lib/nsiteNativePlugin';
import { getNsiteNostrProviderScript } from '@/lib/nsiteNostrProvider';
import type { NsiteShareDelivery } from '@/lib/nsiteShareTarget';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { cn } from '@/lib/utils';

/**
 * Renders an nsite in a native WebView of its own.
 *
 * Almost nothing is drawn here. The site's pixels belong to a native view
 * layered over the whole Capacitor WebView, so this component is mostly the
 * lifecycle: it opens the view, relays signer calls, and closes it again. The
 * one exception is the still it paints while the site is concealed, which is
 * the site's own last frame handed back across the bridge.
 *
 * What that buys is the safe area. The site is its own top-level document, so
 * `viewport-fit=cover` and `env(safe-area-inset-*)` resolve to the real device
 * insets with nothing injected and no stylesheet rewritten — none of the
 * machinery in `@/lib/safeArea` applies to this path. This is the only frame
 * a site in its own window ever gets, and that window is the whole screen.
 */
/**
 * The script to inject into the site's window, or nothing to inject.
 *
 * Nothing when there is nothing to define: no key to sign with, no member of
 * `window.napp` this platform can honour, and no Notifications API to stand
 * in for. That is iOS with nobody signed in, and installing an empty function
 * there would cost a user script and a message handler to define no API at
 * all.
 */
function nsiteProviderScript(
  pubkey: string | undefined,
  siteId: string,
): string | undefined {
  const push = supportsNappPush();
  const fetch = supportsNappFetch();
  // The same platforms: showing one needs the notification machinery the push
  // service already owns. Named apart from `push` because they are two
  // different things a site asks for, and only one of them involves a relay.
  const notify = push;
  // iOS only, where WebKit gives a custom-scheme document no service workers
  // and `register()` is the only place the worker's path is ever said.
  const serviceWorker = supportsNappWorkerShim();
  const periodicSync = supportsPeriodicSync();

  if (!pubkey && !push && !fetch && !notify && !serviceWorker) return undefined;

  // Read here, synchronously, because `Notification.permission` is a getter
  // and a site reads it before it does anything else. See `notifyGrant`.
  const stored = notify ? getNsiteBrowserPermission(siteId, 'notifications') : 'ask';

  return getNsiteNostrProviderScript(pubkey ?? null, 'webMessage', {
    push,
    fetch,
    notify,
    serviceWorker,
    periodicSync,
    notifyGrant: stored === 'allow' ? 'granted' : stored === 'deny' ? 'denied' : 'default',
  });
}

export function NsiteNative({
  event,
  name,
  pubkey,
  onRpc,
  onCapability,
  onLoad,
  concealed,
  closing,
  onRequestClose,
  share,
  openPath,
  className,
}: NsiteFrameProps) {
  // The box the native view stands in, where the native view is not the
  // window. Nothing is ever drawn into it — it is measured, and the numbers
  // are what cross the bridge. See `NsiteFrameRect`.
  const boxRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const measure = useCallback((): NsiteFrameRect | undefined => {
    const box = boxRef.current;
    if (!box || Capacitor.getPlatform() !== 'ios') return undefined;

    // Layout offsets rather than `getBoundingClientRect()`, because the viewer
    // opens a channel by playing a CRT turn-on: the whole subtree is scaled
    // from a horizontal line, and a visual rect measured while that is running
    // is a few pixels tall. The native view is not part of the animation and
    // wants the box the site will settle into. Offsets ignore transforms,
    // which is exactly the property needed here.
    let x = 0;
    let y = 0;
    for (let node: HTMLElement | null = box; node; node = node.offsetParent as HTMLElement | null) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }

    return { x, y, width: box.offsetWidth, height: box.offsetHeight };
  }, []);
  // Kept in refs so the open/close effect depends on the site alone. A
  // re-render must never tear down a loaded site and start it over.
  const onRpcRef = useRef(onRpc);
  const onCapabilityRef = useRef(onCapability);
  const onLoadRef = useRef(onLoad);
  const onCloseRef = useRef(onRequestClose);
  // A picture of the site, held for as long as the site itself is hidden.
  const [still, setStill] = useState<string | null>(null);
  // Read by the back handler, which is registered once and outlives any one
  // prompt.
  const concealedRef = useRef(concealed);
  useEffect(() => { concealedRef.current = concealed; }, [concealed]);
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
  useEffect(() => { onCapabilityRef.current = onCapability; }, [onCapability]);
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

    // The camera, the microphone, where the user is: things the WebView asks
    // about rather than the site. A frame with nobody to ask refuses, because
    // silence would leave whatever the site called hanging forever, which is
    // worse than a no.
    const handleCapability = async ({ id, kinds }: NsiteCapabilityEvent) => {
      const handler = onCapabilityRef.current;
      try {
        const granted = handler ? await handler(kinds) : false;
        await NsiteWebView.respondCapability({ id, granted });
      } catch {
        await NsiteWebView.respondCapability({ id, granted: false });
      }
    };

    (async () => {
      listeners.push(
        await NsiteWebView.addListener('nsiteLoad', () => onLoadRef.current?.()),
        await NsiteWebView.addListener('nsiteRpc', (e) => { void handleRpc(e); }),
        await NsiteWebView.addListener('nsiteCapability', (e) => { void handleCapability(e); }),
      );

      // A late unmount would otherwise leave a WebView with no owner.
      if (disposed) return;

      openedShare.current = shareRef.current;

      await NsiteWebView.open({
        siteId: getNsiteSubdomain(event),
        // Measured now rather than on layout, because the view is created in
        // this call and a frame of zero size would paint nothing.
        frame: measure(),
        // What a dialog the site opens is titled with. Derived from the same
        // event as everything else here, so it never arrives late and never
        // reopens the window on its own.
        name,
        files: Object.fromEntries(buildManifest(event)),
        servers: resolveServers(event),
        // A site in its own WebView can register a service worker, and the
        // push service can wake it, so this is the one frame that offers
        // `window.napp` alongside `window.nostr`.
        //
        // Installed for a logged-out reader too, which `window.nostr` alone
        // never needed: `napp.fetch` is a question about the device rather
        // than about a key, and a reader browsing a site still expects its
        // pictures to load. The script withholds `window.nostr` when there is
        // no pubkey to put in it.
        providerScript: nsiteProviderScript(pubkey, getNsiteSubdomain(event)),
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
  }, [event, name, pubkey, measure]);

  // The site's face for its notifications, which on iOS are drawn by an
  // extension that has nothing of the wall's to draw with. Read after the
  // window is up, so nothing is waited on; a document that never arrives
  // leaves whatever was stored last time, rather than the lettered tile
  // `renderAppIconPng` falls back to for a site that has no artwork at all.
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'ios') return;
    let cancelled = false;

    (async () => {
      const app = await queryClient.fetchQuery(nsiteAppQuery(event)).catch(() => undefined);
      if (!app || cancelled) return;
      const icon = await renderAppIconPng(name, app);
      if (!icon || cancelled) return;
      await NsiteWebView.setIcon({ siteId: getNsiteSubdomain(event), icon });
    })().catch((err) => {
      console.warn('[NsiteNative] could not store the site icon:', err);
    });

    return () => { cancelled = true; };
  }, [event, name, queryClient]);

  // Keep the native view on top of the box it stands in. Rotation, the
  // keyboard, the bar appearing or going away — anything that reflows the page
  // moves a box the native view knows nothing about.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || Capacitor.getPlatform() !== 'ios') return;

    let last = '';
    const sync = () => {
      const frame = measure();
      if (!frame) return;
      const key = `${frame.x},${frame.y},${frame.width},${frame.height}`;
      if (key === last) return;
      last = key;
      void NsiteWebView.updateFrame({ frame }).catch(() => {
        // A view that has gone away has no frame to set.
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(box);
    window.addEventListener('resize', sync);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [measure]);

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

  // Concealment, and the picture left in the site's place while it lasts.
  //
  // The native view is above the Capacitor one, so a prompt drawn by React can
  // only be seen once the site is hidden — and a sheet over a blank screen
  // doesn't read as a sheet over the app the user is in. So the site's last
  // frame comes back with the call that hides it, and gets painted here.
  //
  // It is only ever a picture. Nothing behind the sheet can take a press or
  // repaint itself into something that looks like the sheet, which is the
  // whole reason the live site goes away.
  useEffect(() => {
    let cancelled = false;

    NsiteWebView.setConcealed({ concealed: !!concealed, still: !!concealed })
      .then(({ still }) => {
        if (!cancelled) setStill(concealed ? still ?? null : null);
      })
      .catch((err) => {
        console.error('[NsiteNative] failed to conceal:', err);
      });

    return () => { cancelled = true; };
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
  //
  // Except while the site is concealed, when back belongs to whatever is
  // covering it: the prompt takes the gesture as its answer, and a site that
  // also walked its own history behind one would be navigating out from under
  // a question about the page it was on.
  useEffect(() => {
    if (!onRequestClose) return;
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', () => {
      if (concealedRef.current) return;

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

  // The still stands exactly where the native view did, which is not the same
  // place on both platforms: on Android the view is added to the activity's
  // content view and fills the window, while on iOS it is given this box.
  const fillsWindow = Capacitor.getPlatform() !== 'ios';

  return (
    <>
      {/* Measured, never drawn. `pointer-events-none` because a transparent
          box over the site would otherwise swallow every touch meant for it —
          on Android, where the site is a native view above this one, and on
          iOS for the same reason. */}
      <div ref={boxRef} aria-hidden="true" className={cn('pointer-events-none', className)} />

      {still && (
        <img
          src={still}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={cn(
            'pointer-events-none h-full w-full select-none object-cover',
            fillsWindow ? 'fixed inset-0' : 'absolute inset-0',
          )}
        />
      )}
    </>
  );
}
