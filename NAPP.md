# What Tenna gives an nsite

Four things a site cannot get from a plain browser tab: notifications while it
is closed, a signer inside its service worker, a place in the operating
system's share menu, and an HTTP request that CORS does not stand in front of.
All four are the Android app only, and each is declared the way the web
already declares them where the web has a way — a site written for Tenna is a
site that still works anywhere else.

## `window.napp` — notifications

Tenna injects `window.napp` into an nsite when it can deliver notifications
for it. Today that is the Android app only. On the web and on iOS the object
is absent, so feature-detect it:

```ts
if (window.napp?.push) {
  await window.napp.push.set([...]);
}
```

There is nothing new on the Nostr wire. A subscription is an ordinary `REQ`
that Tenna keeps open on the site's behalf while the site is closed.

### `window.napp.push`

```ts
import type { NostrFilter } from '@nostrify/nostrify';

declare global {
  interface Window {
    readonly napp?: {
      readonly push?: NappPush;
    };
  }
}

interface NappPush {
  /** Replace the site's subscriptions. An empty array clears them. */
  set(subscriptions: NappSubscription[]): Promise<void>;
  /** The subscriptions as stored, after normalization. */
  get(): Promise<NappSubscription[]>;
}

interface NappSubscription {
  filters: NostrFilter[];
  relays: string[];
}
```

`window.napp` is defined before any of the site's own scripts run, and only
while a user is logged in to Tenna. Both methods are asynchronous and reject
with an `Error` whose message says why.

#### Consent

The first non-empty `set()` shows the user a prompt, "Send notifications",
alongside the prompts for signing. If they decline, `set()` rejects with
`User rejected`. If they allow, Tenna also asks the OS for its notification
permission; `set()` rejects if that is refused. Clearing with `set([])` needs
no permission.

The user can revoke the permission from the shield menu over the site. Doing
so clears the site's subscriptions; the next `set()` prompts again.

#### What a subscription may contain

Limits, all enforced on both sides of the bridge:

| What                          | Limit |
| ----------------------------- | ----- |
| subscriptions per site        | 10    |
| filters per subscription      | 10    |
| relays per subscription       | 10    |
| entries in one filter list    | 500   |

Filters keep only the keys a relay indexes: `ids`, `authors`, `kinds`,
`since`, `until`, `search`, and single-letter tag keys such as `#p` or `#t`.
Any other key is refused. `limit` is dropped. A filter must name at least one
of `ids`, `authors`, `kinds`, a tag, or `search`; a filter that would match
every event is refused.

Relays must be `wss://` or `ws://` URLs. Trailing slashes are stripped and
duplicates removed.

#### What Tenna does with them

- Every relay named by any site gets one connection, held open by a
  foreground service with a standing "Background listener" notification.
- Each subscription becomes one `REQ` on each of its relays. Relays do the
  matching.
- `since` on every filter is raised to the moment `set()` was called, and
  afterwards to the newest event delivered, so a reconnection does not replay
  history. A filter's own `since` is honoured if it is later.
- Events are deduplicated by id per site.
- The service reconnects with backoff and again as soon as the network
  returns, and restarts after a reboot while any site has subscriptions.

Tenna does not verify event signatures before delivery. Verify in the worker
if it matters to what you show.

### Delivery: the service worker

Events are delivered to the site's **service worker**, as a `push` event. A
site with no registered worker, or whose worker has no `push` listener, gets
nothing. That is the same as the web, on purpose.

Android's WebView has neither the Push API nor Web Notifications. Tenna stands
in for both by appending a small shim to every worker script it serves, so
that the usual code works unchanged:

```js
self.addEventListener('push', (event) => {
  const { event: nostrEvent } = event.data.json();

  event.waitUntil(
    self.registration.showNotification('New reply', {
      body: nostrEvent.content.slice(0, 120),
      tag: nostrEvent.id,
    }),
  );
});
```

#### The payload

`event.data.json()` returns:

```ts
interface NappPushPayload {
  /** Discriminator. Always this string. */
  $type: 'napp.push.payload';
  /** The event's id. Always present, whether or not the event itself is. */
  event_id: string;
  /** The Nostr event, as the relay sent it — see below. */
  event?: NostrEvent;
  /** Where the event came from, or where to look for it. */
  relays: string[];
}
```

`$type` is there for a worker that answers more than one push service: a site
with an ordinary web push subscription of its own gets both kinds of payload
through the same listener, and this is what tells them apart. A site that has
only this one can ignore it.

**`event` may be absent.** On Android it never is. A push, though, is a
message on somebody else's transport, and iOS gives the whole of one four
kilobytes — so an event longer than that arrives as `event_id` and `relays`,
which is what a worker fetches it with:

```js
const payload = event.data.json();

if (!payload.event) {
  // ask payload.relays for { ids: [payload.event_id] }
}
```

A worker that only ever reads `payload.event` is a worker that shows nothing
for a long note. Whether that is worth handling is the site's call, and the
fallback is cheap: the id is enough for a `tag`, and a vaguer notification is
better than none.

`relays` names the relay the event arrived from, or, where Tenna did not see
it arrive, the relays it is expected to be on. It is never empty on Android.

`event.data.text()`, `.arrayBuffer()` and `.blob()` are also provided.
`event.waitUntil()` works; Tenna waits for the promises before moving on to
the next event for the site, with a timeout of sixty seconds on Android and
twenty on iOS — see [The delivery deadline](#the-delivery-deadline).

#### `showNotification(title, options)`

Every option the Notifications API defines, honoured as far as Android takes
it:

| Option        | Effect                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `body`        | The notification text. Expands when the notification does; newlines are kept. |
| `tag`         | A later notification with the same tag replaces this one.              |
| `icon`        | The picture beside it. See [Pictures](#pictures).                      |
| `badge`       | The site's mark in the status bar. See [The badge](#the-badge).        |
| `image`       | A photograph, drawn as a thumbnail above the words when the notification is expanded. |
| `actions`     | Buttons. See [Tapping, buttons and replies](#tapping-buttons-and-replies). |
| `data`        | Anything the site wants back on `notificationclick`.                   |
| `silent`      | Post without sound or vibration.                                       |
| `renotify`    | Alert again when it replaces. Off by default, so an update is quiet.   |
| `timestamp`   | The time shown on it, in milliseconds. Defaults to when it was posted. |
| `vibrate`     | The vibration pattern — below Android 8. Above it a pattern belongs to the channel and a per-notification one is ignored, which is the platform's answer rather than Tenna's. |

`dir` and `lang` have no Android counterpart. `requireInteraction` is accepted
and ignored, as it is by Chrome on Android: the nearest the platform has is a
notification that cannot be dismissed, and that is not a power to hand a site
for saying one word.

**There is nothing Tenna-specific and nothing to opt into.** A site written for
the web is written for this. An earlier version accepted an `options.data.napp`
member carrying conversations, faces, bundles, progress bars and channels of
the site's own; it has been removed. It was reached for before the ordinary
thing worked — `badge` was being thrown away while a bespoke object was being
parsed — and a site should not have to know Tenna exists to get the whole of
what a browser gives it.

`registration.getNotifications()` and `Notification.close()` are real: the
first returns the site's own live notifications, filtered by `tag` if asked,
and the second takes one down. `Notification.permission` in the worker reads
`granted`.

The same three are available **from the site's window**, and reach the same
tray; see [Notifications from the page](#notifications-from-the-page).

The whole payload — title and options together — travels as a URL, so it is
capped at **64 KiB** of JSON. That is a great deal of words and not very much
inlined artwork; see [Pictures](#pictures).

A worked example, and the whole of what there is to know:

```js
await registration.showNotification('Alice', {
  body: 'see you there',
  tag: `dm:${peer}`,
  renotify: true,
  icon: profile.picture,
  badge: '/mark.svg',
  data: { url: `/dm/${npub}` },
  actions: [{ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Message' }],
});
```

#### One site, one app

Each site is its own app as far as the shade is concerned, and none of it is
declared:

- **One row in the shade, led by the site's own icon.** Everything the site has
  out gathers into a single *conversation* headed by the site — its icon large
  on the left, its name at the head of the row, Tenna's own mark badged small
  into the corner — with each notification listed inside it as its own line.
  See [The conversation](#the-conversation).
- **The status-bar icon is the site's**, out of its `badge` or its manifest.
  See [The badge](#the-badge).
- **The colour** is the site's own — the same one its tile is drawn on, on
  Tenna's channel wall.
- **A channel group of its own** in the system's notification settings, named
  after the site, so a user can mute one site without muting the rest. It is
  the nearest Android has to a per-origin notification permission. Sites do not
  name channels inside it: that arrived with `data.napp` and left with it,
  since a channel a site names is a settings entry the user cannot be rid of
  short of reinstalling.
- **Nothing else.** There is no second row and no header above one. Whatever
  the site sends, however many times, it has the one row — which is also why
  Android files it in the conversation section at the top of the shade rather
  than in the pile it makes of an app with several notifications out.

##### The conversation

Since Android 12 a plain notification is drawn with the **app's** icon in the
circle on the left and whatever the app passed as its large icon shrunk into
the far corner. For an nsite that is backwards twice over: the row leads with
Tenna's mark, and the picture the notification is actually about lands in the
smallest slot in it. No amount of `badge` fixes this; the badge is the status
bar's, and the shade does not consult it.

The one layout Android has that does the right thing is the conversation, and
it is what every messaging app on the platform uses. So **a site is a
conversation**, and its notifications are the lines in it:

| What Android draws            | What it is                                     |
| ----------------------------- | ---------------------------------------------- |
| the icon on the left          | the site's own, with Tenna's badged into its corner |
| the name at the head of the row | the site's                                    |
| each line inside it           | one of the site's notifications                |
| a line's name                 | that notification's `title`                    |
| a line's face                 | that notification's `icon`, cut to a circle    |
| a line's text                 | that notification's `body`                     |
| a line's picture              | that notification's `image`, as a thumbnail above its words |

A notification with no `body` has only its title to give, so the line is spoken
by the site itself and the title is the words. Collapsed, the row shows the
newest line; expanded, it shows them all. Nothing is declared and nothing can
ask for it: a site written for a browser already sends the parts.

The row is rebuilt from what the site has out, so a notification the site
closed, or the user swiped, or replaced by `tag`, leaves it. Swiping the row
away closes all of them at once and raises `notificationclose` for each; the
next push starts a fresh conversation rather than resurrecting what was
dismissed.

The buttons under the row are the **newest** notification's — one row of
buttons cannot answer four different things.

An `image` is a line of its own, above the words, because Android draws a
message carrying a picture *as* the picture and anything written on it is lost.
It is drawn small — about two lines of text tall. The shade gives a
conversation a fixed height and draws a picture at whatever size it arrives
at, so a photograph handed over whole takes the row and the notifications above
it are hidden to make space, which is the opposite of the point. A thumbnail
costs about one line instead. Tapping it opens the site, where the picture is
full size.

Only the newest photograph in the row is drawn, for the same reason: a second
is one the shade has no space for. A notification whose photograph is not shown
still shows everything it said.

##### The badge

`badge` is the standard's name for the image that stands for a notification
"when there is not enough space to display the notification itself, such as a
device's notification bar". That is Android's small icon exactly, so that is
what it becomes — which since Android 12 means **the status bar and nowhere
else**. What the shade shows is [the conversation](#the-conversation).

Three answers, in order:

1. **The notification's own `badge`**, in any of the shapes under
   [Pictures](#pictures). The status bar has one icon per row, so for a site's
   conversation it is the newest notification's badge that shows.
2. **The site's monochrome web app manifest icon** — an entry declaring
   `"purpose": "monochrome"`. Read when the site is opened from the channel
   wall, and kept, so it is there for a notification that arrives with the site
   closed.
3. **Tenna's own sun**, for a site that publishes neither.

```json
{
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/mark.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "monochrome" }
  ]
}
```

Whatever the source, only its shape survives: it is painted white over its own
alpha, because a small icon is a silhouette and the colour belongs to the
system. Full-colour artwork in that slot comes out a smudge, which is why the
site's tile is never used here. A monochrome icon may be drawn in any colour on
any padding — both are measured off and normalised — but it ends up 24dp
across, so one flat shape reads and a detailed one does not.

#### Pictures

`icon`, `badge`, `image` and an action's `icon` all take the same three
shapes:

| Shape                    | What happens                                                     |
| ------------------------ | ---------------------------------------------------------------- |
| `/logo-192.png`          | One of the site's own files, resolved against its NIP-5A manifest and served from the content-addressed blob cache. Free after the first time, works offline, reaches no network. **Prefer this.** |
| `https://…`              | Fetched by Tenna with no cookies, no redirects, an image content type, a size ceiling and a short timeout. Unavoidable for a user's avatar — but it does tell that host the device is here. |
| `data:image/…;base64,…`  | Inlined. Spent out of the same 64 KiB the words come from, so keep it to a thumbnail or don't. |

**A picture holds a notification up for two seconds and no longer.** Android
binds a line's face the first time it draws that line and never goes back for
it, so a face that arrives after the notification does is a face nobody sees —
which is why the deadline exists at all. It is shared across every picture on
one notification, so a burst from four strangers waits once. Whatever misses it
is posted without and arrives on a silent repost, which the status bar and a
photograph will still pick up even though a face will not.

The face on a line is that notification's `icon`, cut to a circle because that
is the shape of the slot. A line with no `icon` gets the system's own lettered
circle rather than the site's mark repeated down the row.

An `image` is scaled to a thumbnail, written to Tenna's cache and handed to the
shade as a file, since that is what a message carrying a picture takes. A
handful are kept and the oldest go; a photograph the site sent last week is not
one anybody is looking at.

#### Tapping, buttons and replies

**Tapping the body** opens the site's window at `data.url`, falling back to the
site's front page. It happens immediately, without waiting for anything: a tap
has to land at once, and the worker that would have routed it may not be
running. A tap on the conversation goes where its **newest** line pointed —
that is the one the row is showing and the one the user is answering.

`data.url` is a convention rather than anything the standard says — but it is
what every push service worker on Nostr already writes, and it is the only
thing that can route a tap with no worker alive to route it. So it is read.

`notificationclick` is then raised in the worker anyway, so a site that does
its routing there, as a site written for a browser does, still gets its say:

```js
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

`clients.openWindow()` and `WindowClient.focus()` both work, and both move the
window Tenna has already opened rather than making a second one. Neither is a
thing a WebView can do on its own, so both come back out to Tenna — and both
are refused unless the user has acted on one of the site's notifications in
the last minute. A worker that puts its site on screen off the back of a relay
event is not answering anybody.

Because the window is opened first and the event raised second, a site that
declares `url` **and** navigates somewhere else in `notificationclick` will
visibly go to one and then the other. Declare `url` and let it route, or
declare neither and route in the worker; doing both is doing it twice.

**Buttons** are the standard `options.actions`: `action`, `title` and `icon`,
the last drawn as a stencil the way the badge is. Three are shown. Pressing one
raises `notificationclick` with `event.action` set; it does not open a window,
so a reply typed into the shade is answered without leaving the shade.

`type: 'text'` and `placeholder` give the button a reply box, and what was
typed arrives as `event.reply`. Those two are Chromium's addition rather than
the standard's, and they are honoured for the same reason `data.url` is: it is
the spelling that already exists, and there is nothing better to invent.

```js
self.addEventListener('notificationclick', (event) => {
  if (event.action !== 'reply') return;
  event.waitUntil(send(event.notification.data.url, event.reply));
});
```

**Swiping one away** raises `notificationclose`.

`event.waitUntil()` works on all of these. Tenna waits for the promises before
moving on to the next event for the site, with a timeout of sixty seconds on
Android and twenty on iOS — see [The delivery deadline](#the-delivery-deadline).

#### What is not there yet

- **Anything past the standard.** There is no way for a site to *ask* for
  anything — no naming of threads, no progress bar, no bundle key of its own,
  no channel of its own. There briefly was, in `options.data.napp`, and it was
  withdrawn. Some of it is worth having, but not in a shape settled in the
  abstract, and anything that comes back will come back as the standard
  spelling of it wherever one exists.
- **More than one conversation per site.** Everything a site sends shares one
  row. A site with several threads going has no way to say so — `tag` names a
  notification, not a conversation, and giving each tag a row of its own would
  spend a rate-limited, evictable resource on a guess.
- **Calls.** No `CallStyle`, no full-screen intent, no ringtone channel.
- **NIP-42.** The service holds no keys, so it cannot answer an `AUTH`
  challenge. A relay that requires authentication to serve a filter, as many
  do for gift wraps addressed to a user, will not deliver it.
- **Web push on the web.** The iframe path used on the web and on iOS does
  not define `window.napp`.

### Notifications from the page

A site does not have to be asleep to notify. Everything above is available
from the site's own window, under the names the web gives it:

```js
const registration = await navigator.serviceWorker.ready;

if (Notification.permission !== 'granted') {
  await Notification.requestPermission();
}

await registration.showNotification('Alice', { body: 'sent a message', tag: 'dm-1' });
```

`showNotification`, `getNotifications` and `close` behave exactly as they do in
the worker, take the same options, and work on the **same tray** — a
notification posted from the page is closed by the worker, replaced by a push
with the same `tag`, and listed by either. There is one row for the site and
one set of rules for what goes in it, whoever put it there.

`Notification.permission` is real in the page, where the worker's always reads
`granted`. It is `denied` when the site has been refused, when the user has
muted it, or when Tenna's own notifications are off in system settings — all
three being things a prompt cannot fix. `Notification.requestPermission()`
asks, and resolves with the answer; the legacy callback form works too.

#### `new Notification()` throws

As it does in every browser on Android:

```
TypeError: Failed to construct 'Notification': Illegal constructor.
Use ServiceWorkerRegistration.showNotification() instead.
```

This is not Tenna being different. The Notifications API has two kinds of
notification — a *non-persistent* one from the constructor, whose click fires
on the object in the page, and a *persistent* one from `showNotification()`,
whose click fires as `notificationclick` in the service worker — and Chrome
and Firefox for Android both implement only the second. Tenna throws the same
`TypeError` with the same message.

So **a site needs a service worker to notify from its window**, and its click
handling lives in that worker, exactly as it would in a mobile browser:

```js
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

The permission is the same one `napp.push.set` asks for. A site granted one
has been granted the other; there is no second question, because to the person
answering it there is no second thing being asked. It is a decision about this
site on this phone, so it survives signing out, and — unlike everything in
[`self.nostr`](#selfnostr--the-signer-inside-the-worker) — a site can notify a
reader who is not signed in at all.

## `napp.fetch` — a request without CORS

A native app can call any HTTP API it likes. A page cannot, because the
browser will not let it read a cross-origin response the far end has not
consented to — and an nsite is a page. So a site that wants to read an API
with no `Access-Control-Allow-Origin` on it, or a Blossom server that never
thought about browsers, has until now had to route it through somebody's
proxy.

```ts
declare global {
  interface Window {
    readonly napp?: {
      readonly push?: NappPush;
      /** Exactly `fetch`, minus CORS. */
      readonly fetch?: typeof fetch;
    };
  }
}
```

It takes what `fetch` takes and returns what `fetch` returns — a real
`Response`, with a streaming body and real headers, not an imitation of one.
So the way to use it is to pick it up once and change nothing else:

```js
const http = window.napp?.fetch ?? fetch;

const res = await http('https://api.example.com/thing', {
  headers: { authorization: `Nostr ${token}` },
});
const data = await res.json();
```

On the web and on iOS `window.napp` is absent, `http` is the ordinary `fetch`,
and the call is subject to CORS exactly as it was before. Nothing is branched
and nothing breaks; a site simply gets more of what it asked for on Android.

**Not a patched `window.fetch`, and not an option on one.** A site's own code
is not the only code on its page, and an ambient `fetch` that is quietly more
powerful than the web's is one every analytics script and transitive
dependency inherits without anyone writing it down. It is also, less loftily,
a great deal of `Response` semantics to reimplement correctly for callers who
never opted in. Every runtime that has faced this has landed in the same
place: Tauri's http plugin exports a drop-in `fetch` you import, Electron has
`net.fetch`, and Chrome extensions *removed* the content script's privileged
fetch in MV3 and moved cross-origin requests onto a message channel. The one
mainstream counter-example replaces the global, and is known for it.

### There is no permission

Nothing is asked and nothing is stored. A site that cannot reach the network
is not a site, so a prompt here would be a question with one sane answer,
asked at the worst possible moment, teaching people to press Allow. There is
no entry in the shield menu because there is no decision to revoke.

What that costs is worth saying plainly: **any site you open can reach any
https host, and tell it your IP address.** That is also true of every native
app on the phone and of every web page in a browser tab; the difference is
only that a browser would not let the page *read* the answer. What follows is
what is done instead of asking.

### The request is anonymous

**No cookies, ever.** Nothing is stored and nothing is sent, and a site cannot
set `Cookie` by hand to put them back. This is the reason lifting CORS is
defensible at all: the rule exists to stop a page reading what the user's
ambient credentials unlocked, and there are no ambient credentials here. A
site that wants to authenticate sets its own `Authorization` header —
including a NIP-98 one it signed with `window.nostr`.

`Origin`, `Referer`, `Cookie`, `Host`, `Accept-Encoding`, `X-Forwarded-*`,
`Sec-*`, `Proxy-*` and the connection headers cannot be set. `Set-Cookie` is
stripped from the response before the site sees it. Most of these the
`Headers` constructor would have refused anyway; they are refused again on the
other side of the bridge, because the browser's list is not Tenna's to depend
on.

### Where it cannot go

**`https` only.** Not `http`, not `file:`, not `data:`, not `content:`. The
only plaintext hosts a phone can usefully reach are the ones on its own
network, and those are refused for a better reason:

**Nothing on the local network.** Loopback, `10.x`, `172.16–31.x`,
`192.168.x`, link-local, carrier-grade NAT, IPv6 unique local, and the various
reserved ranges are all refused — as is `*.localhost`, which is where every
nsite lives. A phone sits inside a house, and a page that could fetch without
CORS could otherwise read the router's admin page, another app's local server,
or a printer, none of which it could reach from a browser.

This is enforced on **the address actually connected to**, and again on every
redirect hop. Refusing hostnames alone would stop nothing: any name under the
site's own control can be given an `A` record of `127.0.0.1`, which is an
ordinary DNS record and exactly how a page reaches something it should not
see.

Credentials in the URL (`https://user:pass@host/`) are refused.
`CONNECT`, `TRACE` and `TRACK` are refused, as they are by `fetch`.

### Ceilings

| What                        | Limit                        |
| --------------------------- | ---------------------------- |
| request body                | 16 MB, from a window or a worker alike |
| response                    | 64 MB                        |
| requests in flight per site | 8                            |
| redirects followed          | 5                            |
| wait for response headers   | 30 seconds                   |

A failure that a browser would report by rejecting — a refused address, a host
that does not answer, a timeout — rejects here too, with a `TypeError`, as it
would anywhere else. A server that answers with a 500 is an answer, and
resolves.

### What it cannot make true

- **`response.url`** names an internal path rather than where the bytes came
  from, because `Response.url` cannot be set from script. The real one, after
  redirects, is in the **`X-Napp-Final-Url`** header.
- **`response.type`** reads `basic`.
- **`redirect: 'manual'`** behaves as `'follow'`. `'error'` works.
- **No streaming request bodies**, in the sense the API means: the body is
  something with a known size, not a `ReadableStream` produced as it goes, and
  there is no upload progress. What crosses to the host *is* streamed, which is
  where the 16 MB stops being a memory cost, but a site cannot see that.
- **A large body cannot survive a 307 or a 308.** Those ask for the same body a
  second time, and above the size at which a worker's body is staged there is
  no second time — the request fails rather than being replayed. A 301, 302 or
  303 is fine: the standard turns those into a bodiless GET anyway.

### In the service worker

`self.napp.fetch` is the same function with the same signature, and it is
worth having for the same reason `self.nostr` is: a worker woken by a push is
often the only thing running, and what it needs to say may be behind an API
call.

```js
self.addEventListener('push', async (event) => {
  if (!self.napp) return;                     // the web, or iOS
  const res = await self.napp.fetch(url);
  // ...
});
```

**It has the same 16 MB ceiling a window has**, and gets there by a different
road that is worth knowing about only if something goes wrong.

A window stages its request over the message channel it already has, and its
body crosses as raw bytes. A worker has no such channel — the case this is
worth having for is the one with no window open at all — so everything it says
has to go through a URL. A URL is not a body, but a body does not have to be
one URL: under half a megabyte the whole request rides in the URL of a single
fetch, and above that the body is handed over a chunk at a time and written to
the socket as it arrives. Neither side ever holds all of it.

For a site this is invisible. `self.napp.fetch(url, { method: 'POST', body })`
is the same call with the same signature whatever the body's size, and a
`Blob` is the best thing to hand it — Tenna slices what it needs without the
rest being in memory. Two consequences do leak out:

- **A big upload is many round trips inside the phone**, though not on the
  network — the request itself is one HTTP request, made once.
- **A 307 or 308 redirect will fail** on a staged body. See
  [What it cannot make true](#what-it-cannot-make-true).

There is still a clock. A worker woken by a push has sixty seconds on Android
and twenty on iOS, and sixteen megabytes does not go over a mobile connection
in either — see [The delivery deadline](#the-delivery-deadline). What the size
limit stopped being is the thing in the way.

Everything else is identical, including feature detection: `self.napp` is
absent on the web and on iOS, and an installed worker does not get it until
Chromium re-fetches its script — the same caveat as
[`self.nostr`](#an-installed-worker-does-not-have-it-yet), for the same
reason, since it arrives in the same shim.

### Elsewhere

Not on the web, where there is no host around the page to make the request,
and not on iOS. `window.napp.fetch` and `self.napp.fetch` are both simply
absent, which is what the `?? fetch` is for.

## `self.nostr` — the signer, inside the worker

A site's window gets `window.nostr`, the ordinary NIP-07 provider. Its
**service worker** gets `self.nostr`, the same interface, and that is the
interesting one: a push about a message is not much of a notification until
somebody decrypts it, and the worker is the only thing running.

```js
self.addEventListener('push', async (event) => {
  const { event: dm } = event.data.json();

  let body = 'New message';
  if (self.nostr) {
    try {
      body = await self.nostr.nip44.decrypt(dm.pubkey, dm.content);
    } catch {
      // Nobody signed in, the user said no, or nobody answered. The
      // notification still goes out; it just says less.
    }
  }

  event.waitUntil(registration.showNotification('Alice', { body, tag: dm.id }));
});
```

**Feature-detect it and expect it to fail.** `self.nostr` is absent on the web
and on iOS, so the `if` is not optional. And where it is present, being present
only says Tenna can answer — not that it will. The object is baked into the
script when the worker is installed and who is signed in changes long
afterwards, so "nobody is signed in" is a rejected promise rather than a
missing object.

### What is on it

`getPublicKey`, `signEvent`, `nip04.encrypt`, `nip04.decrypt`,
`nip44.encrypt`, `nip44.decrypt`, and `getRelays`, which returns `{}` as it
does in the window. Everything returns a promise and rejects with an `Error`
whose message says why. `signEvent` returns the whole signed event, as NIP-07
does.

`nip07.signSchnorr` and `decrypt_zap_event` are not there. Neither is in
NIP-07.

### Permission

**The same grants the window has.** A site allowed to sign a kind 1 in its
window is allowed to sign one in its worker, and revoking it from the shield
menu or from Settings → Apps revokes both. They are one record; there is no
second list of worker permissions to manage, and nothing to grant in advance.

A call nobody has decided yet raises a **signing notification** — the same one
a remote NIP-46 app raises, opening the same sheet, because it is the same
question about the same key. There is no window to draw over, so that is the
only place it can go.

The call waits on the answer for **ninety seconds** and then rejects with
`Timed out waiting for approval`. Tapping the notification and pressing Allow
within that window answers the call that raised it; taking longer does not, and
the site's first notification for that permission is the one that goes out
without it. The decision is still written down, so every call after it is
answered with nothing on screen.

Two things reject without ever asking:

- **Notifications turned off for Tenna**, which is also the only way the
  notification could have been shown. Rejected out loud rather than left to
  time out.
- **Too many questions.** A worker gets a small budget of *unanswered* calls
  per half minute, per kind of call. A call the user has already granted is not
  a question and is not counted, however often it arrives. The ceiling exists
  because a worker that can raise notifications in a loop can make the phone
  unusable.

### The delivery deadline

`event.waitUntil()` inside a `push`, `notificationclick` or
`notificationclose` handler is waited on for a bounded time, after which Tenna
moves on to the next event for the site. **How long depends on the platform,
and there is no way to ask:**

| Platform | Deadline   | Set by                                           |
| -------- | ---------- | ------------------------------------------------ |
| Android  | 60 seconds | Tenna, as a judgement about queue fairness       |
| iOS      | 20 seconds | the system, near enough                          |

They differ because they are not the same kind of number. On Android delivery
runs inside a foreground service and nothing outside is counting, so the limit
is a choice: long enough for real work, short enough that one site's hung
worker does not hold up its own next event for very long. On iOS a worker runs
inside a `UNNotificationServiceExtension`, which the system kills at around
thirty seconds; twenty leaves room to hand over a fallback notification
deliberately rather than be cut off mid-sentence.

**Write for twenty and you are correct everywhere.** A handler that needs
longer will work on Android and lose its tail on iOS, which for a notification
means the difference between the real message and "New message".

A permission prompt can outlast either. So the **first** call for a given
permission will often miss its own notification even when the user says yes
promptly: Tenna moves on, and the `showNotification` that was waiting on the
decrypt lands late or not at all.

That is worth knowing and not worth designing around. Decrypt if you can,
notify with what you have if you cannot, and the second push onwards has the
grant already:

```js
const body = await decryptOrNull(dm);
event.waitUntil(registration.showNotification(title, { body: body ?? 'New message' }));
```

### An installed worker does not have it yet

The shim is appended when the worker's script is **fetched**, and the browser
keeps that script for the life of the registration. A site whose worker was
installed before this existed gets `self.nostr` the next time Chromium
re-checks the script — on the next navigation to the site, or within a day.
Nothing the site can do hurries it, and nothing breaks in the meantime; the
feature detection simply says no.

### Which account

Whoever is signed in to Tenna, and the current one where several are. The same
answer the window gets, and it can change under a long-lived worker: a site
that signed as one account last week may be answered as another today, so read
`getPublicKey()` rather than remembering what it said.

### Elsewhere

Not on the web, where there is no Tenna around the worker to ask. Not on iOS
either: a worker there runs inside a notification service extension with about
thirty seconds, a hard memory ceiling and no way to put anything in front of
the user, so there is nothing that could answer a prompt. `self.nostr` is
absent in both.

## `share_target` — a place in the OS share menu

An nsite the user has put on their home screen can appear in Android's share
sheet, under its own name and icon, alongside the installed apps. There is
nothing to call and nothing new to declare: it is the standard web app
manifest `share_target` member, exactly as an installed PWA declares it.

```json
{
  "name": "Scrapbook",
  "share_target": {
    "action": "/share",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [{ "name": "media", "accept": ["image/*", "video/*"] }]
    }
  }
}
```

Tenna reads the member when it draws the site's tile, and acts on it once the
site is **pinned to the home screen**. A site that is merely open, or merely
on the channel wall, is not offered to the share sheet — the sheet is the
user's, and putting a site in it is the user's decision, made by pinning.

### `method: "GET"`

The site is navigated to its `action` with the params in the query string,
which is all a GET target ever is. Nothing else is involved.

```
/share?title=Hello&url=https%3A%2F%2Fexample.com
```

### `method: "POST"` — needs a service worker

**A POST share is delivered to the site's service worker, and to nothing
else.** A site without one, or whose worker does not answer the navigation,
gets a page saying so, and the share is dropped.

This is not really Tenna's rule. A POST target is delivered as a form
navigation to the action, and answering one takes a server; an nsite is static
content-addressed blobs with no server behind it, so its worker is the only
thing that can. The same is true of any PWA hosted on static files, which is
why the pattern below is the one the spec's own examples use.

```js
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== '/share') return;

  event.respondWith((async () => {
    const form = await event.request.formData();
    await stash({
      title: form.get('title'),
      text: form.get('text'),
      files: form.getAll('media'),
    });
    // Redirect so the share URL isn't left in history, as on the web.
    return Response.redirect('/?shared', 303);
  })());
});
```

Register the worker at a scope that covers the action. A worker that is not
yet installed the first time a share arrives will not see it.

### What arrives

Android has one text extra where the manifest has three fields, so the split
is a judgement, made the way Chrome makes it:

| Field   | Filled from                                                        |
| ------- | ------------------------------------------------------------------ |
| `title` | `Intent.EXTRA_SUBJECT` — often absent.                             |
| `url`   | The shared text, when it is nothing but a link and `url` is declared. |
| `text`  | The shared text otherwise. Stands in for `url` if only `url` exists. |
| files   | Each shared stream, routed to the first field whose `accept` matches its MIME type. |

Files arrive as ordinary `File` objects with the name and type the sender gave
them. Ten files per share, 256 MB each, are the ceilings.

### What the share sheet actually shows

Two ways in, because only one of them is reliable:

- **The site itself**, as a sharing shortcut with its own icon. Whether these
  surface is Android's ranking to decide, not Tenna's — on a share the system
  chooses to render as a flat list of apps, they are simply absent.
- **Tenna**, always. Picking it asks which app to share to, listing every
  pinned site that can take what was shared.

`accept` is honoured exactly when the share is routed, but only approximately
when the sheet is built: the sheet matches on `text/*`, `image/*`, `video/*`,
`audio/*` and `*/*`, with no finer grain available per shortcut. A site that
takes only PNGs will be offered any image and can refuse the rest. This is the
same bargain a PWA makes.

### Elsewhere

Not on the web and not on iOS. Neither offers a third-party app any way to
put an arbitrary site in the OS share menu, so the member is read and ignored.

## How a site is served on Android

A site is the top-level document of a WebView of its own, at
`https://<subdomain>.nsite.localhost`. Nothing resolves that name; Chromium
treats any `*.localhost` origin as potentially trustworthy, so the site is a
secure context — `crypto.subtle`, service workers, the lot — and every request
it makes to its own origin is answered from the manifest inside the app.

That WebView is on a **storage profile of its own**, one per site, so a site's
cookies, storage, cache and service workers are its own and nobody else's —
including Tenna's, which keeps the default profile. Without it there is one
store for the whole app, and since `nsite.localhost` is not a public suffix,
any site could write a cookie scoped to it that every sibling would then send
and read. A profile is not a sandbox: every WebView in the app shares one
renderer process whatever profile it is on. See `NsiteProfiles`.

Answering a site's requests takes two clients, because a service worker's
fetches do not belong to any one WebView:

- The site's own WebView client serves the document and everything the
  document asks for.
- A `ServiceWorkerClient` on the site's profile serves everything a worker asks
  for, including the fetch of the worker's own script. That is where the shim
  is appended, and it works with no window open at all — which is what lets a
  notification arrive for a site the user closed.

**If you are working on this app:** that client is a single slot per profile,
and Capacitor claims the default profile's from `Bridge` unless
`android.resolveServiceWorkerRequests` is `false` in `capacitor.config.ts`.
Capacitor's client answers only for `localhost` and returns nothing for
anything else, so with it in place no nsite on the default profile can register
a worker and every notification silently goes nowhere. Leave that flag off:
it is what a WebView too old for profiles — before 114 — still depends on.

A wake page loads on its site's profile, which is where the site's window
registered the worker. A site that subscribed before profiles existed has its
worker in the shared store instead, so a wake page that finds nothing in the
profile rebuilds itself on the default one and delivers there, once, rather
than dropping the event.
