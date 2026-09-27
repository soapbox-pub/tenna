# Changelog

## [Unreleased]

### Changed

- On Android, a site's notifications are back in a single row led by the
  site's own icon, as they were before 0.12.1. Once a site had more than one
  notification out, the bundle Android drew for it lost the site's icon. The
  row's buttons and tap belong to the newest notification, and swiping the
  row clears the site.

## [0.12.1] - 2026-09-27

On Android, every notification from a site can now be tapped, answered or
swiped away on its own, while a site's notifications still stay together in
one bundle. Opening a site from its tile no longer brings back an older
version of it.

### Changed

- On Android, each notification from a site is now its own row in the site's
  bundle, so you can tap it, answer it with its own buttons, or swipe it away
  without touching the others. Swiping the bundle's header still clears the
  whole site at once.

### Fixed

- Opening a site from its tile no longer puts back an older version of it
  after the site has updated. Tenna also checks for updated sites whenever you
  come back to it.

## [0.12.0] - 2026-09-26

Sites can now refresh in the background: with your permission, a closed site
wakes up every so often to fetch what is new. On iPhone, sites catch up with
Android — they can ask where you are, save files, show their alert boxes, and
open links. Asking for the camera no longer closes Tenna on iPhone. The
Android app no longer contains Google Play Services.

### Added

- Sites can ask to wake up every so often while closed, to fetch what is new.
  Tenna asks you first, with a
  new **Refresh in the background** permission, and taking it back stops the
  site straight away. A site woken this way can only put up a notification if
  you have also let it send notifications. On Android it runs about when the
  site asked, at most every fifteen minutes. On iPhone the system decides when,
  and it can be a good while later.
- On iPhone, a site can now ask where you are. Tenna asks you first, the same
  way it does for the camera, and then iPhone asks whether Tenna may know.
- On iPhone, a site can now save a file: you pick where it goes.
- On iPhone, a site's `alert`, `confirm` and `prompt` boxes now appear, titled
  with the site's name.

### Removed

- A site can no longer sign or decrypt while it is closed, on Android. No site
  used it. A site can still sign and decrypt in its own window, with the same
  permissions as before.

### Fixed

- On iPhone, a site asking for the camera or microphone no longer closes
  Tenna. Neither does choosing **Take Photo** when a site asks for a file.
- On iPhone, links out of a site now work. A web link opens in your
  browser, other kinds open the app they belong to, and a link to another
  site opens that site in Tenna. As on Android, a site can only do this when
  you tap something.
- On iPhone, a site that doesn't draw around the home indicator is framed in
  its own colour, rather than running under it.

### Security

- On iPhone, only a site's own page can ask for your signature. A frame
  embedded in the site from somewhere else could reach the same channel
  before.
- The Android app no longer contains Google Play Services. Since 0.6.0 it
  had carried Google's sign-in and account libraries, which came in with the
  code that saves your key to a password manager. Tenna now uses Android's own
  password saving, which works with any password manager on Android 14 and
  up. On older phones your key is saved to a file instead, as it already was
  on phones without Google.

## [0.11.0] - 2026-09-26

Sites can reach you on iPhone while they are closed. A site that asks to be
told about something — a message, a reply — now wakes the phone and puts a
notification up, and tapping it opens the site where the notification said.
Sites opened on iPhone can also use your account for the first time. On
Android, a site has five minutes rather than one to finish what a notification
needed, and every switch in the app is drawn the right size again.

### Added

- Notifications from a closed site, on iPhone. A site asks for them exactly as
  it does on Android and runs the same code when one arrives. iOS will not let
  an app keep watching in the background, so what a site wants to hear about is
  handed to a push service that watches for it and wakes the phone — it is told
  what this phone wants, never whose phone it is. A tap opens the site at the
  page the notification names, or its front page if it names none. A site has
  twenty seconds to decide what to say, and one notification per arrival.
- Notifications from a site's own window, on iPhone, onto the same tray.

### Changed

- A site gets five minutes on Android to finish what it was doing about a
  notification, where it had sixty seconds — as long as the same site would
  get in a browser. One site taking its time holds up only its own next
  notification, never another site's.

### Fixed

- A site opened on iPhone can ask Tenna to sign, and can ask for
  notifications. Neither request ever reached Tenna there, so a site that
  wanted your account behaved as if nobody was logged in.
- Every switch in the app is drawn inside its own track. The knob was too big
  for it and hung off the right-hand end, past the edge everything else on the
  screen lines up with.

## [0.10.2] - 2026-09-22

Allowing a site something and asking Tenna to remember it now sticks. The
answer was being written somewhere the next launch could not read, so the site
asked again every time it was opened and Settings → Apps listed nothing. The
part of a site that runs while the site is closed also has a proper channel to
Tenna now: it is quicker, and a question about signing waits for the answer
rather than giving up while the phone is still in somebody's pocket.

### Changed

- How the part of a site that runs while the site is closed asks Tenna for
  things. It used to make a request of itself for every question, with
  everything it wanted to say written out inside the address, which is a poor
  way to carry anything and no way at all to wait for a reply. It has a channel
  of its own now — quicker for a short question, and streaming both ways for a
  large one, so a site uploading a picture in the background never has the
  whole of it in hand. A site calls exactly what it called before.
- A question about signing, raised by a site while it is closed, waits two and
  a half minutes for an answer rather than ninety seconds — and really waits,
  settling the moment the user presses something rather than checking once a
  second until they do. Swiping the site away no longer cancels it, which
  matters because the notification asking is usually read later.

### Fixed

- Allowing a site something and ticking "Remember for this site" is remembered
  across a relaunch. The answer was written where nothing else looks — not the
  settings screen, not the site itself the next time it opened — so the
  question came back on every launch and Settings → Apps → Authorized apps said
  "Nothing yet". An answer that cannot be written down now says so instead of
  looking like one nobody gave.
- A site refused a machine on the same network — a router, a printer, whatever
  else is on it — could reach the same machine by writing its address out in
  numbers rather than naming it.

## [0.10.1] - 2026-09-21

Nothing changes on the wall. The part of a site that runs while the site is
closed can now send a server as much as the site's own window can — sixteen
megabytes rather than thirty-two kilobytes — so uploading a picture in the
background is no longer out of reach. It also gets a minute on Android to
finish what a notification needed, up from twenty seconds, which is enough
time to fetch somebody's face before saying who a message is from.

### Changed

- How much a site can send a server while it is closed. The part of a site
  that runs in the background was held to thirty-two kilobytes a request where
  the site's own window could send sixteen megabytes; both are sixteen
  megabytes now. Nothing is called differently, whatever the size of what it
  carries, and handing over something to upload as a file rather than as bytes
  lets Tenna pass it along a piece at a time without the whole of it sitting in
  memory. A request that big is handed over once, so a server answering it by
  asking for the same thing at another address is refused rather than asked
  twice.
- A site gets sixty seconds on Android to finish what it was doing about a
  notification, where it had twenty. Nothing outside is counting that time, so
  the number was only ever a judgement about keeping one site from holding up
  another, and twenty seconds is not much for a site that has to fetch a
  picture before it can say who a message is from. On iPhone the limit belongs
  to the system rather than to Tenna and stays at twenty, so a site written to
  finish inside twenty is still right everywhere.

## [0.10.0] - 2026-09-20

A site has an address somebody can send somebody else. Press an nsite:// link
anywhere on the phone — in a message, on a web page, inside another site — and
Tenna opens the site it names. Sites can also put a notification up while they
are open rather than only while they are closed, and can read an answer from a
server a browser tab would not let them read.

### Added

- An address for a site, spelled `nsite://`, and registered on Android and
  iOS so that a link to one anywhere on the device opens the site it names. A
  site can be named by its key, by the name its publisher gave it, or by a
  domain name pointing at either, and the path after it is the site's own.
  Opening is all a link does: nothing arriving this way is added to the wall,
  pinned, or allowed anything, and a domain repointed at a different key is a
  different site with none of the old one's storage. On the web, where no app
  is allowed to claim a scheme, pasting the address into the search bar works
  as it always has.
- Notifications from a site's own window, on Android. `Notification` and
  `registration.showNotification()` work in the page as they do in the worker
  and as they do in a mobile browser, onto the same tray: a notification put
  up by the page is replaced by a push with the same tag, closed by the
  worker, and listed by either. `new Notification()` throws the `TypeError`
  Chrome and Firefox for Android throw, pointing at `showNotification()`,
  because a click belongs to the service worker on Android and always has.
  `Notification.permission` and `requestPermission()` are real.
- A site can ask any https server for something and read the answer, on
  Android. A browser refuses that unless the far end has agreed to it in
  advance, which is why a site wanting to read an ordinary API has had to
  route the request through somebody else's proxy. Nothing is asked of the
  user, so nothing about them is sent either: the request carries no cookies
  and no sign of which site made it, and it cannot reach anything on the
  phone's own network — the router, a printer, another app — or anything that
  is not https. A site written for a browser is unchanged; there is one name
  to pick up and nothing else to do.

### Changed

- "Send notifications" is now a decision about a site rather than about an
  account. It used to be filed with the permissions that concern the user's
  key, which meant it was forgotten on signing out and could not be given at
  all by a reader who had never signed in — neither of which is true of a
  notification, and neither of which is how any browser has ever treated one.
  Permissions already given are carried over; nobody is asked twice. A site
  can now notify a reader who is not signed in.

### Fixed

- A link whose address was really a private key is refused rather than read as
  a site. Written out, a key is the same shape as a site's name, so one pasted
  into Tenna was taken for a site — and part of it went out to a relay as a
  question about it. Anything naming a number too large to be a key is turned
  away now.

## [0.9.0] - 2026-09-20

A notification from a site can say what it is actually about. The part of a
site that runs while the site is closed can now ask Tenna to sign or to
decrypt, with the permission it already has in the site's own window, so a
message that arrives sealed turns up in the shade as words rather than as "New
message". And an event arriving from a relay is checked to really be the
person's it names before it becomes a notification.

### Added

- A site can sign and decrypt while it is closed, on Android. The part of a
  site that runs in the background — the same one that puts its notifications
  in the shade — asks the same questions the site's window asks, and gets the
  same answers. A question nobody has decided yet raises a signing
  notification and opens the same sheet every other app's question opens; one
  already decided is answered with nothing on screen. What a site has been
  allowed is one list however it asked, and one switch under Settings → Apps
  turns it off in both places.

### Fixed

- An event arriving from a relay for a site is checked before the site is
  handed it. A relay could write an event under anybody's key and have it read
  as theirs — a name and a face in the shade that the named person never put
  there. Both halves are now checked, the words against the event's own
  fingerprint and the signature against that, and anything failing either is
  dropped. On a device that cannot do the checking at all — emulators, and a
  few Chromebooks — nothing a site is watching for is shown, rather than shown
  unchecked.

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
