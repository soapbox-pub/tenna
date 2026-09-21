import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';

import {
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  NSITE_SNAPSHOT_KIND,
  hexToBase36,
} from '@/lib/nsiteSubdomain';
import { isNsiteUrl, nsiteUrl, parseNsiteUrl } from '@/lib/nsiteUrl';

/**
 * The `nsite://` grammar is the one part of this app that reads a string a
 * stranger wrote and decides which site it is. Every wrong answer available to
 * it is a site being served in place of another one, so what is checked here
 * is mostly the refusals.
 */

const PUBKEY = 'aa'.repeat(32);
const NPUB = nip19.npubEncode(PUBKEY);
const B36 = hexToBase36(PUBKEY);
const EVENT_ID = 'bb'.repeat(32);

describe('parseNsiteUrl: canonical hosts', () => {
  it('reads a root site from its npub', () => {
    expect(parseNsiteUrl(`nsite://${NPUB}/`)).toEqual({
      authority: {
        type: 'pointer',
        pointer: { kind: NSITE_ROOT_KIND, pubkey: PUBKEY, identifier: '' },
        relays: [],
      },
      path: '/',
    });
  });

  it('reads a named site from base36 plus its d tag', () => {
    const url = parseNsiteUrl(`nsite://${B36}armada/`);
    expect(url?.authority).toEqual({
      type: 'pointer',
      pointer: { kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'armada' },
      relays: [],
    });
  });

  it('reads a snapshot from its `v` label', () => {
    const url = parseNsiteUrl(`nsite://v${hexToBase36(EVENT_ID)}/`);
    expect(url?.authority).toEqual({
      type: 'pointer',
      pointer: { kind: NSITE_SNAPSHOT_KIND, id: EVENT_ID },
      relays: [],
    });
  });

  // A host is case-insensitive everywhere a person types one, but `nsite:` is
  // not a special scheme, so `URL` leaves the case alone and every label rule
  // downstream is lowercase.
  it('folds the case of a host', () => {
    expect(parseNsiteUrl(`nsite://${NPUB.toUpperCase()}/`)?.authority).toEqual(
      parseNsiteUrl(`nsite://${NPUB}/`)?.authority,
    );
  });
});

describe('parseNsiteUrl: paths', () => {
  it('defaults to the front page when the URL names no place', () => {
    expect(parseNsiteUrl(`nsite://${NPUB}`)?.path).toBe('/');
  });

  it('keeps the query and the fragment, which are the site’s', () => {
    expect(parseNsiteUrl(`nsite://${NPUB}/a/b?c=1&d=2#e`)?.path).toBe('/a/b?c=1&d=2#e');
  });

  // `?relay=` has no meaning here — the query belongs to the site. It must
  // survive as part of the path rather than be read as a hint.
  it('does not read relay hints out of the query', () => {
    const url = parseNsiteUrl(`nsite://${NPUB}/?relay=wss%3A%2F%2Fevil.example`);
    expect(url?.path).toBe('/?relay=wss%3A%2F%2Fevil.example');
    expect(url?.authority).toMatchObject({ type: 'pointer', relays: [] });
  });

  it('resolves dot segments away, so a path cannot climb out of the site', () => {
    expect(parseNsiteUrl(`nsite://${NPUB}/x/../../y`)?.path).toBe('/y');
  });
});

describe('parseNsiteUrl: naddr', () => {
  it('reads a named site, carrying the hints the identifier held', () => {
    const naddr = nip19.naddrEncode({
      kind: NSITE_NAMED_KIND,
      pubkey: PUBKEY,
      identifier: 'blog',
      relays: ['wss://relay.example/', 'http://not-a-relay.example'],
    });

    expect(parseNsiteUrl(`nsite://${naddr}/post`)).toEqual({
      authority: {
        type: 'pointer',
        pointer: { kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'blog' },
        relays: ['wss://relay.example/'],
      },
      path: '/post',
    });
  });

  it('refuses an naddr for a kind that is not a site', () => {
    const naddr = nip19.naddrEncode({ kind: 30023, pubkey: PUBKEY, identifier: 'article' });
    expect(parseNsiteUrl(`nsite://${naddr}/`)).toBeNull();
  });
});

describe('parseNsiteUrl: NIP-05 aliases', () => {
  it('reads a bare domain as that domain’s default name', () => {
    expect(parseNsiteUrl('nsite://soapbox.pub/')?.authority).toEqual({
      type: 'nip05',
      domain: 'soapbox.pub',
      name: '_',
      identifier: null,
    });
  });

  // `domain+dTag` and `name+domain` are spelled identically. Only one reading
  // can be valid, because a domain must contain a dot and a `d` tag may not.
  it('reads `domain+dTag` rather than `name+domain` when the first part has a dot', () => {
    expect(parseNsiteUrl('nsite://soapbox.pub+armada/')?.authority).toEqual({
      type: 'nip05',
      domain: 'soapbox.pub',
      name: '_',
      identifier: 'armada',
    });
  });

  it('reads `name+domain` when the second part is the one with the dot', () => {
    expect(parseNsiteUrl('nsite://mk+ditto.pub/')?.authority).toEqual({
      type: 'nip05',
      domain: 'ditto.pub',
      name: 'mk',
      identifier: null,
    });
  });

  it('reads all three parts', () => {
    expect(parseNsiteUrl('nsite://mk+ditto.pub+polaroids/')?.authority).toEqual({
      type: 'nip05',
      domain: 'ditto.pub',
      name: 'mk',
      identifier: 'polaroids',
    });
  });

  // The display spelling. Ditto Browser cannot read this one because Chromium
  // strips credentials from a privileged scheme, so it joins the name with `+`
  // on the wire — but a person types the `@`, and both mean the same site.
  it('reads the `@` spelling identically to the `+` one', () => {
    expect(parseNsiteUrl('nsite://mk@ditto.pub+polaroids/')?.authority).toEqual(
      parseNsiteUrl('nsite://mk+ditto.pub+polaroids/')?.authority,
    );
  });

  it('refuses a d tag too long to have a canonical host', () => {
    // NIP-5A: 50 base36 characters of pubkey leave 13 of a 63-character label.
    expect(parseNsiteUrl('nsite://ditto.pub+fourteen-chars/')).toBeNull();
  });

  it('refuses a d tag with a trailing hyphen', () => {
    expect(parseNsiteUrl('nsite://ditto.pub+blog-/')).toBeNull();
  });

  it('refuses a domain with no dot, which is a gateway and not a site', () => {
    expect(parseNsiteUrl('nsite://localhost/')).toBeNull();
  });
});

describe('parseNsiteUrl: refusals', () => {
  it.each([
    ['another scheme', `https://${NPUB}/`],
    ['no authority at all', `nsite:${NPUB}`],
    ['an empty authority', 'nsite:///'],
    ['a label that decodes to nothing', 'nsite://not-a-site/'],
    // `%` is in no grammar here, and leaving the host undecoded is what makes
    // this a failed label check rather than an `abc/evil` further down.
    ['a percent-escaped separator', `nsite://${NPUB}%2Fevil/`],
    // Chromium's parser would drop the `@…` outright and silently resolve
    // this to `_@ditto.pub` — a different site than anyone asked for.
    ['a doubled userinfo separator', 'nsite://mk@@ditto.pub/'],
    ['a password in the userinfo', 'nsite://mk:secret@ditto.pub/'],
    ['a port', 'nsite://ditto.pub:8080/'],
    ['four `+`-joined parts', 'nsite://a+b+ditto.pub+c/'],
    ['an empty `+`-joined part', 'nsite://ditto.pub++blog/'],
    ['an nsec, which is a secret and not a site', `nsite://${nip19.nsecEncode(new Uint8Array(32).fill(1))}/`],
    ['an npub with a broken checksum', `nsite://${NPUB.slice(0, -1)}x/`],
    ['nothing', ''],
  ])('refuses %s', (_why, input) => {
    expect(parseNsiteUrl(input)).toBeNull();
    expect(isNsiteUrl(input)).toBe(false);
  });
});

describe('nsiteUrl', () => {
  it('builds the canonical URL for a site, front page included', () => {
    expect(nsiteUrl(NPUB)).toBe(`nsite://${NPUB}/`);
  });

  it('round-trips through the parser', () => {
    const built = nsiteUrl(`${B36}armada`, '/notifications');
    expect(built).toBe(`nsite://${B36}armada/notifications`);
    expect(parseNsiteUrl(built)?.path).toBe('/notifications');
  });
});
