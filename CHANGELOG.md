# Changelog

## [0.1.0] - 2026-09-10

Tenna is a browser for nsites — websites published to Nostr rather than to a
server, so there is nothing to go down and no domain to expire. The home screen
is a wall of tiles you arrange yourself, each site on its own channel, beside
the apps already on your phone. Add sites from a catalog, from the people you
follow, or by pasting an address. Tenna holds your keys and asks before a site
uses one. On Android a site can reach you while closed, and take a place in the
share sheet.

### Added

- A wall of tiles as the home screen. Drag them into any order; each site keeps
  the channel number it lands on, and anything can be taken off.
- The apps already installed on the phone sit on the wall beside the sites, cut
  to the same shape.
- Sites are added from a catalog, from everyone you follow, or by pasting an
  address — including a plain gateway link.
- Every site is read from the relay and its files fetched by hash and checked
  on arrival, so it is served by Tenna rather than by anybody's server.
- A site opens in a window of its own with the whole screen, its own controls,
  and on Android its own card in the recents switcher.
- Sign in with a key, an extension, or a remote signer. On Android the login is
  kept in the device keychain.
- Sites are handed an identity that proxies back to Tenna, which asks before it
  signs. The question is a sheet over a picture of the site that asked it.
- Permissions are remembered for each site and each kind of thing it signs, and
  reviewed or revoked from the shield menu over the site.
- A site can open the device's file picker, save a file it offers, use the
  camera once allowed, play video full screen, and open outward links where the
  phone opens them.
- Pin a site to the home screen and it becomes an app of its own, with its own
  icon and name.
- On Android a pinned site appears in the operating system's share sheet under
  its own name.
- On Android a site can be told about events while it is closed and post
  notifications about them — one row per site, led by the site's own icon, with
  buttons and replies. Notifications can be turned off for a site at any time.
- Press a publisher's name to see who they are: their face, their key, what
  they wrote about themselves, and the rest of their sites.
- Tenna wears the theme of whoever is signed in — their colours, their fonts,
  their picture behind the wall — and returns to its own on signing out.
