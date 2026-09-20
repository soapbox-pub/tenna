/*
 * Tenna's push shim, appended to every service worker script an nsite
 * registers on Android.
 *
 * Android's WebView has no Push API and no Web Notifications, so both are
 * stood in for here. An event is delivered as a `message` from a document
 * Tenna opens at the site's origin, and re-raised as the event it really is —
 * a `push`, or the `notificationclick` the user just caused — looking the way
 * one does anywhere else: `event.data.json()`, `event.waitUntil()`,
 * `event.notification.close()` and `event.reply` all work.
 *
 * Everything that reaches outside the worker is a same-origin request the
 * host answers: showing a notification, reading the tray back, taking one
 * down, and opening the site's window. See NsiteRequests.
 *
 * Appended rather than prepended so that a `'use strict'` prologue at the top
 * of the site's own script keeps meaning what it says.
 */
;(function () {
  'use strict';

  // The site's script is served with this appended wherever it is fetched
  // from, and a site may well load it somewhere other than as a worker.
  if (typeof ServiceWorkerGlobalScope === 'undefined') return;
  if (!(self instanceof ServiceWorkerGlobalScope)) return;
  if (self.__napp) return;
  self.__napp = true;

  // The page the host loads to reach this worker. It has to come from here
  // when the site's own fetch handler would otherwise answer the navigation
  // with the site — and the site's handler runs first, because it was added
  // first. So respondWith is taught to ignore that one URL, and a listener
  // added after the site's answers it instead.
  var WAKE_PATH = '/.napp/wake';
  var WAKE_PAGE = %%NAPP_WAKE_PAGE%%;

  // The path a napp.fetch response is collected from, which needs the same
  // protection for a different reason: it is Tenna's, not the site's, and a
  // site whose fetch handler answers everything would hand its own window a
  // cached page where the response to an API call should be. A handler that
  // passes unknown requests through would be fine; one with an offline
  // fallback would not, and there is no telling which a given site wrote.
  var FETCH_PATH = '/.napp/fetch';

  /**
   * What proves to the host that a call on the paths below came from this
   * site's own worker.
   *
   * Stamped in when this script was served, which only happens for a fetch the
   * browser marked as a worker script fetch, and into a response only this
   * origin can read. Held in the closure so the site's own code — which runs
   * in this same worker — cannot read it off the global and hand it on. See
   * NappTokens.
   */
  var AUTH = %%NAPP_SITE_TOKEN%%;

  /** Where the host answers each thing a worker can do. See NsiteRequests. */
  var NOTIFICATION_PATH = '/.napp/notification';
  var NOTIFICATIONS_PATH = '/.napp/notifications';
  var CLOSE_PATH = '/.napp/close';
  var OPEN_PATH = '/.napp/open';
  var NOSTR_PATH = '/.napp/nostr';

  /** A URL is not a request body; anything longer than this is the site's bug. */
  var MAX_NOTIFICATION_BYTES = 64 * 1024;

  function pathOf(url) {
    try { return new URL(url).pathname; } catch (e) { return null; }
  }

  function isWake(url) {
    return pathOf(url) === WAKE_PATH;
  }

  /** Paths the site's own fetch handler does not get to answer. */
  function isReserved(url) {
    var path = pathOf(url);
    return path === WAKE_PATH || path === FETCH_PATH;
  }

  if (self.FetchEvent && FetchEvent.prototype.respondWith) {
    var respondWith = FetchEvent.prototype.respondWith;
    FetchEvent.prototype.respondWith = function (response) {
      if (isReserved(this.request.url)) return;
      return respondWith.call(this, response);
    };
    self.addEventListener('fetch', function (event) {
      // The wake page is answered from here; the fetch path is simply left
      // alone, so it falls through to the host that was going to serve it.
      if (!isWake(event.request.url)) return;
      respondWith.call(event, new Response(WAKE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      }));
    });
  }

  /** Ask the host something. Never throws; the caller decides what a failure means. */
  function host(path, query) {
    var url = path + '?a=' + encodeURIComponent(AUTH);
    for (var name in query) {
      if (!Object.prototype.hasOwnProperty.call(query, name)) continue;
      if (query[name] === undefined || query[name] === null) continue;
      url += '&' + name + '=' + encodeURIComponent(query[name]);
    }
    return fetch(url, { cache: 'no-store' });
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /**
   * A notification the host is currently showing.
   *
   * Read-only, as the real one is, apart from `close()` — which is the only
   * thing a site can do to a notification once it is up, and the reason the
   * host hands back the key it filed the notification under.
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
    // The host's own name for it. Not part of the API, so not enumerable —
    // a site round-tripping a notification through JSON shouldn't carry it.
    Object.defineProperty(this, '__key', { value: String(record.key || '') });
  }

  NappNotification.prototype.close = function () {
    if (!this.__key) return;
    host(CLOSE_PATH, { k: this.__key }).catch(function () {});
  };

  /** base64url, over UTF-8 rather than over whatever btoa makes of it. */
  function encode(text, limit) {
    var bytes = new TextEncoder().encode(text);
    if (bytes.length > limit) return null;
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var registration = self.ServiceWorkerRegistration && self.ServiceWorkerRegistration.prototype;
  if (registration) {
    registration.showNotification = function (title, options) {
      var payload;
      try {
        payload = encode(
          JSON.stringify({ title: String(title), options: options || {} }),
          MAX_NOTIFICATION_BYTES
        );
      } catch (err) {
        return Promise.reject(new TypeError('Notification options must be serializable'));
      }
      if (payload === null) {
        return Promise.reject(new TypeError('Notification is too large'));
      }
      // A GET, and not a POST: the host answers this from
      // `shouldInterceptRequest`, which is never given a request body.
      return host(NOTIFICATION_PATH, { p: payload }).then(function (res) {
        if (!res.ok) throw new Error('Notification refused');
      });
    };

    registration.getNotifications = function (filter) {
      var tag = filter && filter.tag ? String(filter.tag) : undefined;
      return host(NOTIFICATIONS_PATH, { tag: tag })
        .then(function (res) { return res.ok ? res.json() : []; })
        .then(function (records) {
          if (!Array.isArray(records)) return [];
          return records.map(function (record) { return new NappNotification(record); });
        })
        .catch(function () { return []; });
    };
  }

  if (self.Notification) {
    try {
      Object.defineProperty(self.Notification, 'permission', { get: function () { return 'granted'; } });
    } catch (err) {}
  }

  // -------------------------------------------------------------------------
  // self.nostr
  // -------------------------------------------------------------------------

  /*
   * The NIP-07 provider, for a worker.
   *
   * A site's window gets this injected as `window.nostr`; a worker has no
   * window to inject into, and is often the only thing running — which is
   * exactly when it is worth having, since a push about a message is not much
   * of a notification until somebody decrypts it.
   *
   * Every call is a same-origin request the host answers, like everything else
   * here, and the same token is what says it came from this site's worker. The
   * host decides nothing new: the grants are the ones the site's window was
   * given, read out of the store they were written to. See NsiteWorkerSigner.
   *
   * `self.nostr` being here says Tenna can answer, not that it will. Nobody
   * signed in, and a permission refused, both come back as a rejected promise
   * rather than as a missing object — the object is baked into this script
   * when the worker is installed, and who is signed in changes long
   * afterwards.
   */

  /** An argument longer than this is not one any honest call makes. */
  var MAX_NOSTR_BYTES = 512 * 1024;

  /** How long to keep asking about a call the user has not answered. */
  var APPROVAL_TIMEOUT_MS = 90 * 1000;

  /** How often to ask. */
  var POLL_INTERVAL_MS = 1000;

  /*
   * One call at a time.
   *
   * A call nobody has answered before puts a notification in front of the
   * user, and a worker looping over a conversation would otherwise put one
   * there per message. The window's provider serialises for the same reason;
   * see `nsiteNostrProvider.ts`.
   */
  var nostrQueue = Promise.resolve();

  function nostrAsk(query) {
    return host(NOSTR_PATH, query)
      .then(function (res) {
        if (!res.ok) throw new Error('Tenna could not answer');
        return res.json();
      })
      .then(function (body) {
        if (!body || typeof body !== 'object') throw new Error('Tenna could not answer');
        if (body.error) throw new Error(String(body.error));
        return body;
      });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /*
   * Ask until the user has answered, or until it is not worth asking.
   *
   * The host parks a call it cannot answer yet and says so, rather than
   * holding this request open — the thread it would hold is the one every
   * service worker in the app is served from, so waiting on a person there
   * stops every other site. See NsiteWorkerSigner.
   */
  function poll(id, deadline) {
    if (Date.now() >= deadline) {
      // Say so, so the notification comes down with the call it can no longer
      // answer. The host expires it on its own deadline either way, so this
      // is the tidy path rather than the necessary one — which is why its
      // failing changes nothing about what the site is told.
      var timedOut = function () { throw new Error('Timed out waiting for approval'); };
      return nostrAsk({ x: id }).then(timedOut, timedOut);
    }

    return sleep(POLL_INTERVAL_MS)
      .then(function () { return nostrAsk({ w: id }); })
      .then(function (body) {
        if (body.pending) return poll(id, deadline);
        if (body.result === undefined) throw new Error('Tenna could not answer');
        return body.result;
      });
  }

  function call(method, params) {
    var run = function () {
      var payload = encode(JSON.stringify(params || {}), MAX_NOSTR_BYTES);
      if (payload === null) {
        return Promise.reject(new TypeError('Arguments are too large'));
      }

      return nostrAsk({ m: method, p: payload }).then(function (body) {
        if (body.pending) return poll(body.pending, Date.now() + APPROVAL_TIMEOUT_MS);
        if (body.result === undefined) throw new Error('Tenna could not answer');
        return body.result;
      });
    };

    // Chained off the tail whatever happened to the one in front: a refusal
    // is an answer, and the next call is still owed its turn.
    var next = nostrQueue.then(run, run);
    nostrQueue = next.then(function () {}, function () {});
    return next;
  }

  self.nostr = {
    getPublicKey: function () {
      return call('getPublicKey', {});
    },

    signEvent: function (event) {
      return call('signEvent', { event: event });
    },

    // As in the window: Tenna publishes on the relays the user configured, and
    // a site asking which those are is asking the app rather than the key.
    getRelays: function () {
      return Promise.resolve({});
    },

    nip04: {
      encrypt: function (pubkey, plaintext) {
        return call('nip04.encrypt', { pubkey: pubkey, text: plaintext });
      },
      decrypt: function (pubkey, ciphertext) {
        return call('nip04.decrypt', { pubkey: pubkey, text: ciphertext });
      },
    },

    nip44: {
      encrypt: function (pubkey, plaintext) {
        return call('nip44.encrypt', { pubkey: pubkey, text: plaintext });
      },
      decrypt: function (pubkey, ciphertext) {
        return call('nip44.decrypt', { pubkey: pubkey, text: ciphertext });
      },
    },
  };

  // -------------------------------------------------------------------------
  // self.napp.fetch
  // -------------------------------------------------------------------------

  /*
   * An HTTP request made on the site's behalf, without CORS.
   *
   * The same API the site's window has as `window.napp.fetch`, with one
   * ceiling the window does not share. A window stages its request over the
   * message channel and its body crosses as raw bytes; a worker has no
   * channel — the case worth having this for is the one with no window open
   * at all — so the whole request, body included, is written into the URL.
   *
   * That is the same shape `self.nostr` uses and for the same reason, and it
   * is why a worker's body is capped at 32 KB while a window's is capped at
   * sixteen megabytes. A worker with a large upload to make should wake its
   * window and let it do it.
   *
   * A request made from in here does not go through this worker's own `fetch`
   * handler — a worker's own fetches never do — so unlike the window's, this
   * one needs no protecting from the site's router.
   */

  /** A body longer than this has nowhere to go. Matches NappFetchPolicy. */
  var MAX_FETCH_BODY_BYTES = 32 * 1024;

  /** And the whole request, once it has been written out as a URL. */
  var MAX_FETCH_BYTES = 96 * 1024;

  /** Set when the failure is Tenna's answer rather than a server's. */
  var FETCH_ERROR_HEADER = 'X-Napp-Error';

  function abortError() {
    try {
      return new DOMException('The user aborted a request.', 'AbortError');
    } catch (e) {
      var err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      return err;
    }
  }

  /** base64url over bytes, where `encode` does it over text. */
  function encodeBytes(bytes, limit) {
    if (bytes.length > limit) return null;
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function nappFetch(input, init) {
    var request;
    try {
      request = new Request(input, init);
    } catch (e) {
      return Promise.reject(e);
    }

    var signal = request.signal;
    if (signal && signal.aborted) return Promise.reject(abortError());

    var headers = [];
    request.headers.forEach(function (value, name) { headers.push([name, value]); });

    return request
      .arrayBuffer()
      .then(function (buffer) {
        var body = '';

        if (buffer.byteLength > 0) {
          body = encodeBytes(new Uint8Array(buffer), MAX_FETCH_BODY_BYTES);
          if (body === null) {
            throw new TypeError('A worker cannot send a body this large');
          }
        }

        var payload = encode(JSON.stringify({
          url: request.url,
          method: request.method,
          headers: headers,
          redirect: request.redirect,
          body: body,
        }), MAX_FETCH_BYTES);

        if (payload === null) throw new TypeError('The request is too large');

        return fetch(
          FETCH_PATH + '?a=' + encodeURIComponent(AUTH) + '&r=' + payload,
          { cache: 'no-store', signal: signal }
        );
      })
      .then(function (response) {
        // What a browser would have rejected with rather than resolved: a
        // refused address, a host that does not answer, a timeout.
        var failure = response.headers.get(FETCH_ERROR_HEADER);
        if (failure) throw new TypeError(failure);
        return response;
      });
  }

  self.napp = Object.freeze({ fetch: nappFetch });

  // -------------------------------------------------------------------------
  // Windows
  // -------------------------------------------------------------------------

  /*
   * Neither of these works in a WebView on its own: a worker has no way to
   * make a browsing context, and focusing one is the window manager's act
   * rather than the web's. Both come back out to the host, which starts the
   * same activity a tap on a notification does — so a site that routes in its
   * `notificationclick` handler, as a site written for a browser does, moves
   * the window Tenna has already opened rather than being ignored.
   */

  /** Open the site's window, at `path` or wherever it already is. */
  function openSite(path) {
    return host(OPEN_PATH, { u: path })
      .then(function () { return null; })
      .catch(function () { return null; });
  }

  function openWindow(url) {
    var path;
    try {
      var resolved = new URL(url, self.location.origin);
      path = resolved.origin === self.location.origin
        ? resolved.pathname + resolved.search + resolved.hash
        : null;
    } catch (e) {
      path = null;
    }
    // A site can only open itself, as it can only notify as itself.
    if (path === null) return Promise.resolve(null);
    return openSite(path);
  }

  if (self.Clients && self.Clients.prototype) {
    self.Clients.prototype.openWindow = function (url) { return openWindow(url); };
  } else if (self.clients) {
    self.clients.openWindow = function (url) { return openWindow(url); };
  }

  if (self.WindowClient && WindowClient.prototype) {
    // Bringing the window forward, and nothing else — a path would navigate
    // it, and focusing is not navigating.
    WindowClient.prototype.focus = function () {
      var client = this;
      return openSite(undefined).then(function () { return client; });
    };
  }

  /*
   * The wake page is Tenna's, not the site's.
   *
   * It is a real document at the site's origin — it has to be, or it could not
   * reach the worker at all — which makes it a client like any other. A site
   * looping over `matchAll()` to find its window would sooner or later find
   * this one instead, navigate it, and wonder why nothing moved. So it is not
   * offered.
   */
  if (self.Clients && Clients.prototype && Clients.prototype.matchAll) {
    var matchAll = Clients.prototype.matchAll;
    Clients.prototype.matchAll = function (options) {
      return matchAll.call(this, options).then(function (found) {
        return found.filter(function (client) { return !isWake(client.url); });
      });
    };
  }

  // -------------------------------------------------------------------------
  // Events from the host
  // -------------------------------------------------------------------------

  function PushData(text) { this._text = text; }
  PushData.prototype.text = function () { return this._text; };
  PushData.prototype.json = function () { return JSON.parse(this._text); };
  PushData.prototype.arrayBuffer = function () { return new TextEncoder().encode(this._text).buffer; };
  PushData.prototype.blob = function () { return new Blob([this._text]); };

  function reply(source, message) {
    if (source && typeof source.postMessage === 'function') {
      try { source.postMessage(message); } catch (e) {}
    }
  }

  /**
   * The event the host asked for, built by hand.
   *
   * A script-constructed ExtendableEvent refuses waitUntil, so the promises
   * are collected here and the host is told when the last one settles.
   */
  function raise(kind, data, promises) {
    var event = new Event(kind, { cancelable: true });
    var properties = {
      waitUntil: { value: function (p) { promises.push(Promise.resolve(p)); } },
    };

    if (kind === 'push') {
      properties.data = { value: new PushData(String(data)) };
    } else {
      var payload;
      try {
        payload = JSON.parse(String(data));
      } catch (e) {
        return null;
      }
      properties.notification = { value: new NappNotification(payload) };
      properties.action = { value: String(payload.action || '') };
      // What was typed into a `type: "text"` action, as the Notifications API
      // spells it. Undefined for every other kind of press.
      properties.reply = { value: payload.reply == null ? undefined : String(payload.reply) };
    }

    Object.defineProperties(event, properties);
    return event;
  }

  var KINDS = { push: true, notificationclick: true, notificationclose: true };

  self.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || !KINDS[m.__napp]) return;

    var promises = [];
    var event = raise(m.__napp, m.data, promises);

    if (event) {
      try { self.dispatchEvent(event); } catch (err) {}
    }

    Promise.allSettled(promises).then(function () {
      reply(e.source, { __napp: 'done', id: m.id });
    });
  });
})();
