/**
 * The `nsite://` URL grammar — how a site is named outside Tenna.
 *
 * Everything else in this app addresses a site by its NIP-5A subdomain, which
 * is what the manifest resolves to and what the site's origin is derived from.
 * That string is a key in base36 and reads like one. It is the right answer for
 * an origin and the wrong one for a link somebody sends somebody else, and a
 * link somebody sends somebody else is what this is for.
 *
 * The grammar is Ditto Browser's, which registers `nsite:` with Chromium and
 * serves NIP-5A sites from it directly. Two clients that spell the same site
 * two ways have not agreed on anything, so this is a port rather than an
 * invention — see `src/lib/nsite.ts` there. The spellings, in the order they
 * are tried:
 *
 *     nsite://<npub1…>/path                 root site, canonical
 *     nsite://<pubkeyB36><dTag>/path        named site, canonical
 *     nsite://v<snapshotIdB36>/path         snapshot, canonical (see below)
 *     nsite://naddr1…/path                  alias, carrying its own relay hints
 *
 * Every one of them names a key outright. A site is never named by a NIP-05
 * name: that is a claim about a key resolved over the network rather than the
 * key itself, and a name with `@` in it cannot survive a link in a Chromium
 * page at all, since `@` is URL userinfo and Chromium strips it.
 *
 * The canonical host is NIP-5A's verbatim, so an nsite URL maps 1:1 onto
 * `<label>.nsite-host.com` on any gateway, and onto the `siteId` this app keys
 * a site's origin, storage and permissions by.
 *
 * Unlike a gateway's subdomain, the host here is never a DNS name, so it has
 * no 63-character label to fit in, and NIP-5A's 13-character cap on the `d`
 * tag does not apply: every named site is spelled `<pubkeyB36><dTag>`. (One
 * whose `d` tag is longer is keyed internally by a different id, because the
 * origin *is* a DNS name — see `nsiteIdFor`. That id is this app's business
 * and is never spelled in a URL.)
 *
 * ## Why the `d` tag is in the host
 *
 * Because the path has to belong to the site. `nsite://<pubkeyB36>armada/x`
 * and `nsite://<npub1…>/x` are two sites' `/x`, and an SPA's routes need no
 * escaping in either. The same reasoning takes the query: `?relay=` cannot ride
 * along here, because `?` is the site's. Relay hints reach this grammar only
 * inside an `naddr`, where they are part of the identifier rather than part of
 * the URL. (Tenna's *wall* addresses are a different, deliberately
 * non-navigable spelling of the same scheme — `nsite:<id>?relay=…`, opaque,
 * with no `//`. See `wallUri.ts`.)
 *
 * ## The snapshot label
 *
 * `v<snapshotIdB36>` is a Tenna extension. NIP-5A defines the label and this
 * app serves sites addressed by it; Ditto Browser does not parse it yet, so a
 * snapshot URL is the one spelling here that does not yet round-trip. It costs
 * nothing, because {@link parseNsiteName} already reads the label.
 */
import { nip19 } from 'nostr-tools';

import {
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  nsiteNameFor,
  parseNsiteName,
  parseNsiteSubdomain,
  type ParsedNsiteSubdomain,
} from '@/lib/nsiteSubdomain';

/** The scheme nsites are named under, with its trailing colon. */
export const NSITE_PROTOCOL = 'nsite:';

/**
 * A `d` tag that can appear in a host.
 *
 * Not NIP-5A's 13 characters, which is what is left of a gateway's subdomain
 * once the base36 pubkey has had its 50; a host here is not one. But no more
 * than a label's 63, since that is the most a site id can carry.
 */
const DTAG = /^[a-z0-9-]{1,63}$/;

/** How many relay hints off an address are worth opening a socket to. */
const MAX_HINTS = 4;

export interface NsiteUrl {
  /** The site, as the rest of the app looks sites up by. */
  pointer: ParsedNsiteSubdomain;
  /** Relay hints, which only an `naddr` can carry. */
  relays: string[];
  /**
   * Where inside the site to open: site-absolute, with any query and fragment,
   * exactly as the site would see it. `/` when the URL named no place.
   */
  path: string;
}

/** Whether a `d` tag can be spelled in a canonical host. */
export function isCanonicalDtag(identifier: string): boolean {
  return DTAG.test(identifier) && !identifier.endsWith('-');
}

/** Relay hints are untrusted strings that become websocket connections. */
function tidyRelays(relays: readonly string[] | undefined): string[] {
  if (!relays) return [];

  const urls = new Set<string>();

  for (const relay of relays) {
    try {
      const url = new URL(relay);
      if (url.protocol === 'wss:') urls.add(url.href);
    } catch {
      // Not a URL, so not a relay.
    }
    if (urls.size >= MAX_HINTS) break;
  }

  return [...urls];
}

/** The pointer an `naddr` names, or null if it doesn't name a site. */
function pointerFromNaddr(data: nip19.AddressPointer): ParsedNsiteSubdomain | null {
  const { kind, pubkey, identifier } = data;

  if (kind === NSITE_NAMED_KIND && identifier) {
    return { kind: NSITE_NAMED_KIND, pubkey, identifier };
  }
  if (kind === NSITE_ROOT_KIND) {
    return { kind: NSITE_ROOT_KIND, pubkey, identifier: '' };
  }
  return null;
}

/**
 * Read an `nsite://` URL.
 *
 * Returns null for anything that isn't one, which includes a well-formed URL
 * in this scheme whose authority names no key — a NIP-05 name among them.
 * Every caller treats null as "not an address", so nothing downstream has to
 * wonder.
 */
export function parseNsiteUrl(raw: string): NsiteUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== NSITE_PROTOCOL) return null;

  // Userinfo and a port are part of none of these spellings. Both would
  // otherwise be read past in silence, and a URL that silently means something
  // other than it says is the failure mode this whole grammar is arranged to
  // avoid.
  if (url.username || url.password || url.port) return null;

  // Lowercased because a host is case-insensitive everywhere a person types
  // one, and `nsite:` is a non-special scheme, so `URL` leaves the case alone
  // rather than folding it the way it would for `https:`. Every label rule
  // below is lowercase, as is the site id the origin is built from.
  //
  // Deliberately not decoded. A percent escape is not part of any of these
  // grammars, and leaving `%` in is what makes `nsite://abc%2Fevil` fail the
  // label check rather than become `abc/evil` somewhere further down.
  const host = url.hostname.toLowerCase();
  if (!host) return null;

  const path = `${url.pathname || '/'}${url.search}${url.hash}`;

  // A canonical label is the site itself, and is tried first.
  const canonical = parseNsiteName(host);
  if (canonical) {
    return { pointer: canonical, relays: [], path };
  }

  if (!host.startsWith('naddr1')) return null;

  try {
    const decoded = nip19.decode(host);
    if (decoded.type !== 'naddr') return null;
    const pointer = pointerFromNaddr(decoded.data);
    if (!pointer) return null;
    return { pointer, relays: tidyRelays(decoded.data.relays), path };
  } catch {
    return null;
  }
}

/** Whether a string is an `nsite://` URL naming a site. */
export function isNsiteUrl(raw: string): boolean {
  return parseNsiteUrl(raw) !== null;
}

/**
 * The canonical URL for a site, which is the one to hand out.
 *
 * Built from the `siteId` rather than from however the site was reached, for
 * the same reason the origin is: an `naddr`'s relay hints are not part of the
 * site, and the key is. Spelled with the site's NIP-5A name,
 * which is the id except where the id had to be split to fit a hostname.
 */
export function nsiteUrl(siteId: string, path = '/'): string {
  const pointer = parseNsiteSubdomain(siteId);
  const host = pointer ? nsiteNameFor(pointer) : siteId;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${NSITE_PROTOCOL}//${host}${suffix}`;
}
