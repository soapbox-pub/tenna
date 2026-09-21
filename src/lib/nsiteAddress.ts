/**
 * Turn something a person can paste into a filter that finds an nsite.
 *
 * The addresses in circulation for a site are not one format but several — the
 * naddr a publisher hands out, the npub of whoever published it, a nostr: URI
 * off a web page, an `nsite://` URL, or the gateway URL the site is read at.
 * All of them name the same manifest, so all of them are taken here.
 *
 * What is *not* here is the half of an address that needs asking somebody: an
 * `nsite://` URL may name its author by NIP-05 rather than by key, and that is
 * a fetch rather than a parse. This module stays synchronous and hands those
 * back unresolved — see `useNsiteAddress`, which does the asking.
 */
import type { NostrFilter } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';

import {
  NSITE_KINDS,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  NSITE_SNAPSHOT_KIND,
  parseNsiteSubdomain,
  type ParsedNsiteSubdomain,
} from '@/lib/nsiteSubdomain';
import { parseNsiteUrl } from '@/lib/nsiteUrl';

/** How many relay hints off an address are worth opening a socket to. */
const MAX_HINTS = 4;

/**
 * A pasted address, read as far as reading alone can take it.
 *
 * Nearly every spelling names a key outright and is a filter on the spot. The
 * exception is an `nsite://` URL that names its author by NIP-05, which is a
 * question for a web server before it is a question for a relay — so it is
 * handed back as the question rather than pretended into an answer.
 */
export type NsiteAddress = NsiteFilterAddress | NsiteNip05Address;

interface NsiteAddressBase {
  /**
   * Where inside the site the address pointed, if it pointed anywhere.
   *
   * Only an `nsite://` URL can carry one; a bare `naddr` names a site and not
   * a place in it. Null rather than `/` so that "named no path" stays
   * distinguishable from "named the front page", which is what decides whether
   * a window already open on the site gets sent anywhere.
   */
  path: string | null;
}

export interface NsiteFilterAddress extends NsiteAddressBase {
  type: 'filter';
  /** Finds the manifest, and nothing else. */
  filter: NostrFilter;
  /** Relays the address named, if it named any. */
  relays: string[];
}

export interface NsiteNip05Address extends NsiteAddressBase {
  type: 'nip05';
  domain: string;
  name: string;
  /** The `d` tag being addressed, or null for the key's root site. */
  identifier: string | null;
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

/** The filter that finds the manifest a subdomain names. */
export function nsitePointerFilter(pointer: ParsedNsiteSubdomain): NostrFilter {
  if (pointer.kind === NSITE_SNAPSHOT_KIND) {
    return { ids: [pointer.id], kinds: [...NSITE_KINDS], limit: 1 };
  }
  if (pointer.kind === NSITE_NAMED_KIND) {
    return {
      kinds: [NSITE_NAMED_KIND],
      authors: [pointer.pubkey],
      '#d': [pointer.identifier],
      limit: 1,
    };
  }
  return { kinds: [NSITE_ROOT_KIND], authors: [pointer.pubkey], limit: 1 };
}

/** The first label of a URL or bare hostname — `<subdomain>.nsite.lol`. */
function hostLabel(input: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;

  try {
    const { hostname } = new URL(withScheme);
    const [label, ...rest] = hostname.split('.');
    // A bare hostname with nothing under it is a gateway, not a site on one.
    return rest.length > 0 && label ? label : null;
  } catch {
    return null;
  }
}

/** The site a NIP-05 name turns out to own, once the name has been resolved. */
export function nip05Pointer(pubkey: string, identifier: string | null): ParsedNsiteSubdomain {
  return identifier
    ? { kind: NSITE_NAMED_KIND, pubkey, identifier }
    : { kind: NSITE_ROOT_KIND, pubkey, identifier: '' };
}

/** A filter address, with no path and no hints unless it said otherwise. */
function found(filter: NostrFilter, relays: string[] = [], path: string | null = null): NsiteFilterAddress {
  return { type: 'filter', filter, relays, path };
}

/**
 * Parse a pasted nsite address.
 *
 * Accepts `naddr`/`npub`/`nprofile`/`nevent`/`note` (bare or behind a `nostr:`
 * URI), `nsite://` URLs in every spelling of that grammar, and gateway URLs
 * whose leading label is a NIP-5A subdomain.
 *
 * An `nevent` or `note` is left as a plain id lookup rather than assumed to be
 * a snapshot: a publisher who copies the event id of a manifest gets the same
 * site as one who copies its naddr, and which kind it turns out to be is the
 * fetched event's business.
 *
 * Returns null for anything that isn't an address, including `nsec` — which is
 * a secret someone is one paste away from handing over, not a site.
 */
export function parseNsiteAddress(input: string): NsiteAddress | null {
  // Before the `nostr:` strip, because an `nsite://` URL has a scheme of its
  // own and a grammar of its own — including hosts with `+` and `@` in them
  // that nothing below would make sense of.
  const url = parseNsiteUrl(input);
  if (url) {
    const { authority, path } = url;
    return authority.type === 'pointer'
      ? found(nsitePointerFilter(authority.pointer), authority.relays, path)
      : { type: 'nip05', domain: authority.domain, name: authority.name, identifier: authority.identifier, path };
  }

  const trimmed = input.trim().replace(/^(?:web\+)?nostr:/i, '');
  if (!trimmed) return null;

  try {
    const decoded = nip19.decode(trimmed);

    switch (decoded.type) {
      case 'npub':
        return found({ kinds: [NSITE_ROOT_KIND], authors: [decoded.data], limit: 1 });

      case 'nprofile':
        return found(
          { kinds: [NSITE_ROOT_KIND], authors: [decoded.data.pubkey], limit: 1 },
          tidyRelays(decoded.data.relays),
        );

      case 'naddr': {
        const { kind, pubkey, identifier, relays } = decoded.data;
        if (kind === NSITE_NAMED_KIND && identifier) {
          return found(
            { kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 },
            tidyRelays(relays),
          );
        }
        if (kind === NSITE_ROOT_KIND) {
          return found({ kinds: [kind], authors: [pubkey], limit: 1 }, tidyRelays(relays));
        }
        return null;
      }

      case 'note':
        return found({ ids: [decoded.data], kinds: [...NSITE_KINDS], limit: 1 });

      case 'nevent':
        return found(
          { ids: [decoded.data.id], kinds: [...NSITE_KINDS], limit: 1 },
          tidyRelays(decoded.data.relays),
        );

      default:
        return null;
    }
  } catch {
    // Not a NIP-19 identifier — it may still be a URL with one inside it.
  }

  const label = hostLabel(trimmed);
  const pointer = label ? parseNsiteSubdomain(label) : null;

  return pointer ? found(nsitePointerFilter(pointer)) : null;
}
