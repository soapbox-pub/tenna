# Changelog

## [0.8.2] - 2026-09-19

Nothing changes on the wall. For sites, what arrives when something they are
watching for turns up has changed shape: the event now travels with its id and
the relays it came from, so a site can still say something where the event
itself was too big to carry. A site that only reads the event needs no change.

### Changed

- What a site is handed when an event it is watching for arrives. The event
  comes with its id and the relays it came from, in place of the single relay
  and subscription number that were there before, and with a marker that tells
  it apart from any other kind of notification the site listens for. A site
  that only reads the event carries on unchanged; the id and the relays are
  what it fetches the event with where the event was too big to travel with the
  message.

## [0.8.1] - 2026-09-17

A site with a notification waiting is marked on the wall. A small dot sits in
the corner of its tile, so the thing that has something to say can be found
without pulling the shade down to look for it.

### Added

- A dot on the tile of any site with a notification waiting, on Android. It
  says the same thing the dot on Tenna's own icon in the launcher does, and it
  goes away at the same moment: when the notification is dismissed, tapped, or
  cleared with the rest. Opening the site from its tile leaves it, the way
  opening an app from the launcher does.

## [0.8.0] - 2026-09-17

Connecting an app to Tenna is a screen of its own now, with a camera on it:
point the phone at the code the other app is showing and it is connected, with
no link to copy between them. And an app that gives its name the older way —
ngit, and most things built the same way — turns up under its own name rather
than a few characters of its key.

### Added

- An app can be connected by scanning the code it shows. The box that takes a
  connection link holds a camera while it is empty, and a scanned link is
  connected on the spot; a code that isn't a connection link is passed over
  with the camera left running, so a wallet's code on the same table doesn't
  close it. Where the camera cannot read a code at all, it isn't offered.

### Changed

- Connecting an app is a screen of its own rather than a dialog over the list
  of apps that already have your key. The camera fills the display with a
  window cut in the dark to aim through, and a link Tenna makes for you to
  paste elsewhere is shown on the screen that made it. Back puts the camera
  away without leaving the screen, and from there goes to the list. A link
  arriving from outside the app still lands in the box waiting to be pressed —
  nothing is accepted by arriving.

### Fixed

- An app that gives its name the older way is listed under it. ngit, and most
  apps built on the same toolkit, appeared in the list as seven characters of
  their key.

## [0.7.1] - 2026-09-14

A site that wanted two things at once only ever got asked about one of them.
Birdstar asks for the microphone and for where you are the moment it opens, and
the second question quietly replaced the first — so the site sat waiting on an
answer that was never coming, and reported your location as unavailable. Both
questions are now asked, one after the other.

### Fixed

- A site asking for two things at the same moment is asked about both. Before,
  the second sheet replaced the first and the site was left waiting forever on
  the one that vanished — most visibly on sites that want the microphone and
  your location as soon as they open, where location simply never came up.

## [0.7.0] - 2026-09-14

A site can ask where you are. A map, a geocache, anything that wants your
location asks for it the way it asks for the camera — a sheet over the site,
remembered for that site alone, and taken back whenever you like. Until now a
site that asked was never answered at all, so it looked like nothing happened.

### Added

- Sites can use your location, on Android. The question comes up as the same
  sheet the camera and the microphone get, the phone asks its own afterwards,
  and the answer is kept for that one site and revoked from the shield menu
  over it. Saying yes to an approximate position is a yes; the site is told
  where you are, less exactly.

## [0.6.1] - 2026-09-14

Nine more of Chadwick's sites come on a fresh wall — a love calculator, an
archive of your own posts, a 3D world, geocaching, and more. As ever, every one
of them can be moved or taken off.

### Added

- Follow Party, Nostr Love Calculator, Mi, Nostrdamus, Realms, Sol, Surveil,
  Treasures and Wordsoul, all by Chadwick, on a fresh wall.

## [0.6.0] - 2026-09-13

Opening Tenna for the first time now explains itself before it asks for
anything: what it is, what an account here is, and why the key is yours alone.
From there it makes you one, keeps a copy wherever your phone keeps passwords,
and lets you put a name and a face to it. Every screen of it can be skipped,
because Tenna browses perfectly well signed out.

### Added

- An introduction, the first time Tenna is opened with nobody signed in. Three
  screens that say what this is, what an account on this network is, and what a
  key is — and then three that make you one. Skippable from every screen, and
  anyone who already has a key can bring it instead.
- A copy of your new key is handed to whatever your phone keeps passwords in,
  so there is one that outlives this install. A phone with nothing registered
  to keep passwords gets the key as a file in your Documents folder instead,
  and Tenna says so. Saying no to the prompt is taken as an answer rather than
  asked again.
- A name and a picture, asked for once at the end of signing up. Twelve
  pictures to pick from with one tap, or a photo of your own. Both optional,
  both changeable from Settings forever afterwards.

### Fixed

- Messages from Tenna appeared under the status bar clock on a phone with no
  browser chrome above them. They sit below it now.

## [0.5.0] - 2026-09-13

Tenna can sign for other apps now. An app on this phone — or one running
somewhere else, connected by a link you paste — asks, and you answer on a
screen that shows the post it would make, under your own name and face.
Settings has a new Authorized apps screen: everything that has been given your
key, one switch per thing it may do, and one way to take it all back. An
account whose key lives in another signer app can sign for sites again.

### Added

- Other apps on this phone can ask Tenna to sign, encrypt, and decrypt for the
  account you are signed in as. Tenna now appears wherever an app asks you to
  choose which app holds your key, and every request comes up as a screen with
  the asking app's icon and name at the top, and the name it was installed
  under beneath — the one thing about an app that nobody can pick for
  themselves.
- Remember an answer. Tick the box on a request and the same app asking the
  same thing again is answered without anything appearing on screen. Backing
  out of a request is always a no, and never a remembered one.
- Apps that are not on this phone can be connected too. Paste the link an app
  gives you, or make one for it to accept, from the new Authorized apps screen.
  Tenna keeps listening for them while it is closed and raises a notification
  when one wants something you have not already allowed.
- An Authorized apps screen, under Settings. Everything that has been given
  your key — sites you opened in Tenna, apps on the phone, apps somewhere else
  — in one list, each with its own icon, when it last asked, and one switch per
  thing it may do. Turning one off means being asked again; there is also one
  way to take everything back at once.
- Tombstone, by Jared Logan, on a fresh wall, and everything else he publishes
  is offered in Add app.

### Changed

- A request to sign is shown as the post it would make, rather than as the
  fields the post is made of. A note appears as a note, a profile as a profile,
  a reaction beside the note it reacts to, a follow list as faces and a count,
  and an encrypted message as one Tenna cannot read either. Your own name and
  face sit above it, where they will be once it is signed. The whole thing as
  it was sent is still one tap away.

### Fixed

- An account whose key is kept in another signer app can sign for sites again.
  Tenna would refuse anything it did not hold the key for itself, so signing in
  to a site with such an account did not work — the one thing a separate signer
  is for. It asks that app instead of answering on its behalf, and checks that
  what comes back is a signature for the account and the event you were shown.

## [0.4.0] - 2026-09-12

A search box now sits above the wall: type a few letters and Tenna answers with
the apps and sites you already have, the ones published by the people you
follow, and whatever is at an address you paste — what you opened lately first.
There is also a settings screen, behind the account menu, where the list of
places Tenna looks for sites can finally be seen and added to. On Android, a key
can no longer be lost to a phone that was only momentarily busy.

### Added

- A search box above the wall. It answers with the apps and sites on your wall,
  the rest of the phone's apps, and the sites published by the people you
  follow, with whatever you opened lately at the top. Paste an address and it
  finds the site there. Pressing a row opens the app rather than adding it — the
  plus is still how something moves onto the wall for good — and a site opened
  this way is remembered, so the second time it is at the top of the list before
  the letter finishes.
- A settings screen, reached from the account menu. It shows who is signed in,
  their key under the name they chose, and the ways to their profile, to another
  account, and out. Under that is the list of places Tenna looks for sites:
  press one to turn reading or writing off, or take it off the list, and press
  the plus to add one. Signed in, every change is published for you; signed out,
  it stays on the device. At the bottom, the version, the license, and the way
  to the source.

### Fixed

- On Android, a key is no longer taken off the device because the phone could
  not open it this time. A phone that is busy, or still waking up, answers the
  same way as one that has genuinely lost the key, and Tenna was taking it at
  its word — on a device with no way to export a key, that meant an account gone
  for good, with nobody having pressed anything.
- A site taken off the wall and put back on can reach you again without
  restarting the app. It had been left without the part of it that runs while it
  is closed, so nothing it sent arrived.
- A site pinned to the home screen keeps the icon it had. Opening it before
  Tenna had read the site would put a plain lettered tile there instead.

## [0.3.0] - 2026-09-11

On Android your key is now sealed by the phone itself and never sits in the
browser again: it is unlocked only inside the app, and every signature is made
there. A key you were already logged in with moves across on its own. Every
site also gets a store of its own, so one site can no longer read another's
cookies, and taking a site off the wall deletes what it kept. Tapping a site
opens it straight away.

### Added

- On Android, a key you give Tenna is sealed by the phone and is never held in
  the browser again. It is unlocked only inside the app, and every signature —
  yours and the ones sites ask for — is made there. A key you were already
  logged in with is moved across on sight, and signing out deletes it from the
  device. There is no way to read it back out afterwards, so the words shown at
  signup are the one chance to write them down.

### Changed

- Every site has a store of its own. Its cookies, storage and cache are its own
  and no other site's, and taking a site off the wall now deletes them. One
  consequence of the move: a site looks freshly installed the first time you
  open it, because what it saved under the store sites used to share is not
  carried across. That store also let any site read a cookie every other site
  would then send, which it can no longer do.
- The sheet asking to sign lists the event's tags, a row each, so the stranger
  being named or the thing about to be overwritten is readable without opening
  the raw text.
- A site reading a relay that asks who it is signs for it without a prompt. The
  signature buys the site nothing it could not already do as you, and a
  question with one answer is how people learn to press Allow without reading.
- The Android app's data is kept out of the phone's cloud backup. The login
  would restore as ciphertext nobody can open, but beside it sit the sites you
  have opened and what each one is allowed to do with your keys, and neither
  belongs in a backup because a default said so.
- The Android app is built for arm processors — phones and tablets. Emulators
  and the handful of x86 Chromebooks are no longer covered.
- A publisher's page no longer has a banner across the top.

### Fixed

- Tapping a site the app has not opened yet puts its window up straight away.
  It had been waiting first on artwork nothing else had asked for, which on a
  slow connection read as a missed tap.
- A site's files are checked against the address they were asked for before
  they are used, so a file store a publisher names cannot hand back something
  else.
- A site can no longer post a notification in another site's name, or take
  another site's notifications down.
- A site whose address holds characters an address should not hold no longer
  loads somebody else's page inside its own window.
- A page can no longer start a download with nobody touching the screen, and
  only ordinary web links are handed on to the phone.
- Tenna refuses to load inside another page's frame, where an "Allow" could be
  laid under whatever you meant to press.

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
