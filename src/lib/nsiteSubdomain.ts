import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';

/** NIP-5A root site — one replaceable manifest per pubkey, no `d` tag. */
export const NSITE_ROOT_KIND = 15128;

/** NIP-5A named site — addressable manifest identified by its `d` tag. */
export const NSITE_NAMED_KIND = 35128;

/**
 * NIP-5A manifest snapshot — a regular event capturing the state of a root or
 * named site at a point in time. Its `created_at` is the version timestamp,
 * and its `a` tag points at the site it snapshotted.
 */
export const NSITE_SNAPSHOT_KIND = 5128;

/** Every kind that carries an nsite manifest. */
export const NSITE_KINDS = [NSITE_ROOT_KIND, NSITE_NAMED_KIND, NSITE_SNAPSHOT_KIND] as const;

/** Returns true for any NIP-5A manifest kind (root site, named site, or snapshot). */
export function isNsiteKind(kind: number): boolean {
  return kind === NSITE_ROOT_KIND || kind === NSITE_NAMED_KIND || kind === NSITE_SNAPSHOT_KIND;
}

/** The fixed length of a base36-encoded 32-byte value (pubkey or event id). */
const BASE36_LENGTH = 50;

/**
 * A DNS label, which is what a site id has to be.
 *
 * NIP-5A locates a site at a subdomain, so the id is a hostname label and
 * nothing else: lowercase alphanumerics and inner hyphens, 63 characters at
 * the outside. A root site's label is an npub and a snapshot's is `v` plus
 * base36, both of which satisfy this by construction — but a named site's is
 * the base36 pubkey followed by the `d` tag, and a `d` tag is arbitrary text
 * from a stranger's event.
 *
 * That matters because the label is concatenated into a URL. On Android
 * `NsiteOrigins.hostFor` builds `https://<id>.nsite.localhost` and hands it
 * straight to `WebView.loadUrl`, which does not consult
 * `shouldOverrideUrlLoading`: a `d` tag carrying `/`, `\`, `?`, `#` or `@`
 * therefore names a host that is not ours at all, and the site's own window
 * loads somebody else's page wearing the site's chrome. The same value is the
 * origin the message listener and the document-start script are scoped to, and
 * a malformed origin rule throws where it cannot be caught.
 *
 * So it is checked wherever a label enters: parsing one, and deciding whether
 * a manifest describes a site that can be served at all.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Whether a string is a site id — that is, a DNS label. */
export function isNsiteLabel(value: string): boolean {
  return LABEL.test(value);
}

/** Encode a 32-byte hex string as base36 (50 chars, zero-padded). */
export function hexToBase36(hex: string): string {
  let n = 0n;
  for (let i = 0; i < hex.length; i++) {
    n = n * 16n + BigInt(parseInt(hex[i], 16));
  }
  const b36 = n.toString(36);
  return b36.padStart(BASE36_LENGTH, '0');
}

/**
 * Decode a base36-encoded 32-byte value back to a 64-char hex string, or null
 * if it isn't one.
 *
 * Fifty base36 characters hold more than 32 bytes — about six times more — so a
 * label can be exactly the right length, entirely in the right alphabet, and
 * still name a number no key or event id could be. Without the range check
 * such a label produces a *65*-character "pubkey" that goes on to be an
 * `authors` filter, and the app asks a relay a question about something that
 * does not exist.
 *
 * It is also what refuses an `nsec`. A bech32 secret key is 63 characters,
 * which is exactly a DNS label, and its first fifty are all in the base36
 * alphabet — so without this, `nsite://nsec1…/` parses as a named site and the
 * first fifty characters of somebody's secret key are sent to a relay. Every
 * `nsec1…` label begins with `n`, worth at least 23 × 36^49, which is past
 * 2^256 by a factor of six; so is every `note1…`. An `npub1…` is decoded as an
 * npub before it ever reaches here.
 */
function base36ToHex(b36: string): string | null {
  const n = [...b36].reduce((acc, ch) => acc * 36n + BigInt(parseInt(ch, 36)), 0n);
  if (n >= 1n << 256n) return null;
  return n.toString(16).padStart(64, '0');
}

/**
 * A parsed nsite subdomain.
 *
 * Root and named sites are located by (kind, pubkey, identifier); a snapshot is
 * a regular event located by its own id, so the two shapes are discriminated on
 * `kind` rather than sharing an optional field.
 */
export type ParsedNsiteSubdomain =
  | { kind: typeof NSITE_ROOT_KIND; pubkey: string; identifier: '' }
  | { kind: typeof NSITE_NAMED_KIND; pubkey: string; identifier: string }
  | { kind: typeof NSITE_SNAPSHOT_KIND; id: string };

/**
 * Parse an nsite subdomain back into its components, following NIP-5A's
 * label precedence:
 *
 * 1. `<npub1...>` → root site (kind 15128)
 * 2. `v<50-char-base36>` → manifest snapshot (kind 5128), keyed by event id
 * 3. `<50-char-base36><dTag>` → named site (kind 35128)
 *
 * The snapshot rule is checked before the named-site rule because NIP-5A
 * specifies that order. A named site whose base36 pubkey happens to start with
 * `v` and whose `d` tag is exactly one character is therefore unreachable by
 * subdomain — an ambiguity inherent to the single-label format.
 *
 * Returns null if the subdomain cannot be parsed.
 */
export function parseNsiteSubdomain(subdomain: string): ParsedNsiteSubdomain | null {
  // Before anything is read out of it: whatever this names, it has to be a
  // label, because everything downstream puts it in a hostname. See `LABEL`.
  if (!isNsiteLabel(subdomain)) return null;

  // Root site: subdomain is an npub
  if (subdomain.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(subdomain);
      if (decoded.type !== 'npub') return null;
      return { kind: NSITE_ROOT_KIND, pubkey: decoded.data as string, identifier: '' };
    } catch {
      return null;
    }
  }

  // Snapshot: leading "v" followed by the base36 snapshot event id
  if (/^v[0-9a-z]{50}$/.test(subdomain)) {
    try {
      const id = base36ToHex(subdomain.slice(1));
      return id ? { kind: NSITE_SNAPSHOT_KIND, id } : null;
    } catch {
      return null;
    }
  }

  // Named site: first 50 chars are the base36 pubkey, the rest is the d-tag
  if (subdomain.length <= BASE36_LENGTH) return null;
  const b36Part = subdomain.slice(0, BASE36_LENGTH);
  const dTag = subdomain.slice(BASE36_LENGTH);

  // Validate base36 characters
  if (!/^[0-9a-z]+$/.test(b36Part)) return null;

  try {
    const pubkey = base36ToHex(b36Part);
    return pubkey ? { kind: NSITE_NAMED_KIND, pubkey, identifier: dTag } : null;
  } catch {
    return null;
  }
}

/**
 * Derive the NIP-5A canonical subdomain for an nsite event.
 *
 * - Root site (kind 15128): `<npub>`
 * - Named site (kind 35128 with d-tag): `<pubkeyB36><dTag>`
 * - Snapshot (kind 5128): `v<snapshotIdB36>`
 */
export function getNsiteSubdomain(event: NostrEvent): string {
  const dTag = event.tags.find(([n]) => n === 'd')?.[1];

  if (event.kind === NSITE_NAMED_KIND && dTag) {
    const pubkeyB36 = hexToBase36(event.pubkey);
    return `${pubkeyB36}${dTag}`;
  }

  if (event.kind === NSITE_SNAPSHOT_KIND) {
    return `v${hexToBase36(event.id)}`;
  }

  return nip19.npubEncode(event.pubkey);
}

/**
 * The longest name that still fits everywhere one is drawn — under a tile, in
 * the bar over a site, across the tuning display.
 */
const NSITE_NAME_LIMIT = 48;

/**
 * What the manifest calls the site: its `title` tag, or failing that the `d`
 * tag it is addressed by.
 *
 * NIP-5A's optional `title` is the author saying what the site is named, in
 * characters the `d` tag doesn't have. That one is a DNS label — lowercase,
 * hyphens, thirteen characters at the outside — so `my-blog` is the most it
 * can ever say, and a root site has no `d` tag at all to say it with.
 *
 * This is not the served document's `<title>`, which is deliberately not
 * consulted anywhere (see `pickLabel` in `useNsiteApp`). That one is written
 * for a tab strip; this one is a tag whose whole purpose is the name.
 *
 * Whitespace is collapsed and an overlong title refused, since a manifest can
 * put anything in the tag and every caller draws it somewhere with a fixed
 * amount of room. Returns null when the event offers neither, leaving the
 * fallback to the caller — only it knows what to call a site it can't name.
 */
export function getNsiteName(event: NostrEvent): string | null {
  const title = event.tags.find(([n]) => n === 'title')?.[1]?.replace(/\s+/g, ' ').trim();
  if (title && title.length <= NSITE_NAME_LIMIT) return title;

  return event.tags.find(([n]) => n === 'd')?.[1] || null;
}

/**
 * What to call a site from its address alone. A named site is addressed by
 * its `d` tag, which is the name its manifest falls back to anyway; a root
 * site or a snapshot is addressed by a key, so the start of it is all there is.
 *
 * The last resort, for a site whose manifest hasn't arrived and which has
 * never been drawn before — a tile on a cold wall, a row in the search bar.
 */
export function nameFromSubdomain(subdomain: string): string {
  const pointer = parseNsiteSubdomain(subdomain);
  if (pointer?.kind === NSITE_NAMED_KIND && pointer.identifier) return pointer.identifier;
  return `${subdomain.slice(0, 9)}…`;
}

/** An addressable/replaceable pointer to the site a snapshot was taken from. */
export interface NsiteParentAddr {
  kind: number;
  pubkey: string;
  identifier: string;
}

/**
 * Resolve the site a snapshot captures, from its single lowercase `a` tag.
 *
 * NIP-5A requires exactly one `a` tag on a snapshot, referencing the root or
 * named site it was taken from. Returns null when the tag is missing or
 * doesn't point at an nsite manifest kind, so callers can fall back to
 * rendering the snapshot on its own.
 */
export function getSnapshotParent(event: NostrEvent): NsiteParentAddr | null {
  const value = event.tags.find(([n]) => n === 'a')?.[1];
  if (!value) return null;

  const [rawKind, pubkey, identifier = ''] = value.split(':');
  const kind = Number(rawKind);

  if (kind !== NSITE_ROOT_KIND && kind !== NSITE_NAMED_KIND) return null;
  if (!/^[0-9a-f]{64}$/.test(pubkey ?? '')) return null;

  return { kind, pubkey, identifier };
}

/**
 * The site's aggregate hash — the `["x", "<sha256-hex>", "aggregate"]` tag that
 * identifies a specific version of a manifest. Two manifests with the same
 * aggregate hash serve byte-identical files.
 */
export function getNsiteAggregateHash(event: NostrEvent): string | undefined {
  const value = event.tags.find(([n, , marker]) => n === 'x' && marker === 'aggregate')?.[1];
  return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
