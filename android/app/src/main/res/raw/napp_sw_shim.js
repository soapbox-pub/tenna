/*
 * Tenna's push shim, appended to every service worker script an nsite
 * registers on Android.
 *
 * Android's WebView has no Push API and no Web Notifications, so both are
 * stood in for here. A push is delivered as a `message` from a document Tenna
 * opens at the site's origin, and re-raised as a `push` event that looks the
 * way one does anywhere else: `event.data.json()` and `event.waitUntil()`
 * both work. `showNotification` is sent to the host as a same-origin request,
 * which the host answers by posting an OS notification.
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

  /** Where a notification is sent. See NsiteRequests. */
  var NOTIFICATION_PATH = '/.napp/notification';

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

  self.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object' || m.__napp !== 'push') return;

    // A script-constructed ExtendableEvent refuses waitUntil, so the promises
    // are collected by hand and the host is told when the last one settles.
    var promises = [];
    var event = new Event('push', { cancelable: true });
    Object.defineProperties(event, {
      data: { value: new PushData(String(m.data)) },
      waitUntil: { value: function (p) { promises.push(Promise.resolve(p)); } },
    });

    try { self.dispatchEvent(event); } catch (err) {}

    Promise.allSettled(promises).then(function () {
      reply(e.source, { __napp: 'done', id: m.id });
    });
  });

  /** base64url, over UTF-8 rather than over whatever btoa makes of it. */
  function encode(text) {
    var bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_NOTIFICATION_BYTES) return null;
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var proto = self.ServiceWorkerRegistration && self.ServiceWorkerRegistration.prototype;
  if (proto) {
    proto.showNotification = function (title, options) {
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
    proto.getNotifications = function () { return Promise.resolve([]); };
  }

  if (self.Notification) {
    try {
      Object.defineProperty(self.Notification, 'permission', { get: function () { return 'granted'; } });
    } catch (err) {}
  }
})();
