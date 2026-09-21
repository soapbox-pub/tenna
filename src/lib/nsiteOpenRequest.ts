/**
 * An `nsite://` link the OS handed Tenna, waiting to be opened.
 *
 * A site is not a route. Tenna has no URL for one — the wall opens them, and
 * on Android each gets a task of its own — so a link arriving from outside
 * cannot simply become a `navigate()` call the way a deep link usually does.
 * It becomes this instead: one pending address, held at module scope, read by
 * the wall, and cleared the moment it has been acted on.
 *
 * Module scope rather than context because of *when* it is written. A cold
 * start delivers the link before any component exists to receive it, and the
 * answer decides whether the first frame is the wall or a site — see
 * {@link nsiteOpenPending}.
 *
 * ## This is untrusted input
 *
 * Any web page the user visits can open `nsite://anything`. What arrives here
 * is therefore attacker-chosen, and the only thing done with it is: resolve it
 * to a signed manifest, and show the user that site. That is the same thing
 * pressing a tile does, and it is deliberately the *whole* of it — nothing
 * here adds to the wall, pins a shortcut, or grants anything. A link that
 * rearranged somebody's home screen would be a link worth sending them.
 *
 * The site it opens is derived from the manifest, never from the link: the
 * `siteId` that keys the origin, the storage and the grants comes back out of
 * `getNsiteSubdomain(event)`. So a link cannot name one site and be served as
 * another, and a NIP-05 alias cannot inherit a key's storage by pointing at
 * its name.
 */
import { Capacitor } from '@capacitor/core';

import { isNsiteUrl } from '@/lib/nsiteUrl';

type Listener = (url: string | null) => void;

const listeners = new Set<Listener>();

/** The link waiting to be opened, or null when there isn't one. */
let pending: string | null = null;

/**
 * The link this launch of the app began with, and whether it has been acted
 * on yet.
 *
 * A cold start delivers that one URL twice: once as the launch URL read
 * below, and again as the `appUrlOpen` the bridge fires once it is up. Without
 * this the second delivery reopens the site a moment after the user has left
 * it. Only that one URL, and only once — a link is an ordinary thing to follow
 * twice, and an address tapped twice in the app is a button pressed twice.
 */
let launchUrl: string | null = null;
let launchSpent = false;

function announce(): void {
  for (const listener of listeners) listener(pending);
}

/** Take an `nsite://` link, if it is one. */
export function requestNsiteOpen(url: string): void {
  if (!isNsiteUrl(url)) return;

  // The bridge repeating the launch URL, after it has already been opened.
  if (url === launchUrl && launchSpent) return;

  pending = url;
  announce();
}

/** Done with it, however it went. */
export function clearNsiteOpen(url: string): void {
  if (url === launchUrl) launchSpent = true;
  if (pending !== url) return;
  pending = null;
  announce();
}

export function getNsiteOpen(): string | null {
  return pending;
}

export function subscribeNsiteOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Whether this launch of the app began with a link, asked before the first
 * paint.
 *
 * The wall must not flash up in front of a site the user asked for. Resolving
 * the link is a relay round trip, so there is real time to cover, and covering
 * it means knowing at the first render that there is something to cover —
 * which `appUrlOpen` is too late to say, since it fires after the bridge is
 * up. `getLaunchUrl` is the same answer, available sooner.
 *
 * Asked the moment this module loads, and shared, exactly as `useNsiteLaunch`
 * asks what window this is. Resolves to false everywhere there is no OS to
 * hand Tenna a link.
 */
export const nsiteOpenPending: Promise<boolean> = Capacitor.isNativePlatform()
  ? import('@capacitor/app')
      .then(({ App }) => App.getLaunchUrl())
      .then((launch) => {
        if (!launch?.url || !isNsiteUrl(launch.url)) return false;
        launchUrl = launch.url;
        pending = launch.url;
        announce();
        return true;
      })
      .catch(() => false)
  : Promise.resolve(false);
