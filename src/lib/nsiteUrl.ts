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
 * invention — see `src/lib/nsite.ts` there. Three spellings, in the order they
 * are tried:
 *
 *     nsite://<npub1…>/path                 root site, canonical
 *     nsite://<pubkeyB36><dTag>/path        named site, canonical
 *     nsite://v<snapshotIdB36>/path         snapshot, canonical (see below)
 *     nsite://naddr1…/path                  alias, carrying its own relay hints
 *     nsite://<domain>[+<dTag>]/path        alias, NIP-05 `_@<domain>`
 *     nsite://<name>@<domain>[+<dTag>]/path alias, NIP-05, display spelling
 *     nsite://<name>+<domain>[+<dTag>]/path alias, NIP-05, wire spelling
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
 * Because the path has to belong to the site. `nsite://soapbox.pub+armada/x`
 * and `nsite://soapbox.pub/x` are two sites' `/x`, and an SPA's routes need no
 * escaping in either. The same reasoning takes the query: `?relay=` cannot ride
 * along here, because `?` is the site's. Relay hints reach this grammar only
 * inside an `naddr`, where they are part of the identifier rather than part of
 * the URL. (Tenna's *wall* addresses are a different, deliberately
 * non-navigable spelling of the same scheme — `nsite:<id>?relay=…`, opaque,
 * with no `//`. See `wallUri.ts`.)
 *
 * ## Two spellings of a NIP-05 name
 *
 * `@` is URL userinfo. Chromium strips credentials before a request reaches a
 * privileged scheme's handler, so Ditto Browser cannot read a name out of that
 * slot at all and joins it with `+` on the wire. This app parses with the
 * platform's `URL`, which keeps userinfo for a non-special scheme, so `@`
 * works here directly — but the `+` spelling is what arrives in a link
 * authored anywhere near that browser, and both are accepted.
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

/** The NIP-05 name an alias means when it names nobody in particular. */
const DEFAULT_NIP05_NAME = '_';

/**
 * A `d` tag that can appear in a host.
 *
 * Not NIP-5A's 13 characters, which is what is left of a gateway's subdomain
 * once the base36 pubkey has had its 50; a host here is not one. But no more
 * than a label's 63, since that is the most a site id can carry.
 */
const DTAG = /^[a-z0-9-]{1,63}$/;

/** The NIP-05 local part, per NIP-05. */
const NIP05_NAME = /^[a-z0-9\-_.]{1,64}$/;

/** A plausible DNS name to ask for a `nostr.json`: at least one dot. */
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** How many relay hints off an address are worth opening a socket to. */
const MAX_HINTS = 4;

/**
 * Who the URL says owns the site.
 *
 * A canonical label and an `naddr` both name a key outright, so both collapse
 * to the same pointer the rest of the app looks sites up by. A NIP-05 name
 * names a key only after somebody has asked a web server, so it stays a
 * question until `lookupNip05` answers it — see `nip05.ts`.
 */
export type NsiteUrlAuthority =
  | { type: 'pointer'; pointer: ParsedNsiteSubdomain; relays: string[] }
  | { type: 'nip05'; domain: string; name: string; identifier: string | null };

export interface NsiteUrl {
  authority: NsiteUrlAuthority;
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

/** One reading of a `+`-joined authority, before its parts are checked. */
interface HostReading {
  name: string;
  domain: string;
  identifier: string | null;
}

/**
 * Read a NIP-05 authority, in any of its spellings.
 *
 * A `+`-joined host is ambiguous at two parts — `domain+dTag` and
 * `name+domain` are spelled identically — but only one reading can ever be
 * valid, because a domain must contain a dot and a `d` tag may not. So the
 * readings are tried in NIP-5A's order and the first that checks out wins.
 *
 * `userinfo` is the name out of the `@` slot, if the URL had one. It settles
 * the ambiguity outright: with a name already in hand the host is `domain` or
 * `domain+dTag` and cannot be anything else.
 */
function readNip05Host(host: string, userinfo: string): HostReading | null {
  const parts = host.split('+');
  if (parts.length > 3 || parts.some((part) => part.length === 0)) return null;

  const readings: HostReading[] = [];

  if (userinfo) {
    if (parts.length > 2) return null;
    readings.push({ name: userinfo, domain: parts[0], identifier: parts[1] ?? null });
  } else if (parts.length === 1) {
    readings.push({ name: '', domain: parts[0], identifier: null });
  } else if (parts.length === 2) {
    readings.push({ name: '', domain: parts[0], identifier: parts[1] });
    readings.push({ name: parts[0], domain: parts[1], identifier: null });
  } else {
    readings.push({ name: parts[0], domain: parts[1], identifier: parts[2] });
  }

  for (const reading of readings) {
    if (!DOMAIN.test(reading.domain)) continue;
    if (reading.identifier !== null && !isCanonicalDtag(reading.identifier)) continue;
    const name = reading.name || DEFAULT_NIP05_NAME;
    if (!NIP05_NAME.test(name)) continue;
    return { ...reading, name };
  }

  return null;
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
 * in this scheme whose authority names nothing findable. Every caller treats
 * null as "not an address", so nothing downstream has to wonder.
 */
export function parseNsiteUrl(raw: string): NsiteUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (url.protocol !== NSITE_PROTOCOL) return null;

  // A port is not part of any of these spellings, and a password is not part
  // of the one that uses the userinfo slot. Both would otherwise be read past
  // in silence, and a URL that silently means something other than it says is
  // the failure mode this whole grammar is arranged to avoid.
  if (url.port || url.password) return null;

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

  // A canonical label is the site itself, and is tried first so that nothing
  // resolved over the network can shadow one.
  const canonical = parseNsiteName(host);
  if (canonical) {
    return { authority: { type: 'pointer', pointer: canonical, relays: [] }, path };
  }

  if (host.startsWith('naddr1')) {
    try {
      const decoded = nip19.decode(host);
      if (decoded.type !== 'naddr') return null;
      const pointer = pointerFromNaddr(decoded.data);
      if (!pointer) return null;
      return {
        authority: { type: 'pointer', pointer, relays: tidyRelays(decoded.data.relays) },
        path,
      };
    } catch {
      return null;
    }
  }

  const reading = readNip05Host(host, url.username.toLowerCase());
  if (!reading) return null;

  return {
    authority: {
      type: 'nip05',
      domain: reading.domain,
      name: reading.name,
      identifier: reading.identifier,
    },
    path,
  };
}

/** Whether a string is an `nsite://` URL naming a site. */
export function isNsiteUrl(raw: string): boolean {
  return parseNsiteUrl(raw) !== null;
}

/**
 * The canonical URL for a site, which is the one to hand out.
 *
 * Built from the `siteId` rather than from however the site was reached, for
 * the same reason the origin is: a name resolved over the network is a claim
 * about a key, and the key is the site. Spelled with the site's NIP-5A name,
 * which is the id except where the id had to be split to fit a hostname.
 */
export function nsiteUrl(siteId: string, path = '/'): string {
  const pointer = parseNsiteSubdomain(siteId);
  const host = pointer ? nsiteNameFor(pointer) : siteId;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${NSITE_PROTOCOL}//${host}${suffix}`;
}
