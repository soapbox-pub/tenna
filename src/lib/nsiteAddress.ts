/**
 * Turn something a person can paste into a filter that finds an nsite.
 *
 * The addresses in circulation for a site are not one format but several — the
 * naddr a publisher hands out, the npub of whoever published it, a nostr: URI
 * off a web page, or the gateway URL the site is read at. All of them name the
 * same manifest, so all of them are taken here.
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

/** How many relay hints off an address are worth opening a socket to. */
const MAX_HINTS = 4;

export interface NsiteAddress {
  /** Finds the manifest, and nothing else. */
  filter: NostrFilter;
  /** Relays the address named, if it named any. */
  relays: string[];
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

/**
 * Parse a pasted nsite address.
 *
 * Accepts `naddr`/`npub`/`nprofile`/`nevent`/`note` (bare or behind a `nostr:`
 * URI) and gateway URLs whose leading label is a NIP-5A subdomain.
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
  const trimmed = input.trim().replace(/^(?:web\+)?nostr:/i, '');
  if (!trimmed) return null;

  try {
    const decoded = nip19.decode(trimmed);

    switch (decoded.type) {
      case 'npub':
        return { filter: { kinds: [NSITE_ROOT_KIND], authors: [decoded.data], limit: 1 }, relays: [] };

      case 'nprofile':
        return {
          filter: { kinds: [NSITE_ROOT_KIND], authors: [decoded.data.pubkey], limit: 1 },
          relays: tidyRelays(decoded.data.relays),
        };

      case 'naddr': {
        const { kind, pubkey, identifier, relays } = decoded.data;
        if (kind === NSITE_NAMED_KIND && identifier) {
          return {
            filter: { kinds: [kind], authors: [pubkey], '#d': [identifier], limit: 1 },
            relays: tidyRelays(relays),
          };
        }
        if (kind === NSITE_ROOT_KIND) {
          return { filter: { kinds: [kind], authors: [pubkey], limit: 1 }, relays: tidyRelays(relays) };
        }
        return null;
      }

      case 'note':
        return { filter: { ids: [decoded.data], kinds: [...NSITE_KINDS], limit: 1 }, relays: [] };

      case 'nevent':
        return {
          filter: { ids: [decoded.data.id], kinds: [...NSITE_KINDS], limit: 1 },
          relays: tidyRelays(decoded.data.relays),
        };

      default:
        return null;
    }
  } catch {
    // Not a NIP-19 identifier — it may still be a URL with one inside it.
  }

  const label = hostLabel(trimmed);
  const pointer = label ? parseNsiteSubdomain(label) : null;

  return pointer ? { filter: nsitePointerFilter(pointer), relays: [] } : null;
}
