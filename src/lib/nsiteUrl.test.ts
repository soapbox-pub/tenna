import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';

import {
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  NSITE_SNAPSHOT_KIND,
  getNsiteSubdomain,
  hexToBase36,
} from '@/lib/nsiteSubdomain';
import { isNsiteUrl, nsiteUrl, parseNsiteUrl } from '@/lib/nsiteUrl';
import { parseWallUri } from '@/lib/wallUri';

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
      pointer: { kind: NSITE_ROOT_KIND, pubkey: PUBKEY, identifier: '' },
      relays: [],
      path: '/',
    });
  });

  it('reads a named site from base36 plus its d tag', () => {
    const url = parseNsiteUrl(`nsite://${B36}armada/`);
    expect(url).toMatchObject({
      pointer: { kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'armada' },
      relays: [],
    });
  });

  // NIP-5A caps the `d` tag at 13 so a gateway can serve the site at one
  // label. A host here is no DNS name and has no such limit.
  it('reads a named site whose d tag is too long for a gateway', () => {
    const url = parseNsiteUrl(`nsite://${B36}naturalist-quiz/`);
    expect(url).toMatchObject({
      pointer: { kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'naturalist-quiz' },
      relays: [],
    });
  });

  it('reads a snapshot from its `v` label', () => {
    const url = parseNsiteUrl(`nsite://v${hexToBase36(EVENT_ID)}/`);
    expect(url).toMatchObject({
      pointer: { kind: NSITE_SNAPSHOT_KIND, id: EVENT_ID },
      relays: [],
    });
  });

  // A host is case-insensitive everywhere a person types one, but `nsite:` is
  // not a special scheme, so `URL` leaves the case alone and every label rule
  // downstream is lowercase.
  it('folds the case of a host', () => {
    expect(parseNsiteUrl(`nsite://${NPUB.toUpperCase()}/`)).toEqual(
      parseNsiteUrl(`nsite://${NPUB}/`),
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
    expect(url?.relays).toEqual([]);
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
      pointer: { kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: 'blog' },
      relays: ['wss://relay.example/'],
      path: '/post',
    });
  });

  it('refuses an naddr for a kind that is not a site', () => {
    const naddr = nip19.naddrEncode({ kind: 30023, pubkey: PUBKEY, identifier: 'article' });
    expect(parseNsiteUrl(`nsite://${naddr}/`)).toBeNull();
  });
});

// A NIP-05 name is a claim about a key, resolved over the network, and no
// spelling of one names a site.
describe('parseNsiteUrl: NIP-05 names', () => {
  it.each([
    ['a bare domain', 'nsite://soapbox.pub/'],
    ['a domain and a d tag', 'nsite://soapbox.pub+armada/'],
    ['a d tag and a domain', 'nsite://armada+soapbox.pub/'],
    ['a name and a domain', 'nsite://mk@ditto.pub/'],
    ['a name joined with `+`', 'nsite://mk+ditto.pub+polaroids/'],
    ['a name in front of a canonical label', `nsite://mk@${NPUB}/`],
  ])('refuses %s', (_why, input) => {
    expect(parseNsiteUrl(input)).toBeNull();
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
    ['a password in the userinfo', `nsite://mk:secret@${NPUB}/`],
    ['a port', `nsite://${NPUB}:8080/`],
    ['an nsec, which is a secret and not a site', `nsite://${nip19.nsecEncode(new Uint8Array(32).fill(1))}/`],
    ['an npub with a broken checksum', `nsite://${NPUB.slice(0, -1)}x/`],
    ['a named site whose d tag is too long to be a label', `nsite://${B36}${'a'.repeat(64)}/`],
    ['nothing', ''],
  ])('refuses %s', (_why, input) => {
    expect(parseNsiteUrl(input)).toBeNull();
    expect(isNsiteUrl(input)).toBe(false);
  });

  // Tenna's internal id for a long-named site is not a URL spelling.
  it('does not read the internal two-label id as a site', () => {
    expect(parseNsiteUrl(`nsite://naturalist-quiz.${NPUB}/`)).toBeNull();
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

  it.each([
    ['a d tag that fits one label', 'thirteen-char', `${B36}thirteen-char`],
    ['a d tag that does not', 'fourteen-chars', `fourteen-chars.${NPUB}`],
  ])('spells a named site by its NIP-5A name, with %s', (_why, d, id) => {
    const event = {
      id: EVENT_ID, pubkey: PUBKEY, kind: NSITE_NAMED_KIND, created_at: 0,
      tags: [['d', d]], content: '', sig: '',
    };
    expect(getNsiteSubdomain(event)).toBe(id);
    expect(nsiteUrl(id)).toBe(`nsite://${B36}${d}/`);
    expect(parseNsiteUrl(nsiteUrl(id))).toMatchObject({
      pointer: { kind: NSITE_NAMED_KIND, pubkey: PUBKEY, identifier: d },
    });
    // And a wall handed the URL keeps the site by its id.
    expect(parseWallUri(nsiteUrl(id, '/x'))).toEqual({ kind: 'nsite', id, relays: [] });
  });
});
