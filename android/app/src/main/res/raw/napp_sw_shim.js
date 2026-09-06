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

  /** Where the host answers each thing a worker can do. See NsiteRequests. */
  var NOTIFICATION_PATH = '/.napp/notification';
  var NOTIFICATIONS_PATH = '/.napp/notifications';
  var CLOSE_PATH = '/.napp/close';
  var OPEN_PATH = '/.napp/open';

  /** A URL is not a request body; anything longer than this is the site's bug. */
  var MAX_NOTIFICATION_BYTES = 64 * 1024;

  function isWake(url) {
    try { return new URL(url).pathname === WAKE_PATH; } catch (e) { return false; }
  }

  if (self.FetchEvent && FetchEvent.prototype.respondWith) {
    var respondWith = FetchEvent.prototype.respondWith;
    FetchEvent.prototype.respondWith = function (response) {
      if (isWake(this.request.url)) return;
      return respondWith.call(this, response);
    };
    self.addEventListener('fetch', function (event) {
      if (!isWake(event.request.url)) return;
      respondWith.call(event, new Response(WAKE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      }));
    });
  }

  /** Ask the host something. Never throws; the caller decides what a failure means. */
  function host(path, query) {
    var url = path;
    var first = true;
    for (var name in query) {
      if (!Object.prototype.hasOwnProperty.call(query, name)) continue;
      if (query[name] === undefined || query[name] === null) continue;
      url += (first ? '?' : '&') + name + '=' + encodeURIComponent(query[name]);
      first = false;
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
  function encode(text) {
    var bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_NOTIFICATION_BYTES) return null;
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var registration = self.ServiceWorkerRegistration && self.ServiceWorkerRegistration.prototype;
  if (registration) {
    registration.showNotification = function (title, options) {
      var payload;
      try {
        payload = encode(JSON.stringify({ title: String(title), options: options || {} }));
      } catch (err) {
        return Promise.reject(new TypeError('Notification options must be serializable'));
      }
      if (payload === null) {
        return Promise.reject(new TypeError('Notification is too large'));
      }
      // A GET, and not a POST: the host answers this from
      // `shouldInterceptRequest`, which is never given a request body.
      return fetch(NOTIFICATION_PATH + '?p=' + payload, { cache: 'no-store' }).then(function (res) {
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
