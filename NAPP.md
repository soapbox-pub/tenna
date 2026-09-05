# `window.napp` — notifications for nsites

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

## `window.napp.push`

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

### Consent

The first non-empty `set()` shows the user a prompt, "Send notifications",
alongside the prompts for signing. If they decline, `set()` rejects with
`User rejected`. If they allow, Tenna also asks the OS for its notification
permission; `set()` rejects if that is refused. Clearing with `set([])` needs
no permission.

The user can revoke the permission from the shield menu over the site. Doing
so clears the site's subscriptions; the next `set()` prompts again.

### What a subscription may contain

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

### What Tenna does with them

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

## Delivery: the service worker

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

### The payload

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

### `showNotification(title, options)`

Supported `options`:

| Option   | Effect                                                       |
| -------- | ------------------------------------------------------------ |
| `body`   | The notification text.                                       |
| `tag`    | A later notification with the same tag replaces this one.    |
| `silent` | Post without sound or vibration.                             |

Notifications are posted on a per-site channel named after the site, so the
user can silence one site in the system settings without silencing the rest.
The site's icon, as shown on Tenna's home screen, is the large icon.
`icon`, `badge`, `image`, `actions`, `renotify`, `requireInteraction` and
`vibrate` are accepted and ignored.

`registration.getNotifications()` resolves to an empty array.
`Notification.permission` in the worker reads `granted`.

### What is not there yet

- **Tapping** a notification opens or resumes the site's window. It does not
  fire `notificationclick` in the worker, and `options.data` is not delivered
  anywhere.
- **`Notification` and `showNotification` in the page** are not shimmed;
  only the worker's are.
- **NIP-42.** The service holds no keys, so it cannot answer an `AUTH`
  challenge. A relay that requires authentication to serve a filter, as many
  do for gift wraps addressed to a user, will not deliver it.
- **Web push on the web.** The iframe path used on the web and on iOS does
  not define `window.napp`.

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
