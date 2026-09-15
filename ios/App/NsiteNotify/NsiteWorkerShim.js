'use strict';
/*
 * What an nsite's service worker runs inside of, on iOS.
 *
 * The counterpart of `napp_sw_shim.js` on Android, and it stands in for more:
 * there the script really is a service worker and only the Push API and Web
 * Notifications are missing, while here the script is a dedicated worker and
 * `registration`, `clients` and the whole event vocabulary have to be built.
 * See `NsiteOrigins.swift` for why there is no real one to have.
 *
 * Everything the worker wants from outside goes to the host page by
 * `postMessage`, which relays it to the extension. Android's shim reaches the
 * host with same-origin `fetch` instead, which is not open here: a worker's
 * fetches belong to no WebView, so no `WKURLSchemeHandler` ever sees them.
 *
 * Loaded before the site's script rather than after it — the site reads
 * `self.registration` at the top of its own file — which is why the two are
 * separate scripts joined by `importScripts` rather than one concatenation.
 * A `'use strict'` prologue is only a prologue at the top of a script.
 */
(function() {
  var ENVELOPE = '__tenna';

  function tell(message) {
    message[ENVELOPE] = message.kind;
    delete message.kind;
    self.postMessage(message);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * `showNotification`, which is the entire point of this file.
   *
   * Resolves as soon as the host has been told, rather than when anything is
   * on screen: the extension collects these and hands one back to iOS when the
   * worker is done, so there is nothing to wait for and a worker that awaited
   * a real answer would spend its thirty seconds waiting for itself.
   */
  function showNotification(title, options) {
    var payload;
    try {
      // Round-tripped so that what the host receives is what a structured
      // clone would carry, and a site handing over something exotic — a
      // function, a cycle — is told here rather than failing in the relay.
      payload = JSON.parse(JSON.stringify(options || {}));
    } catch (err) {
      return Promise.reject(new TypeError('Notification options must be serializable'));
    }
    tell({ kind: 'notification', title: String(title), options: payload });
    return Promise.resolve();
  }

  var listeners = {};

  self.registration = {
    scope: new URL('./', self.location.href).href,
    updateViaCache: 'imports',
    installing: null,
    waiting: null,
    active: null,
    showNotification: showNotification,
    // Nothing is on screen yet, so there is nothing to read back. Android
    // answers this out of the shade; here the shade has not been written to.
    getNotifications: function() { return Promise.resolve([]); },
    update: function() { return Promise.resolve(); },
    unregister: function() { return Promise.resolve(true); },
    addEventListener: function(type, listener) {
      (listeners[type] = listeners[type] || []).push(listener);
    },
    removeEventListener: function(type, listener) {
      var list = listeners[type] || [];
      var index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent: function() { return true; }
  };

  self.clients = {
    get: function() { return Promise.resolve(undefined); },
    // There is no window. Saying so is better than inventing one for a site
    // to try to focus or navigate.
    matchAll: function() { return Promise.resolve([]); },
    claim: function() { return Promise.resolve(); },
    openWindow: function() { return Promise.resolve(null); }
  };

  self.skipWaiting = function() { return Promise.resolve(); };

  if (!self.Notification) {
    self.Notification = { permission: 'granted' };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function PushData(text) { this._text = text; }
  PushData.prototype.text = function() { return this._text; };
  PushData.prototype.json = function() { return JSON.parse(this._text); };
  PushData.prototype.arrayBuffer = function() { return new TextEncoder().encode(this._text).buffer; };
  PushData.prototype.blob = function() { return new Blob([this._text]); };

  /**
   * The event, built by hand.
   *
   * A script-constructed `ExtendableEvent` refuses `waitUntil`, so the
   * promises are collected here and the caller waits on them — the same trick,
   * for the same reason, as on Android.
   */
  function raise(kind, data, promises) {
    var event = new Event(kind, { cancelable: true });
    var properties = {
      waitUntil: { value: function(p) { promises.push(Promise.resolve(p)); } }
    };

    if (kind === 'push') {
      properties.data = { value: new PushData(String(data)) };
    } else if (kind === 'notificationclick' || kind === 'notificationclose') {
      var payload;
      try {
        payload = JSON.parse(String(data));
      } catch (err) {
        return null;
      }
      properties.notification = { value: payload };
      properties.action = { value: String(payload.action || '') };
      properties.reply = { value: payload.reply == null ? undefined : String(payload.reply) };
    }

    Object.defineProperties(event, properties);
    return event;
  }

  /** Dispatch, and settle when every `waitUntil` has. */
  function dispatch(kind, data) {
    var promises = [];
    var event = raise(kind, data, promises);
    if (!event) return Promise.resolve();

    try {
      self.dispatchEvent(event);
    } catch (err) {
      setTimeout(function() { throw err; }, 0);
    }

    // `self.onpush = ...` and the rest. A dedicated worker's global has no
    // setter for these, so an assignment leaves a plain property that
    // `dispatchEvent` knows nothing about.
    var handler = self['on' + kind];
    if (typeof handler === 'function') {
      try {
        handler.call(self, event);
      } catch (err) {
        setTimeout(function() { throw err; }, 0);
      }
    }

    return Promise.allSettled(promises);
  }

  var KINDS = { push: true, notificationclick: true, notificationclose: true };

  self.addEventListener('message', function(event) {
    var message = event.data;
    if (!message || typeof message !== 'object' || !KINDS[message[ENVELOPE]]) return;

    dispatch(message[ENVELOPE], message.data).then(function() {
      tell({ kind: 'done', id: message.id });
    });
  });

  /**
   * Run the site's lifecycle, then say the worker is ready for a push.
   *
   * Called from the tail of the generated script, after `importScripts` has
   * run the site's own file, so that everything above is in place before the
   * site's top-level code reads any of it — and so that nothing is delivered
   * until a listener added in `activate` would have been added.
   */
  self.__tennaWorker = {
    boot: function() {
      dispatch('install')
        .then(function() {
          self.registration.waiting = null;
          return dispatch('activate');
        })
        .then(function() {
          tell({ kind: 'ready' });
        });
    }
  };
})();
