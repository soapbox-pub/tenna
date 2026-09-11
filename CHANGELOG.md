# Changelog

## [0.2.1] - 2026-09-10

A publisher's page now wears that publisher's own colours and lays their sites
out as a wall of tiles. The sheet that asks permission shows the app's own icon
and the name you know it by, rather than a shield. A new device starts with
more on its wall, and the list of apps to add now offers your own sites
alongside the ones you follow.

### Added

- A new wall starts with more on it: Ditto, Shakespeare, Armada, Birdstar,
  NostrHub, Agora, YourSpace, Polaroids and Espy. All of them can be moved or
  taken off, and nothing puts them back.
- Your own sites are offered in the list of apps to add, beside the ones the
  people you follow publish.

### Changed

- A publisher's page wears their theme while it is open — their colours, their
  fonts, their picture behind it — and their sites are laid out as tiles of the
  size and shape they take on the wall, each one ticked if it is already there.
  The text on the page sits on frosted panels, so a name or a paragraph stays
  readable over whatever picture a stranger chose.
- The sheet asking to sign shows the site's own tile and the name it is known
  by on the wall, instead of a shield and the name buried in its address. That
  name is what a remembered permission is filed under, and what notifications
  Tenna posts for the site are signed with, so a notification arrives wearing
  the same name as the icon beside it.
- A publisher's name is shown whole, wrapping if it must, instead of being cut
  short.

### Fixed

- The name under a tile is legible over any wallpaper. Its halo follows the
  theme's own background colour rather than always being black, which under a
  light theme put a dark smudge around dark letters.
- The "remember this" box in a permission request is a square again. It was
  drawn as a circle, which is a radio button's shape and means the opposite
  thing.

## [0.2.0] - 2026-09-10

On Android, Tenna can now sign in through a signer app already installed on the
phone. The key stays in that app — Tenna never holds it — and every signature,
including the ones sites ask for, is approved there. Any signer apps on the
device are offered on the login screen, above the field for a key.

### Added

- On Android, sign in through a signer app installed on the phone. Tenna never
  holds the key: it asks that app for a signature and the app asks you. Signer
  apps found on the device are listed on the login screen, each under its own
  name and icon. Relays that ask Tenna to prove who it is will bring the signer
  app forward to approve that too.

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
