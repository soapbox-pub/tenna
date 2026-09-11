# Tenna

**Pick a channel.** Tenna is an nsite browser — a home screen for the apps that
live on Nostr.

An *nsite* is a website published to Nostr: a signed manifest listing every one
of the site's files by path and hash, and the files themselves stored as blobs
on Blossom servers. There is no host to go down and no domain to expire. Tenna
finds those manifests, fetches the blobs, and serves the site to itself — so a
site is read from the relay and the blob store, not from anybody's server.

There are two Tennas, from one codebase: a web app, and an Android app built
with Capacitor. What a site can do differs between them; what a site has to
declare does not.

## The wall

The home screen is a wall of tiles, and everything on it is the user's. Sites
sit on it beside the device's own installed apps, in whatever order they have
been dragged into. Each site also has a *channel* — its number counted down the
wall — which is the whole of the television conceit and the only ordering Tenna
imposes on anything.

A device nobody has touched yet ships with a starting set of tiles and a plus.
Tiles are added from a catalog of nsites — those published by Team Soapbox,
Nsite Packagers, and whoever else Tenna ships on the wall, plus the logged-in
user's own sites and the sites published by everyone they follow — or by
pasting an address: an `naddr`, an `npub`, a `nostr:` URI, or a gateway URL.
Anything on the wall can be taken off, and nothing puts it back.

## How a site is served

| | |
| --- | --- |
| **Manifest** | NIP-5A — kind `15128` (root site), `35128` (named site), `5128` (snapshot). Each `path` tag maps one pathname to one sha256. |
| **Files** | Blossom, from the `server` tags on the event, falling back to app defaults. Content-addressed, so cacheable forever and verifiable on arrival. |
| **Origin** | The site is a document of its own, on an origin of its own. It never shares one with Tenna. |

On **Android** a site is the top-level document of a WebView at
`https://<subdomain>.nsite.localhost`, and every request it makes is answered
from the manifest inside the app. Chromium treats `*.localhost` as potentially
trustworthy, so the site is a secure context: `crypto.subtle`, service workers,
the lot. Each site is on a WebView profile of its own, so its cookies, storage
and workers are separate from every other site's and from Tenna's, and taking
a site off the wall deletes them. Given a window of its own, a site gets its
own task, its own card in the recents switcher, and the whole screen with
nothing of Tenna's over it.

On the **web** a site runs in a sandboxed cross-origin iframe on a subdomain of
`iframe.diy`, derived by HMAC from a device-local secret so that no third party
can predict the label and reach the site's storage.

## Identity

Tenna holds the keys; the sites do not. Each site is injected with a
`window.nostr` implementing NIP-07, which is a proxy: `getPublicKey()` answers
immediately, and everything else — `signEvent`, `nip04.*`, `nip44.*` — is a
JSON-RPC call out to Tenna, which asks the user.

Permissions are remembered per (user, site), and per event kind for signing, so
allowing a site to publish a note is not allowing it to publish anything else.
They are reviewed and revoked from the shield menu over the site.

## The face it wears

Tenna has colours of its own — a dark red screen, a yellow sun — and gives them
up the moment the signed-in user has some. A Ditto **profile theme** is a
replaceable kind `16767` carrying three colours, up to two font files, and a
picture for the background: what a visitor to that person's profile sees.
Tenna is not a profile, but it is the thing standing between them and every
site they open, and it has no reason to insist.

So the whole palette is three colours and everything else is derived from them,
the body and heading fonts come off the wire, and the picture goes behind the
wall in place of Tenna's own weather. Whether the app reads light or dark is
the theme's own answer — its text against its background — and the status bar
follows. It is read on login and kept, so the next cold start opens in it
rather than changing into it a second later. Signing out, or in as somebody
else, puts Tenna back in its own.

A publisher's page wears that publisher's theme for as long as it is open, read
from the relay while it is looked at rather than kept. The page a person made
for themselves is the right dressing for the page about them — and since their
wallpaper is a picture chosen to be looked at rather than read on, the text
there sits on frosted panels of the theme's own colours, with the picture
showing through and around them.

A theme is a stranger's event reaching a stylesheet, which is a thing this app
does nowhere else. Colours must be `#rrggbb` exactly; URLs must be plain
`https:` and hold no character that could close a `url()`; every value is set
through CSSOM rather than written as CSS text; and fonts are fetched as bytes
and handed to `FontFace` under names of Tenna's own choosing, so no string from
an event is ever parsed as a stylesheet — which is also why `font-src` in the
CSP is still `'self'`.

## What Android adds

Two things a site cannot get from a browser tab: **notifications while it is
closed**, and **a place in the OS share sheet**. Both are declared the way the
web already declares them — `window.napp.push` for the relay subscriptions
Tenna holds open on the site's behalf, delivered to the site's own service
worker as ordinary `push` events; `share_target` in the web app manifest,
honoured once the user pins the site to their home screen.

A site written for the web is written for both. See **[NAPP.md](NAPP.md)** for
the whole of it.

## Development

```bash
npm run dev     # dev server
npm run test    # typecheck, lint, tests, build — the gate before committing
npm run build   # production build to dist/
```

The Android app wraps the same build:

```bash
npm run build
npx cap sync android
npx cap run android
```

Icons under `public/` and `android/app/src/main/res/` are rasterised from
`public/logo.svg` by `npm run icons`, which the dev and build scripts run for
you. They are build output; edit the SVG.

### Layout

```
src/
├── components/
│   ├── nsite/         # the two ways a site is drawn: iframe, and native WebView
│   ├── ui/            # shadcn/ui primitives
│   └── auth/          # login, account switching
├── hooks/             # useWall, useNsiteApp, useNsiteLaunch, useNsiteAllowance, …
├── lib/               # manifests, subdomains, permissions, Blossom, sandbox
├── pages/             # Index (the wall), NsiteApp (a site's own window), NIP19Page
└── test/              # TestApp wrapper for Vitest
android/app/src/main/java/pub/soapbox/tenna/
                       # Nsite* — serving sites, windows, shares, shortcuts
                       # Napp*  — the relay pool, the foreground service, the shade
```

`AGENTS.md` documents the conventions this codebase is written to; `NAPP.md` is
the reference for nsite authors.

### CI and releases

ngit-ci watches `.ngit/act/workflows/` and runs them with `act`; results appear
on gitworkshop.dev against the commit. There are three:

| | |
| --- | --- |
| `test.yml` | Every push and Nostr PR. `npm run test` — typecheck, lint, unit tests, production build — plus `npm audit`. |
| `deploy-nsite.yml` | Every push to `main`. Builds the client and publishes it as the nsite described by `.nsite/config.json`, through `scripts/nsite-deploy.sh`. Tenna serves itself the way it serves everything else. |
| `release.yml` | Every `vX.Y.Z` tag. Builds the signed Android APK — version and versionCode derived from the tag, never committed — and publishes it to Zapstore from `zapstore.yaml`. |

Cutting a release is `git tag vX.Y.Z && git push origin main vX.Y.Z`: the tag
builds the APK, and the push to `main` republishes the nsite from the same
commit.

Each workflow names the secrets it needs in its header. The ngit-ci operator
provisions them against this repo's alias, and injects them only on
maintainer-authored triggers — there is no default token.

## Stack

React 19, TypeScript, Vite, TailwindCSS 4, shadcn/ui,
[Nostrify](https://nostrify.dev), TanStack Query, React Router, Capacitor 8.

## License

Tenna is free software, licensed under the
[GNU Affero General Public License v3.0](LICENSE) or later.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.
