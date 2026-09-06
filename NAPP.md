# What Tenna gives an nsite

Two things a site cannot get from a plain browser tab: notifications while it
is closed, and a place in the operating system's share menu. Both are the
Android app only, and both are declared the way the web already declares them
where the web has a way — a site written for Tenna is a site that still works
anywhere else.

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
  const { event: nostrEvent, relay, subscription } = event.data.json();

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
  /** The Nostr event, as the relay sent it. */
  event: NostrEvent;
  /** The relay it arrived from. */
  relay: string;
  /** Index into the array passed to `set()` of the subscription it matched. */
  subscription: number;
}
```

`event.data.text()`, `.arrayBuffer()` and `.blob()` are also provided.
`event.waitUntil()` works; Tenna waits for the promises before moving on to
the next event for the site, with a timeout of twenty seconds.

#### `showNotification(title, options)`

Every option the Notifications API defines, honoured as far as Android takes
it:

| Option        | Effect                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `body`        | The notification text. Expands when the notification does; newlines are kept. |
| `tag`         | A later notification with the same tag replaces this one.              |
| `icon`        | The picture beside it. See [Pictures](#pictures).                      |
| `badge`       | The site's mark in the status bar. See [The badge](#the-badge).        |
| `image`       | A photograph, shown in full when the notification is expanded.         |
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

- **Its notifications bundle under a header of their own**, named after the
  site, rather than into one pile marked Tenna. The header appears once the
  site has two out; below that the notification stands on its own, which it
  can, since it already carries everything below.
- **The status-bar icon is the site's**, out of its `badge` or its manifest.
  See [The badge](#the-badge).
- **The colour** tinting both is the site's own — the same one its tile is
  drawn on, on Tenna's channel wall.
- **The site's name** sits under the title of every notification, whatever the
  site put in the title.
- **A channel group of its own** in the system's notification settings, named
  after the site, so a user can mute one site without muting the rest. It is
  the nearest Android has to a per-origin notification permission. Sites do not
  name channels inside it: that arrived with `data.napp` and left with it,
  since a channel a site names is a settings entry the user cannot be rid of
  short of reinstalling.

##### The badge

`badge` is the standard's name for the image that stands for a notification
"when there is not enough space to display the notification itself, such as a
device's notification bar". That is Android's small icon exactly, so that is
what it becomes. Three answers, in order:

1. **The notification's own `badge`**, in any of the shapes under
   [Pictures](#pictures). A site that draws one per kind of notification gets
   one per kind.
2. **The site's monochrome web app manifest icon** — an entry declaring
   `"purpose": "monochrome"`. Read when the site is opened from the channel
   wall, and kept, so it is there for a notification that arrives with the site
   closed.
3. **Tenna's own television**, for a site that publishes neither.

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

**A picture never holds a notification up.** Whatever is already decoded is
used, the notification goes out, and it is posted again — silently, under the
same tag — when the rest arrives. So the first notification from a sender may
appear without their face and gain it a moment later, and that is correct
behaviour rather than a glitch worth working around. The same is true of a
`badge`: until it lands, the notification wears whatever is next down
[the chain](#the-badge).

The picture beside a notification is `icon`, and the site's own tile — as it
appears on Tenna's home screen — where it names none, so a site that declares
nothing still looks like itself. It is left square; Android clips a large icon
to its own shape, and cropping it round here would crop it twice.

#### Tapping, buttons and replies

**Tapping the body** opens the site's window at `data.url`, falling back to the
site's front page. It happens immediately, without waiting for anything: a tap
has to land at once, and the worker that would have routed it may not be
running.

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
moving on to the next event for the site, with a timeout of twenty seconds.

#### What is not there yet

- **Anything past the standard.** There is no way for a site to ask for a
  `MessagingStyle` conversation with faces on it, an inbox of lines, a progress
  bar, a bundle key of its own or a channel of its own. There briefly was, in
  `options.data.napp`, and it was withdrawn — those are worth having, but not
  before the per-site basics are right on a device, and not in a shape settled
  in the abstract. Anything that comes back will come back as the standard
  spelling of it wherever one exists.
- **Conversation shortcuts.** Android 11's conversation section, the one that
  puts a chat above everything else in the shade, needs a long-lived dynamic
  shortcut per conversation. Nothing publishes one.
- **Calls.** No `CallStyle`, no full-screen intent, no ringtone channel.
- **`Notification` and `showNotification` in the page** are not shimmed;
  only the worker's are.
- **NIP-42.** The service holds no keys, so it cannot answer an `AUTH`
  challenge. A relay that requires authentication to serve a filter, as many
  do for gift wraps addressed to a user, will not deliver it.
- **Web push on the web.** The iframe path used on the web and on iOS does
  not define `window.napp`.

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

Answering them takes two clients, because a service worker's fetches do not
belong to any one WebView:

- The site's own WebView client serves the document and everything the
  document asks for.
- A single, process-wide `ServiceWorkerClient` serves everything a worker asks
  for, including the fetch of the worker's own script. That is where the shim
  is appended, and it works with no window open at all — which is what lets a
  notification arrive for a site the user closed.

**If you are working on this app:** that process-wide client is a single slot,
and Capacitor claims it from `Bridge` unless
`android.resolveServiceWorkerRequests` is `false` in `capacitor.config.ts`.
Capacitor's client answers only for `localhost` and returns nothing for
anything else, so with it in place no nsite can register a worker and every
notification silently goes nowhere. Leave that flag off.
