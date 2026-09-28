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
 * Everything the worker wants from Tenna goes to the host page by
 * `postMessage`, which relays it to the native side. Most of it is said and
 * not answered — a notification to show, a lifecycle step — but a question
 * such as `getNotifications()` is a `call`, which the page relays to a handler
 * that replies, and the reply comes back to `answered` below. Android's shim
 * does the same over a `MessagePort`. A dedicated worker's fetches do reach
 * the host page's `WKURLSchemeHandler` — that is how the site's own files are
 * served to it — but only as requests for the site's paths, where there is no
 * room for Tenna's own traffic.
 *
 * Loaded before the site's script rather than after it — the site reads
 * `self.registration` at the top of its own file — which is why the two are
 * separate scripts, joined by `importScripts` or by `import` for a site that
 * registered a module, rather than one concatenation. A `'use strict'`
 * prologue is only a prologue at the top of a script. This file is written to
 * mean the same thing as either: it declares nothing at its top level and
 * reaches everything through `self`.
 */
(function() {
  var ENVELOPE = '__tenna';

  function tell(message) {
    message[ENVELOPE] = message.kind;
    delete message.kind;
    self.postMessage(message);
  }

  var calls = {};
  var nextCall = 1;

  /** Ask the host something, and have the answer. */
  function call(method, params) {
    return new Promise(function(resolve, reject) {
      var id = nextCall++;
      calls[id] = { resolve: resolve, reject: reject };
      tell({ kind: 'call', id: id, method: method, params: params || {} });
    });
  }

  /** The page relaying the host's answer to a `call`. */
  function answered(message) {
    var pending = calls[message.__tennaReply];
    if (!pending) return;
    delete calls[message.__tennaReply];
    if (message.error != null) {
      pending.reject(new Error(String(message.error)));
    } else {
      pending.resolve(message.value);
    }
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

  /**
   * A notification the host is showing, as `event.notification`.
   *
   * The same object Android's shim hands over — see `NappNotification` in
   * `napp_sw_shim.js`, which this is a copy of, transport aside. The wire
   * record the host sends is Tenna's own shape; what a site gets is the one
   * the Notifications API describes, with the options flattened onto it and
   * the host's key hidden, so a site round-tripping a notification through
   * JSON does not carry Tenna's internals with it.
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
    Object.defineProperty(this, '__key', { value: String(record.key || '') });
  }

  NappNotification.prototype.close = function() {
    if (!this.__key) return;
    call('close', { key: this.__key }).catch(function() {});
  };

  /**
   * The site's notifications in the shade, including the ones pushes put
   * there — which is what a worker reading back its own conversation before
   * it adds to it wants to see.
   */
  function getNotifications(filter) {
    var tag = filter && filter.tag != null ? String(filter.tag) : null;
    return call('list', { tag: tag }).then(function(text) {
      var records = JSON.parse(String(text || '[]'));
      return records.map(function(record) { return new NappNotification(record); });
    });
  }

  var listeners = {};

  self.registration = {
    scope: new URL('./', self.location.href).href,
    updateViaCache: 'imports',
    installing: null,
    waiting: null,
    active: null,
    showNotification: showNotification,
    getNotifications: getNotifications,
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

  /*
   * `registration.periodicSync`, from inside the worker.
   *
   * The permission is asked for in the site's window, so a worker may only
   * change a tag it already holds — re-registering from its own `periodicsync`
   * handler, which is common, or giving one up — as on Android. `getTags()`
   * falls back to the tags the host stamped in when it served this script.
   */
  // Stamped in by `NsiteWorkerHost` when it serves this file.
  var periodicTags = %%PERIODIC_TAGS%%;

  self.registration.periodicSync = {
    register: function(tag, options) {
      var minInterval = options && typeof options.minInterval === 'number' ? options.minInterval : 0;
      return call('periodicRegister', { tag: String(tag), minInterval: minInterval }).then(function() {});
    },
    unregister: function(tag) {
      return call('periodicUnregister', { tag: String(tag) }).then(function() {});
    },
    getTags: function() {
      return call('periodicTags').then(
        function(tags) { return Array.isArray(tags) ? tags : periodicTags.slice(); },
        function() { return periodicTags.slice(); });
    }
  };

  /**
   * `clients.openWindow`, for a worker answering a tap.
   *
   * A site can open only itself, and only in answer to the user tapping one of
   * its notifications; anything else resolves null, as a browser's does when
   * it refuses. The host decides which it is.
   */
  function openWindow(url) {
    var path;
    try {
      var resolved = new URL(url, self.location.href);
      path = resolved.origin === self.location.origin
        ? resolved.pathname + resolved.search + resolved.hash
        : null;
    } catch (err) {
      path = null;
    }
    if (path === null) return Promise.resolve(null);
    return call('open', { path: path }).then(function() { return null; }, function() { return null; });
  }

  self.clients = {
    get: function() { return Promise.resolve(undefined); },
    // There is no window to hand over. The one a tap opens is Tenna's to
    // move, which `openWindow` asks for.
    matchAll: function() { return Promise.resolve([]); },
    claim: function() { return Promise.resolve(); },
    openWindow: openWindow
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
    } else if (kind === 'periodicsync') {
      properties.tag = { value: String(data) };
    } else if (kind === 'notificationclick' || kind === 'notificationclose') {
      var payload;
      try {
        payload = JSON.parse(String(data));
      } catch (err) {
        return null;
      }
      properties.notification = { value: new NappNotification(payload) };
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

  var KINDS = { push: true, notificationclick: true, notificationclose: true, periodicsync: true };

  self.addEventListener('message', function(event) {
    var message = event.data;
    if (message && typeof message === 'object' && message.__tennaReply != null) {
      // Tenna's traffic, not the site's: registered before the site's script
      // ran, so this listener is first and the site's never sees it.
      event.stopImmediatePropagation();
      answered(message);
      return;
    }
    if (!message || typeof message !== 'object' || !KINDS[message[ENVELOPE]]) return;
    event.stopImmediatePropagation();

    dispatch(message[ENVELOPE], message.data).then(function() {
      tell({ kind: 'done', id: message.id });
    });
  });

  /**
   * Run the site's lifecycle, then say the worker is ready for a push.
   *
   * Called from the tail of the generated script, after the site's own file
   * has run, so that everything above is in place before the
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
