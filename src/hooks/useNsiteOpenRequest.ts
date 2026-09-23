import type { PluginListenerHandle } from '@capacitor/core';
import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useNsiteAddress } from '@/hooks/useNsiteAddress';
import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import { nsiteUrl } from '@/lib/nsiteUrl';
import { useNsiteOpener } from '@/hooks/useNsiteWindow';
import { useToast } from '@/hooks/useToast';
import {
  clearNsiteOpen,
  getNsiteOpen,
  nsiteOpenPending,
  subscribeNsiteOpen,
} from '@/lib/nsiteOpenRequest';
import { NsiteWebView, supportsNativeNsite } from '@/lib/nsiteNativePlugin';
import { requestNsiteOpen } from '@/lib/nsiteOpenRequest';
import { getNsiteName, getNsiteSubdomain, nameFromSubdomain } from '@/lib/nsiteSubdomain';
import { recordLaunch, siteKey } from '@/lib/recents';
import { readTileSnapshot } from '@/lib/tileSnapshot';

/**
 * The `nsite://` link the OS handed Tenna, if it handed it one.
 *
 * See `nsiteOpenRequest.ts` for what arrives here and what may be done with
 * it. `done` is called once the link has been acted on — opened, or given up
 * on — and is what puts the wall back.
 */
export function useNsiteOpenRequest(): { url: string | null; done: () => void } {
  const url = useSyncExternalStore(subscribeNsiteOpen, getNsiteOpen, () => null);

  return {
    url,
    done: useCallback(() => {
      if (url) clearNsiteOpen(url);
    }, [url]),
  };
}

/**
 * Whether it is still unknown what this launch of the app began with.
 *
 * True for the one bridge call it takes to ask, and false forever after —
 * including when the answer is a link, because a link is the wall's to hold,
 * not the router's. What this gates is the frame or two in which the wall
 * would otherwise paint in front of a site the user asked for, before
 * `getLaunchUrl` has said there is one.
 *
 * On the web, and anywhere else with no OS to ask, it resolves without a
 * bridge call at all.
 */
export function useNsiteOpenAsking(): boolean {
  const [asking, setAsking] = useState(true);

  useEffect(() => {
    let disposed = false;
    void nsiteOpenPending.then(() => {
      if (!disposed) setAsking(false);
    });
    return () => {
      disposed = true;
    };
  }, []);

  return asking;
}

/**
 * Take the `nsite://` links the site in this window follows.
 *
 * A site's window is one site's and not a browser, so a link to anywhere else
 * is handed to the device. A link to *another site* is the exception, because
 * the thing it names is something Tenna opens — and sending it out to the OS
 * would bring it straight back through Tenna's own intent filter, by way of a
 * task switch through the wall. It is raised to this window instead, which
 * resolves it and opens the sibling itself.
 *
 * Pair it with {@link useNsiteOpenLink}, which is what does the opening. Safe
 * to call anywhere: without the native plugin there is nothing to listen to.
 */
export function useNsiteLinkListener(): void {
  useEffect(() => {
    if (!supportsNativeNsite()) return;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      listener = await NsiteWebView.addListener('nsiteLink', ({ url }) => requestNsiteOpen(url));
      if (disposed) void listener.remove();
    })().catch(() => {
      // An older build than this event; a link out goes to the OS instead.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, []);
}

/**
 * Take the taps on a site's notifications.
 *
 * iOS only. A tap there reaches the *app*: running a site's worker takes a
 * notification service extension, and iOS starts one of those only to mutate an
 * arriving push, so there is nothing alive to raise `notificationclick` in. What
 * routes is `data.url`, which is the convention every push service worker on
 * Nostr already writes and the same thing Android reads before it raises the
 * event. See NAPP.md.
 *
 * The tap becomes an ordinary `nsite://` open, which is exactly what it is —
 * "put this site on screen, at this path" — and goes down the road a pasted
 * address or a link from another site already takes. Nothing here has to know
 * how a site is resolved or where a window comes from.
 *
 * Android does its own opening natively, before the worker is even told, so
 * that a tap lands at once rather than waiting on a worker that may not be
 * running. There is no equivalent to do here.
 */
export function useNappNotificationListener(): void {
  useEffect(() => {
    if (!supportsNappPush()) return;

    let disposed = false;
    let listener: PluginListenerHandle | undefined;

    void (async () => {
      const handle = await NappPush.addListener('nappNotificationOpen', ({ siteId, path }) => {
        // Built from the site id rather than from anything in the
        // notification, so a site cannot name one site and be opened as
        // another. The path is the site's own and is checked natively.
        requestNsiteOpen(nsiteUrl(siteId, path ?? '/'));
      });
      if (disposed) void handle.remove();
      else listener = handle;
    })().catch(() => {
      // Android, or a build with no such event. Nothing to listen to.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, []);
}

/**
 * What to call a site opened from a link.
 *
 * The name it went by the last time it was drawn first, because that is the
 * site's own word for itself, read out of the document it serves. Then what
 * the manifest says, then the address with nothing else to say. The link is
 * never asked: it is a stranger's string, and a site does not get to be
 * called whatever the thing that pointed at it says it is.
 */
function siteName(event: NostrEvent): string {
  const id = getNsiteSubdomain(event);
  return readTileSnapshot(id)?.name ?? getNsiteName(event) ?? nameFromSubdomain(id);
}

/**
 * Open the site an arriving `nsite://` link named.
 *
 * The wall's half of the deep link. The address goes through exactly the
 * resolution a pasted one does — `useNsiteAddress`, including a NIP-05 lookup
 * where the link used a name — and the site that comes back is opened the way
 * pressing a tile opens one: its own window where the platform gives sites
 * windows, and tuned in over the wall where it doesn't.
 *
 * `opening` is true while there is a link outstanding, and is what keeps the
 * wall off the screen in front of a site the user asked for.
 *
 * A link that resolves to nothing is said out loud and then dropped. It is the
 * ordinary outcome for a site that has been unpublished, for a relay that is
 * unreachable, and for a name whose domain no longer answers — and leaving the
 * user on a blank screen for any of them would be the worse failure.
 */
export function useNsiteOpenLink(
  onTuneIn: (event: NostrEvent, path: string | null) => void,
): { opening: boolean } {
  const { url, done } = useNsiteOpenRequest();
  const { toast } = useToast();
  const opener = useNsiteOpener();

  const address = useNsiteAddress(url ?? '');
  const { isAddress, isLoading, error, event, path } = address;

  useEffect(() => {
    if (!url || isLoading) return;

    // A link that doesn't parse never reaches the store, so the only way to
    // be here without an address is a URL that stopped being one — which
    // cannot happen. Belt and braces, and it closes the loop either way.
    if (!isAddress || error || !event) {
      toast({
        title: 'Could not open that site',
        description: error
          ? 'The relay could not be reached. Check your connection and try again.'
          : 'Nothing is published at that address.',
        variant: 'destructive',
      });
      done();
      return;
    }

    recordLaunch(siteKey(getNsiteSubdomain(event)));

    const name = siteName(event);
    if (opener.available) opener.open(event, name, undefined, undefined, path ?? undefined);
    else onTuneIn(event, path);

    done();
  }, [url, isAddress, isLoading, error, event, path, opener, onTuneIn, toast, done]);

  return { opening: url !== null };
}
