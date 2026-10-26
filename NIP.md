# Conventions this app relies on

Tenna defines no event kinds of its own. It reads and writes NIP-5A manifests,
NIP-65 relay lists, NIP-07/NIP-46 signing and the rest as specified. The one
thing it defines is a URL scheme, which is not an event at all but is a
protocol-level convention two clients have to agree on, so it is written down
here.

## `nsite://` — addressing a NIP-5A site

NIP-5A says how a site is *served*: a manifest event, blobs on Blossom, and a
canonical host — `<npub>`, `v<snapshotIdB36>`, `<pubkeyB36><dTag>` — that a
gateway answers at as a DNS label. It says nothing about how a site is
*named* outside a gateway, and a site served without one still needs an
address somebody can send somebody else.

`nsite://` is that address. The grammar is
[Ditto Browser](https://gitlab.com/soapbox-pub/ditto-browser)'s
(`src/lib/nsite.ts` there), which registers the scheme with Chromium and
serves NIP-5A sites from it directly. Tenna's implementation is
`src/lib/nsiteUrl.ts`; this section is the agreement between them.

### Canonical

The authority is NIP-5A's canonical host, verbatim:

```
nsite://<npub1…>/<path>              root site      kind 15128
nsite://<pubkeyB36><dTag>/<path>     named site     kind 35128
nsite://v<snapshotIdB36>/<path>      snapshot       kind 5128
```

Parsed in that order, which is NIP-5A's. Because the authority is derived from
a key, it is also the origin: a client gives each site its own storage, its own
service worker registration and its own permissions under this string.

An authority is case-insensitive, as a host is. `nsite:` is not a
[special scheme](https://url.spec.whatwg.org/#special-scheme), so URL parsers
do **not** fold its case for you; fold it before matching, since every label
rule here is lowercase.

### `naddr`

One more spelling names a key, with relay hints. It resolves to a canonical
URL and serves nothing itself.

```
nsite://naddr1…/<path>
```

An `naddr` must carry kind `15128` or `35128`; any other kind is not a site.
Relay hints inside the `naddr` are the **only** relay hints this grammar
carries — see below.

### No names

There is no NIP-05 spelling. A name is a claim about a key by whoever runs a
domain, resolved over the network, and an address that changes hands with the
domain is not an address. It also cannot be spelled safely: `@` is URL
userinfo, and Chromium strips it before a request reaches a privileged scheme's
handler, so a page-authored `nsite://mk@ditto.pub/` would arrive as
`nsite://ditto.pub/` with no error. A client that wants to let people type a
name should resolve it in its own UI and navigate to the canonical URL.

### The `d` tag is in the authority, and the path is the site's

`nsite://<pubkeyB36>armada/notifications` and
`nsite://<npub1…>/notifications` are two different sites' `/notifications`.
Putting the `d` tag in the path instead would mean an SPA's routes need
escaping and a root site's `/x` is spelled differently from a named site's.

The same reasoning takes the query and the fragment: they belong to the site,
so **`nsite://` URLs carry no relay hints**. A client that needs them should
use the `naddr` spelling, where they are part of the identifier rather than
part of the URL.

### Constraints worth restating

- A `d` tag in a canonical authority must match `^[a-z0-9-]{1,63}$` and must
  not end with `-`. NIP-5A caps it at 13, which is what a 63-character DNS
  label leaves after 50 of base36 pubkey; an `nsite://` authority is not a DNS
  label, so the cap does not apply, and a site whose `d` tag is longer than 13
  has an `nsite://` URL but no gateway subdomain.
- `pubkeyB36` and `snapshotIdB36` are 50 characters, but 50 base36 characters
  hold about six times more than 32 bytes. **Range-check the decoded value
  against 2^256.** Without that, a well-formed label can decode to a 65-hex
  "pubkey" that goes into an `authors` filter — and, because a bech32 secret
  key is exactly 63 characters and its first 50 are all in the base36 alphabet,
  `nsite://nsec1…/` parses as a named site and half of somebody's private key
  is sent to a relay. Every `nsec1…` and `note1…` label begins with `n`, worth
  at least 23 × 36^49, which is past 2^256 by a factor of six, so the range
  check alone refuses them.
- Userinfo and a port are in none of these spellings. Refuse rather than read
  past, so a URL never quietly means something other than what it says.

### Divergence

The snapshot label `v<snapshotIdB36>` is Tenna's. NIP-5A defines it and Tenna
serves sites addressed by it; Ditto Browser does not parse it yet, so a
snapshot URL is the one spelling that does not currently round-trip between the
two.

### What a link may do

An `nsite://` link is untrusted input — any web page can navigate to one — so
arriving at a client buys exactly one thing: the site on screen. Nothing about
following a link should add a site to a home screen, pin it, subscribe to it,
or grant it a permission.
