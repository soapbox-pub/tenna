/**
 * The address of one thing on the wall.
 *
 * A site and an app on the device are not the same sort of object anywhere
 * else in Tenna — one is a manifest fetched from a relay, the other a package
 * the OS will launch — but on the wall they are the same thing: a tile, in a
 * position, that the user put there and can move or take away. So the wall
 * keeps one list, and every entry on it is a string of this shape.
 *
 * A URI rather than a tagged object because a list of them is legible on
 * sight, survives a round trip through localStorage without a schema, and can
 * be handed to anything else that wants to name a tile later. The scheme says
 * which kind it is and nothing else needs to.
 *
 *   nsite:<subdomain>[?relay=<wss url>…]
 *   android-app://<package>/<activity>[?label=<name>]
 *
 * Both carry an optional hint in the query: relays to look a site up on, the
 * name an app went by when it was added. Neither is the truth — the relay's
 * manifest and the device's package list are — and both are there for the
 * same reason, so that a tile has something to draw before the source it
 * really comes from has answered.
 *
 * ## Two spellings of `nsite:`
 *
 * The one above is opaque — one colon, no `//` — and is the wall's alone. It
 * is a storage format, it carries relay hints in a query, and it names a site
 * rather than a place inside one, because a tile is a site.
 *
 * The other is `nsite://<subdomain>/<path>`, which is a URL people send each
 * other and the OS hands to Tenna. It has no room for relay hints, since the
 * query belongs to the site — see `nsiteUrl.ts`. Reading one here is
 * defensive rather than expected: `nsiteUri()` builds every address the wall
 * stores, so a navigable URL should never reach this. But the two are one
 * scheme, they will be confused, and the confusion is cheap to absorb. Any
 * path on such a URL is dropped, which is what taking a page off a link and
 * putting the site on the wall means.
 */
import { parseNsiteSubdomain } from '@/lib/nsiteSubdomain';

/** How many relay hints off an address are worth opening a socket to. */
const MAX_HINTS = 4;

export type WallAddress =
  | { kind: 'nsite'; id: string; relays: string[] }
  | { kind: 'app'; packageName: string; activityName: string; label: string | null };

/** Relay hints are untrusted strings that become websocket connections. */
function tidyRelays(values: readonly string[]): string[] {
  const urls = new Set<string>();

  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === 'wss:') urls.add(url.href);
    } catch {
      // Not a URL, so not a relay.
    }
    if (urls.size >= MAX_HINTS) break;
  }

  return [...urls];
}

/** A site's canonical NIP-5A subdomain, as a wall address. */
export function nsiteUri(id: string, relays: readonly string[] = []): string {
  const hints = tidyRelays(relays)
    .map((relay) => `relay=${encodeURIComponent(relay)}`)
    .join('&');

  return hints ? `nsite:${id}?${hints}` : `nsite:${id}`;
}

/** A device app's package and launcher activity, as a wall address. */
export function nativeAppUri(app: {
  packageName: string;
  activityName: string;
  label?: string | null;
}): string {
  const base = `android-app://${app.packageName}/${encodeURIComponent(app.activityName)}`;
  return app.label ? `${base}?label=${encodeURIComponent(app.label)}` : base;
}

/**
 * Read a wall address, or null for anything that isn't one.
 *
 * Null is the answer for a URI in a scheme the wall doesn't know and for one
 * that is well-formed but names nothing findable — an nsite subdomain that
 * doesn't parse is a tile that could only ever show static. A list read back
 * out of storage is filtered through this, so nothing downstream has to
 * wonder whether an entry is real.
 */
export function parseWallUri(uri: string): WallAddress | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  if (url.protocol === 'nsite:') {
    // The authority, when the URI has one, and otherwise the opaque path:
    // everything between the scheme and the query. A host is lowercased
    // because `nsite:` is not a special scheme, so `URL` leaves its case
    // alone; the opaque form is Tenna's own and is already a label.
    const id = url.host ? url.host.toLowerCase() : decodeURIComponent(url.pathname);
    if (!id || !parseNsiteSubdomain(id)) return null;
    // A navigable URL carries no hints — its query is the site's — so only the
    // opaque spelling is asked for any.
    const relays = url.host ? [] : tidyRelays(url.searchParams.getAll('relay'));
    return { kind: 'nsite', id, relays };
  }

  if (url.protocol === 'android-app:') {
    // `android-app:` is not a special scheme, so the host keeps its case —
    // which matters, since a package name is free to have some.
    const packageName = url.host;
    const activityName = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!packageName || !activityName) return null;
    return { kind: 'app', packageName, activityName, label: url.searchParams.get('label') };
  }

  return null;
}

/**
 * The address without its hints — what makes two entries the same tile.
 *
 * The same site added twice by two different naddrs carries two different
 * relay lists and is still one site; an app renamed by an update is still the
 * app that was added. Comparison is on the part that identifies, and the
 * hints go along for the ride.
 */
export function wallUriKey(address: WallAddress): string {
  return address.kind === 'nsite'
    ? `nsite:${address.id}`
    : `android-app://${address.packageName}/${address.activityName}`;
}
