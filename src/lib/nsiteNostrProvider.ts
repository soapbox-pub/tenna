/**
 * Generates the injected bridge script for sandboxed nsites.
 *
 * The script defines `window.nostr` conforming to the NIP-07 interface.
 * `getPublicKey()` returns the embedded pubkey instantly (always allowed).
 * All other methods (`signEvent`, `nip04.*`, `nip44.*`) send JSON-RPC 2.0
 * requests to the host and await responses.
 *
 * `window.napp` carries what the web has no way to ask for and Tenna can
 * give: `push`, where the host can hold relay subscriptions open, and
 * `fetch`, an HTTP request made on the site's behalf without CORS. Both go
 * over the same channel. Either can be absent, and the object itself is
 * absent when both are — so `window.napp?.fetch` is the way to ask.
 *
 * `window.nostr` is defined only when somebody is signed in. `window.napp`
 * does not depend on that: a request to another server is a question about
 * the device rather than about a key, and has an answer for a logged-out
 * reader too.
 *
 * A serial queue ensures only one key operation is in flight at a time,
 * preventing the host from being overwhelmed with concurrent permission
 * prompts. `napp.fetch` is outside it; see the note there.
 */

/**
 * How the provider reaches the host.
 *
 * The NIP-07 surface and the JSON-RPC framing are identical either way; only
 * the two lines that send and receive a message differ.
 *
 * - `postMessage` — the site is an iframe, so the host is the parent frame.
 * - `webMessage` — the site is the top-level document of a native WebView,
 *   and the host is an `addWebMessageListener` channel injected by Android.
 */
export type NsiteRpcTransport = 'postMessage' | 'webMessage';

/** Name of the injected object for the `webMessage` transport. */
export const NSITE_WEB_MESSAGE_OBJECT = 'tennaHost';

function getTransportSource(transport: NsiteRpcTransport): {
  receive: string;
  send: string;
} {
  if (transport === 'webMessage') {
    return {
      // Android delivers replies as a MessageEvent whose data is a string.
      receive: `
  ${NSITE_WEB_MESSAGE_OBJECT}.onmessage = function(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handleResponse(msg);
  };`,
      send: `${NSITE_WEB_MESSAGE_OBJECT}.postMessage(JSON.stringify(payload));`,
    };
  }

  return {
    receive: `
  window.addEventListener('message', function(event) {
    handleResponse(event.data);
  });`,
    send: `window.parent.postMessage(payload, '*');`,
  };
}

/** What the bridge script defines beyond `window.nostr`. */
export interface NsiteBridgeOptions {
  /**
   * Define `window.napp.push`, the API a site uses to have the host hold
   * relay subscriptions open for it and wake its service worker for events.
   * Only where the host can honour it — see `supportsNappPush`.
   */
  push?: boolean;
  /**
   * Define `window.napp.fetch`, an HTTP request made on the site's behalf
   * without CORS. Only on the native path, where there is a host to make it.
   */
  fetch?: boolean;
  /**
   * Stand in for the Notifications API, which this WebView has not got.
   *
   * Not a member of `window.napp` and deliberately not one: what a site gets
   * is `Notification` and `ServiceWorkerRegistration.showNotification` under
   * their own names, so a site written for the web is written for this. See
   * {@link NOTIFICATION_SOURCE}.
   */
  notify?: boolean;
  /**
   * What `Notification.permission` reads before anything has been asked.
   *
   * The site's own grant, which the host knows synchronously and the page has
   * no way to go and fetch in time: `Notification.permission` is a getter, and
   * a site that reads it at module scope — most of them — must not be told
   * `default` and corrected a moment later. The device's half of the answer is
   * substituted natively; see {@link NSITE_NOTIFY_DEVICE_PLACEHOLDER}.
   */
  notifyGrant?: 'granted' | 'denied' | 'default';
  /**
   * Stand in for `navigator.serviceWorker`, which this WebView has not got.
   *
   * iOS only: WebKit withholds service workers from any document whose scheme
   * is not http or https, and a `WKWebView` cannot answer for either. The
   * stand-in exists so that `register()` still has somewhere to go — it is how
   * the host learns which script to run when a push arrives, and there is no
   * other record of it. See {@link SERVICE_WORKER_SOURCE}.
   */
  serviceWorker?: boolean;
  /**
   * Stand in for Periodic Background Sync, which neither WebView has.
   *
   * `registration.periodicSync` and the `periodic-background-sync` answer to
   * `navigator.permissions.query`. See {@link PERIODIC_SYNC_SOURCE}.
   */
  periodicSync?: boolean;
}

/**
 * Filled in by the host with `true` or `false`: whether this WebView can be
 * handed an `ArrayBuffer` over the message channel.
 *
 * Substituted natively rather than passed in, because it is a fact about the
 * installed WebView rather than about the site — the same reason the worker
 * shim's token and wake page are. See `NsiteWebViewPlugin.open`.
 */
export const NSITE_BINARY_MESSAGES_PLACEHOLDER = '%%NAPP_BINARY%%';

/**
 * Filled in by the host with `true` or `false`: whether the device will show
 * anything for this site at all — Tenna's notifications on in system
 * settings, and this site not muted.
 *
 * Substituted natively for the same reason the one above is. It is a fact
 * about the phone rather than about the site, the host knows it without
 * asking anyone, and `Notification.permission` has to be right on the first
 * synchronous read.
 */
export const NSITE_NOTIFY_DEVICE_PLACEHOLDER = '%%NAPP_NOTIFY_DEVICE%%';

/** The `napp.push` member, for hosts that can deliver notifications. */
const NAPP_PUSH_SOURCE = `
    push: Object.freeze({
      set: function(subscriptions) {
        return rpc('napp.push.set', { subscriptions: subscriptions });
      },
      get: function() {
        return rpc('napp.push.get', {});
      }
    }),`;

/**
 * The `napp.fetch` member.
 *
 * Deliberately a named function rather than a patched `window.fetch` or an
 * option on one. A site opts in with `window.napp?.fetch ?? fetch` and every
 * call site is then unchanged — but the ambient `fetch` stays the web's own,
 * which is what every runtime that has faced this question has settled on:
 * Tauri's http plugin exports a drop-in `fetch`, Electron has `net.fetch`, and
 * Chrome extensions moved cross-origin requests *out* of the content script's
 * `fetch` and into a message channel when MV3 landed. The one mainstream
 * counter-example, Capacitor's `CapacitorHttp`, replaces the global and is
 * known for breaking `Response` semantics for code that never asked for it.
 *
 * ## How a request gets out
 *
 * `shouldInterceptRequest` is never given a request body, so the request
 * cannot simply be made and intercepted — it would arrive with its body gone.
 * Instead the request is staged over this channel and the *response* comes
 * back through interception, which is what makes the thing handed to the site
 * a real `Response`: streaming body, real headers, no imitation.
 *
 * Two things are worth knowing about what that costs. `response.url` names
 * the local collection path rather than where the bytes came from, because
 * `Response.url` cannot be set from script; the honest answer is in the
 * `X-Napp-Final-Url` header. And a failure that a browser would report by
 * rejecting — a refused address, a dead host — arrives as a response carrying
 * `X-Napp-Error`, which is turned back into a rejection here so that a site
 * sees what it would see anywhere else.
 */
const NAPP_FETCH_SOURCE = `
    fetch: function(input, init) {
      return nappFetch(input, init);
    },`;

/**
 * The body of `napp.fetch`, defined outside the frozen object so that the
 * helpers it needs are not reachable from it.
 */
function nappFetchImplementation(): string {
  return `
  var FETCH_PATH = '/.napp/fetch';
  var ERROR_HEADER = 'X-Napp-Error';
  var BINARY_MESSAGES = ${NSITE_BINARY_MESSAGES_PLACEHOLDER};

  function abortError() {
    try {
      return new DOMException('The user aborted a request.', 'AbortError');
    } catch (e) {
      var err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      return err;
    }
  }

  /** Base64url, for a WebView that cannot be handed bytes. */
  function encodeBody(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    // In chunks, because apply() on a few million arguments overflows the
    // stack on every engine that has one.
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  function sendBody(ticket, buffer) {
    if (!BINARY_MESSAGES) {
      return call('napp.fetch.body', { ticket: ticket, body: encodeBody(buffer) });
    }

    // One message carries one payload and no metadata, so the ticket rides
    // in front of the bytes. It is a UUID, so the host knows where to cut.
    var framed = new Uint8Array(36 + buffer.byteLength);
    for (var i = 0; i < 36; i++) framed[i] = ticket.charCodeAt(i);
    framed.set(new Uint8Array(buffer), 36);
    ${NSITE_WEB_MESSAGE_OBJECT}.postMessage(framed.buffer);
    return Promise.resolve();
  }

  function nappFetch(input, init) {
    var request;
    try {
      request = new NativeRequest(input, init);
    } catch (e) {
      return Promise.reject(e);
    }

    var signal = request.signal;
    if (signal && signal.aborted) return Promise.reject(abortError());

    var headers = [];
    request.headers.forEach(function(value, name) { headers.push([name, value]); });

    return request.arrayBuffer().then(function(buffer) {
      var hasBody = buffer.byteLength > 0;

      return call('napp.fetch.begin', {
        url: request.url,
        method: request.method,
        headers: headers,
        redirect: request.redirect,
        hasBody: hasBody
      }).then(function(ticket) {
        var giveUp = function() { call('napp.fetch.abort', { ticket: ticket }); };
        if (signal) signal.addEventListener('abort', giveUp, { once: true });

        var staged = hasBody ? sendBody(ticket, buffer) : Promise.resolve();

        return staged
          .then(function() {
            return nativeFetch(FETCH_PATH + '?t=' + encodeURIComponent(ticket), {
              cache: 'no-store',
              signal: signal
            });
          })
          .then(function(response) {
            if (signal) signal.removeEventListener('abort', giveUp);

            // What a browser would have rejected with rather than resolved.
            var failure = response.headers.get(ERROR_HEADER);
            if (failure) throw new TypeError(failure);

            return response;
          }, function(err) {
            if (signal) signal.removeEventListener('abort', giveUp);
            throw err;
          });
      });
    });
  }
`;
}

/**
 * The Notifications API, for a WebView that hasn't got one.
 *
 * Android's WebView has no Web Notifications at all, in a worker or in a page.
 * The worker's half has been stood in for since notifications arrived — see
 * `napp_sw_shim.js` — and this is the page's, built to the same rule: what a
 * site gets is the API under its own name, behaving the way it behaves in a
 * browser, with nothing to opt into and nothing of Tenna's to know about.
 *
 * ## Why the constructor throws
 *
 * Because that is what a browser on Android does. The spec has two kinds of
 * notification: a *non-persistent* one from `new Notification()`, whose click
 * fires on the object in the page, and a *persistent* one from
 * `registration.showNotification()`, whose click fires as `notificationclick`
 * in the service worker no matter which of the two created it. Chrome for
 * Android implements only the second and throws on the first — "Illegal
 * constructor. Use ServiceWorkerRegistration.showNotification() instead" —
 * and Firefox for Android does the same.
 *
 * So a site's click handler living in its worker is not a quirk of Tenna's;
 * it is the only arrangement Android has ever offered, and the one every site
 * written for a phone already expects. Standing up a working constructor here
 * would be the deviation, and a silent one: its `onclick` could never fire,
 * because the window it belongs to is routinely gone by the time anybody taps.
 *
 * The interface itself is real, because `permission`, `requestPermission()`
 * and the instances `getNotifications()` hands back are all reached through
 * it.
 */
function notificationSource(grant: 'granted' | 'denied' | 'default'): string {
  return `
  /**
   * What \`Notification.permission\` reads, as the host knew it when this page
   * started, and whatever the host has said since.
   *
   * Two things decide it and either can refuse: what this site was granted,
   * interpolated here because the host knows it synchronously, and whether the
   * device will show anything at all — Tenna's notifications on, this site not
   * muted — which is substituted natively. A refusal from either is
   * \`denied\`, the web's word for "do not ask, it will not work", which is
   * true of both: a site told \`default\` would go on raising a prompt that
   * cannot help it.
   */
  var notifyState = ${NSITE_NOTIFY_DEVICE_PLACEHOLDER} ? ${JSON.stringify(grant)} : 'denied';

  function permission() {
    return notifyState;
  }

  /** Keep the cached answer honest when the host has just told us otherwise. */
  function remember(value) {
    if (value === 'granted' || value === 'denied' || value === 'default') {
      notifyState = value;
    }
  }

  /**
   * A notification the host is showing.
   *
   * Read-only, as the real one is, apart from \`close()\` — the only thing a
   * site can do to a notification once it is up, and the reason the host hands
   * back the key it filed it under. The same shape the worker's shim builds;
   * see \`NappNotification\` in napp_sw_shim.js.
   */
  function NappNotification(record) {
    var options = record.options || {};
    this.title = String(record.title == null ? '' : record.title);
    this.tag = String(record.tag == null ? '' : record.tag);
    this.body = options.body == null ? '' : String(options.body);
    this.data = options.data;
    this.icon = options.icon == null ? '' : String(options.icon);
    this.badge = options.badge == null ? '' : String(options.badge);
    this.image = options.image == null ? '' : String(options.image);
    this.actions = Array.isArray(options.actions) ? options.actions : [];
    this.silent = !!options.silent;
    this.renotify = !!options.renotify;
    this.requireInteraction = !!options.requireInteraction;
    this.timestamp = typeof options.timestamp === 'number' ? options.timestamp : 0;
    this.dir = options.dir || 'auto';
    this.lang = options.lang || '';
    this.vibrate = options.vibrate || [];
    // The host's own name for it. Not part of the API, so not enumerable — a
    // site round-tripping a notification through JSON shouldn't carry it.
    Object.defineProperty(this, '__key', { value: String(record.key || '') });
  }

  NappNotification.prototype.close = function() {
    if (!this.__key) return;
    // Outside the queue: it asks nobody anything, and a notification the user
    // wants gone should not wait behind a prompt for a signature.
    call('notification.close', { key: this.__key });
  };

  Object.defineProperty(NappNotification, 'permission', {
    configurable: true,
    get: permission
  });

  /**
   * Ask, as a browser asks: this raises the prompt rather than reporting on
   * one. The legacy callback form is honoured alongside the promise, because
   * it is still what a good deal of code in the wild calls.
   */
  NappNotification.requestPermission = function(callback) {
    return rpc('notification.request', {}).then(function(value) {
      remember(value);
      if (typeof callback === 'function') {
        try { callback(permission()); } catch (e) {}
      }
      return permission();
    }, function() {
      // A question that could not be put is not a refusal the site should
      // cache; it reports what it already knew.
      if (typeof callback === 'function') {
        try { callback(permission()); } catch (e) {}
      }
      return permission();
    });
  };

  /**
   * The constructor a browser on Android refuses, refused the same way.
   *
   * Assigned over the function above rather than written as one, so that the
   * statics and the prototype survive: \`getNotifications()\` returns
   * instances of this, and \`instanceof Notification\` has to hold for them.
   */
  function Notification() {
    throw new TypeError(
      "Failed to construct 'Notification': Illegal constructor. Use " +
      'ServiceWorkerRegistration.showNotification() instead.'
    );
  }
  Notification.prototype = NappNotification.prototype;
  NappNotification.prototype.constructor = Notification;
  Notification.requestPermission = NappNotification.requestPermission;
  Object.defineProperty(Notification, 'permission', {
    configurable: true,
    get: permission
  });
  window.Notification = Notification;

  /**
   * The two methods a registration answers, defined once.
   *
   * Put on \`ServiceWorkerRegistration.prototype\` where there is one — Android,
   * where the worker is real and only the Notifications API is missing — and
   * hung on the stand-in registration where there is not. See
   * {@link SERVICE_WORKER_SOURCE}.
   */
  var notifyMethods = {
    showNotification: function(title, options) {
      var payload;
      try {
        payload = { title: String(title), options: options || {} };
        // Thrown here rather than at the bridge, so a site gets the TypeError
        // a browser gives it instead of a message about a message channel.
        if (JSON.stringify(payload).length > ${64 * 1024}) {
          return Promise.reject(new TypeError('Notification is too large'));
        }
      } catch (e) {
        return Promise.reject(new TypeError('Notification options must be serializable'));
      }

      return rpc('notification.show', payload).then(function() {
        remember('granted');
      }, function(err) {
        // A refusal is an answer about the permission, and the only one the
        // site will get: showNotification does not report why it failed.
        if (err && /rejected|turned off|refused/i.test(String(err.message))) {
          remember('denied');
        }
        throw err;
      });
    },

    getNotifications: function(filter) {
      var tag = filter && filter.tag ? String(filter.tag) : undefined;
      // Outside the queue, as \`close\` is, and for the same reason.
      return call('notification.list', { tag: tag }).then(function(records) {
        if (!Array.isArray(records)) return [];
        return records.map(function(record) { return new NappNotification(record); });
      }, function() {
        return [];
      });
    }
  };

  var swRegistration = window.ServiceWorkerRegistration
    && window.ServiceWorkerRegistration.prototype;

  if (swRegistration) {
    swRegistration.showNotification = notifyMethods.showNotification;
    swRegistration.getNotifications = notifyMethods.getNotifications;
  }
`;
}

/**
 * Periodic Background Sync, for a WebView that hasn't got it.
 *
 * Chrome ships it only to installed web apps, and neither Android's WebView nor
 * WebKit ships it at all. So the page's half is built here, under its own
 * names — `registration.periodicSync.register(tag, { minInterval })`,
 * `getTags()`, `unregister(tag)` — and the event the worker gets is raised by
 * the worker shims, from a WorkManager job on Android and a background refresh
 * task on iOS. A site written for Chrome is written for this.
 *
 * Where it is not quite Chrome: Chrome refuses `register` unless the site is
 * installed and never asks, and this asks. A refusal is the `NotAllowedError`
 * Chrome gives. `minInterval` is rounded up to fifteen minutes, which is the
 * shortest thing either scheduler will do, and on iOS the system decides when
 * a run actually happens.
 *
 * `navigator.permissions.query` is wrapped for the names Tenna answers itself —
 * this one and `notifications` — and hands every other name to the engine.
 * Defined before {@link SERVICE_WORKER_SOURCE}, which hangs the manager on the
 * stand-in registration iOS gets.
 */
const PERIODIC_SYNC_SOURCE = `
  function periodicSyncRefusal(err) {
    var message = err && err.message ? String(err.message) : 'Permission denied.';
    if (!/denied|rejected|refused/i.test(message)) return err;
    try {
      return new DOMException('Permission denied.', 'NotAllowedError');
    } catch (e) {
      var out = new Error('Permission denied.');
      out.name = 'NotAllowedError';
      return out;
    }
  }

  function PeriodicSyncManager() {
    throw new TypeError("Failed to construct 'PeriodicSyncManager': Illegal constructor");
  }

  PeriodicSyncManager.prototype.register = function(tag, options) {
    if (arguments.length < 1) {
      return Promise.reject(new TypeError(
        "Failed to execute 'register' on 'PeriodicSyncManager': 1 argument required, but only 0 present."));
    }
    var minInterval = options && options.minInterval != null ? Number(options.minInterval) : 0;
    if (!isFinite(minInterval) || minInterval < 0) minInterval = 0;

    // Queued, because this is the one that can put a prompt on screen.
    return rpc('napp.periodicsync.register', { tag: String(tag), minInterval: minInterval })
      .then(function() {}, function(err) { throw periodicSyncRefusal(err); });
  };

  PeriodicSyncManager.prototype.unregister = function(tag) {
    return call('napp.periodicsync.unregister', { tag: String(tag) }).then(function() {});
  };

  PeriodicSyncManager.prototype.getTags = function() {
    return call('napp.periodicsync.tags', {}).then(function(tags) {
      return Array.isArray(tags) ? tags.map(String) : [];
    });
  };

  // One per page, which is one per registration: a site has one worker.
  var periodicSyncManager = Object.create(PeriodicSyncManager.prototype);
  window.PeriodicSyncManager = PeriodicSyncManager;

  // Replaced even where the engine has its own, because the engine's would
  // take registrations nothing is ever going to fire.
  var periodicRegistration = window.ServiceWorkerRegistration
    && window.ServiceWorkerRegistration.prototype;
  if (periodicRegistration) {
    try {
      Object.defineProperty(periodicRegistration, 'periodicSync', {
        configurable: true,
        get: function() { return periodicSyncManager; }
      });
    } catch (e) {}
  }

  function PermissionStatusStandIn(name, state) {
    this.name = name;
    this.state = state;
    this.onchange = null;
  }
  PermissionStatusStandIn.prototype.addEventListener = function() {};
  PermissionStatusStandIn.prototype.removeEventListener = function() {};
  PermissionStatusStandIn.prototype.dispatchEvent = function() { return true; };

  var OWN_PERMISSIONS = { 'periodic-background-sync': true, 'notifications': true };

  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    var nativeQuery = navigator.permissions.query.bind(navigator.permissions);
    try {
      navigator.permissions.query = function(descriptor) {
        var name = descriptor && descriptor.name;
        if (!OWN_PERMISSIONS[name]) return nativeQuery(descriptor);
        return call('permissions.query', { name: name }).then(function(state) {
          return new PermissionStatusStandIn(name, String(state));
        });
      };
    } catch (e) {}
  }
`;

/**
 * `navigator.serviceWorker`, for a WebView that hasn't got one.
 *
 * WebKit exposes service workers only to documents whose scheme is literally
 * http or https, and `WKWebView` reserves both and refuses a
 * `WKURLSchemeHandler` for either — so an nsite on iOS cannot have a real one,
 * and it is not a preference but the platform. See `NsiteOrigins.swift`.
 *
 * What it can have is a worker run **inside the notification extension** when a
 * push arrives, which is where the site's script actually matters: it is the
 * only thing that knows what an event means. But nothing native can find out
 * which script that is. A real registration is the browser's record, and there
 * is no browser keeping one here.
 *
 * So `register()` is the record. A site calls it exactly as it does on the web,
 * the path is written down next to the site's manifest, and the extension runs
 * that file. Nothing is declared, nothing is Tenna-specific, and a site written
 * for a browser is written for this.
 *
 * ## What the stand-in is honest about
 *
 * `showNotification` and `getNotifications` are real and reach the same tray as
 * everything else. `active` reports a worker, because from the page's point of
 * view one will run. Everything to do with **talking** to it is not: there is no
 * `postMessage`, no `controller`, no `message` event, because the worker does not
 * exist until a push arrives and the page is gone by then. `update` and
 * `unregister` resolve without doing anything, there being no registration to
 * update or throw away.
 */
const SERVICE_WORKER_SOURCE = `
  if (!('serviceWorker' in navigator)) {
    var swRegistrations = [];
    var swReadyResolve;
    var swReady = new Promise(function(resolve) { swReadyResolve = resolve; });

    function makeRegistration(url, options) {
      var registration = {
        scope: new URL((options && options.scope) || './', url.href).href,
        updateViaCache: (options && options.updateViaCache) || 'imports',
        installing: null,
        waiting: null,
        // A worker that will run, when there is something to run it for.
        // Reported as active because that is what the page is asking: may I
        // expect my worker to handle things? It may.
        active: {
          scriptURL: url.href,
          state: 'activated',
          onstatechange: null,
          postMessage: function() {},
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; }
        },
        update: function() { return Promise.resolve(registration); },
        unregister: function() { return Promise.resolve(true); },
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; }
      };

      if (typeof notifyMethods !== 'undefined') {
        registration.showNotification = notifyMethods.showNotification;
        registration.getNotifications = notifyMethods.getNotifications;
      }
      if (typeof periodicSyncManager !== 'undefined') {
        registration.periodicSync = periodicSyncManager;
      }
      return registration;
    }

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: null,
        ready: swReady,
        oncontrollerchange: null,
        onmessage: null,

        register: function(script, options) {
          var url;
          try {
            url = new URL(String(script), location.href);
          } catch (e) {
            return Promise.reject(new TypeError(
              'Failed to register a ServiceWorker: the script URL is invalid.'));
          }
          if (url.protocol !== location.protocol || url.host !== location.host) {
            return Promise.reject(new TypeError(
              'Failed to register a ServiceWorker: the origin of the provided ' +
              "scriptURL does not match the current page's origin."));
          }

          // The path only. A query string is the browser's cache-buster and
          // means nothing to a manifest, which files a script under its path.
          return rpc('napp.sw.register', { path: url.pathname }).then(function() {
            var registration = makeRegistration(url, options);
            swRegistrations = [registration];
            swReadyResolve(registration);
            return registration;
          });
        },

        getRegistration: function() { return Promise.resolve(swRegistrations[0]); },
        getRegistrations: function() { return Promise.resolve(swRegistrations.slice()); },
        startMessages: function() {},
        addEventListener: function() {},
        removeEventListener: function() {},
        dispatchEvent: function() { return true; }
      }
    });
  }
`;

export function getNsiteNostrProviderScript(
  pubkey: string | null,
  transport: NsiteRpcTransport = 'postMessage',
  options: NsiteBridgeOptions = {},
): string {
  const { receive, send } = getTransportSource(transport);

  const napp: string[] = [];
  if (options.push) napp.push(NAPP_PUSH_SOURCE);
  if (options.fetch) napp.push(NAPP_FETCH_SOURCE);

  const notifications = options.notify
    ? notificationSource(options.notifyGrant ?? 'default')
    : '';

  // After the notifications, which is where `notifyMethods` is defined: the
  // stand-in registration hangs them on itself, there being no
  // `ServiceWorkerRegistration.prototype` here to put them on.
  const serviceWorker = options.serviceWorker ? SERVICE_WORKER_SOURCE : '';

  // Before the stand-in registration, which hangs the manager on itself.
  const periodicSync = options.periodicSync ? PERIODIC_SYNC_SOURCE : '';

  return `(function() {
  'use strict';

  // The originals, taken before any of the site's own code runs. Everything
  // below is built out of these rather than out of whatever the page has on
  // its globals by the time somebody calls it — a site that replaces fetch
  // with its own wrapper, as half the world's SDKs do, must not thereby
  // change what the provider does or be able to read what passes through it.
  var nativeFetch = window.fetch.bind(window);
  var NativeRequest = window.Request;

  // ------------------------------------------------------------------
  // Serial queue — one RPC at a time to avoid concurrent prompts
  // ------------------------------------------------------------------
  var _queue = [];
  var _running = false;

  function enqueue(fn) {
    return new Promise(function(resolve, reject) {
      _queue.push({ fn: fn, resolve: resolve, reject: reject });
      drain();
    });
  }

  function drain() {
    if (_running || _queue.length === 0) return;
    _running = true;
    var item = _queue.shift();
    item.fn().then(
      function(v) { _running = false; item.resolve(v); drain(); },
      function(e) { _running = false; item.reject(e); drain(); }
    );
  }

  // ------------------------------------------------------------------
  // JSON-RPC transport
  // ------------------------------------------------------------------
  var _nextId = 1;
  var _pending = {};

  function handleResponse(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id === undefined || msg.id === null) return;
    var cb = _pending[msg.id];
    if (!cb) return;
    delete _pending[msg.id];
    if (msg.error) {
      cb.reject(new Error(msg.error.message || 'RPC error'));
    } else {
      cb.resolve(msg.result);
    }
  }
${receive}

  /** One call, sent as soon as it is made. */
  function call(method, params) {
    return new Promise(function(resolve, reject) {
      var id = _nextId++;
      _pending[id] = { resolve: resolve, reject: reject };
      var payload = {
        jsonrpc: '2.0',
        id: id,
        method: method,
        params: params || {}
      };
      ${send}
    });
  }

  /**
   * One call, waiting its turn.
   *
   * Everything that can put a question in front of the user goes through
   * here, so that a site cannot raise four prompts at once. napp.fetch
   * deliberately does not: it asks nobody anything, and a large upload
   * queued in front of a signature would stall the signature behind it for
   * as long as the upload took.
   */
  function rpc(method, params) {
    return enqueue(function() {
      return call(method, params);
    });
  }
${options.fetch ? nappFetchImplementation() : ''}${notifications}${periodicSync}${serviceWorker}
  // ------------------------------------------------------------------
  // NIP-07 provider
  // ------------------------------------------------------------------
  var pubkey = ${JSON.stringify(pubkey)};

  if (pubkey) window.nostr = {
    getPublicKey: function() {
      return Promise.resolve(pubkey);
    },

    signEvent: function(event) {
      return rpc('nostr.signEvent', { event: event });
    },

    getRelays: function() {
      return Promise.resolve({});
    },

    nip04: {
      encrypt: function(pubkey, plaintext) {
        return rpc('nostr.nip04.encrypt', { pubkey: pubkey, plaintext: plaintext });
      },
      decrypt: function(pubkey, ciphertext) {
        return rpc('nostr.nip04.decrypt', { pubkey: pubkey, ciphertext: ciphertext });
      }
    },

    nip44: {
      encrypt: function(pubkey, plaintext) {
        return rpc('nostr.nip44.encrypt', { pubkey: pubkey, plaintext: plaintext });
      },
      decrypt: function(pubkey, ciphertext) {
        return rpc('nostr.nip44.decrypt', { pubkey: pubkey, ciphertext: ciphertext });
      }
    }
  };
${napp.length === 0 ? '' : `
  // Frozen, so a site cannot swap the methods out from under its own code —
  // or another script's — after the fact.
  window.napp = Object.freeze({${napp.join('')}
  });
`}
  // Signal availability to the nsite. Only where there is a provider to be
  // ready: \`window.napp\` can be there with nobody signed in, and a site
  // waiting on this event is waiting for \`window.nostr\`.
  try {
    if (pubkey) window.dispatchEvent(new Event('nostr:ready'));
  } catch(e) {}
})();`;
}
