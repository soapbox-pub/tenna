/*
 * Tenna's shim, appended to every service worker script an nsite registers on
 * Android.
 *
 * Android's WebView has no Push API and no Web Notifications, so both are
 * stood in for here. An event is delivered as a `message` from a document
 * Tenna opens at the site's origin, and re-raised as the event it really is —
 * a `push`, the `notificationclick` the user just caused, or a scheduled
 * `periodicsync` — looking the way
 * one does anywhere else: `event.data.json()`, `event.waitUntil()`,
 * `event.notification.close()` and `event.reply` all work.
 *
 * Everything that reaches outside the worker — showing a notification, reading
 * the tray back, making an HTTP request — is a message on a `MessagePort` the
 * host handed over. That port arrives with the very same `message` the event
 * does, so by the time a site's `push` handler runs there is already somewhere
 * to ask.
 *
 * It used to be a same-origin `fetch` instead, answered from
 * `shouldInterceptRequest`, with the payload written out as base64 in the
 * query string. That road is worth remembering because every awkward thing
 * about it came from one fact: interception is never given a request body. So
 * a worker could only ever ask, never say; anything it wanted to hand over had
 * to fit in a URL or be cut into several; and nothing it asked could be waited
 * on for long, because the thread belonged to Chromium and was shared by every
 * worker in the app. A port has none of that. See NappPort.
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
  //
  // The last thing about this shim that is a URL at all, and for a reason no
  // port can help with: nothing native can start a service worker, only a
  // document at its origin can, and a document has to be navigated to.
  var WAKE_PATH = '/.napp/wake';
  var WAKE_PAGE = %%NAPP_WAKE_PAGE%%;

  /** Whether bytes may cross as bytes. A fact about the installed WebView. */
  var BINARY = %%NAPP_BINARY%%;

  /**
   * What proves to the host that the port reached this worker.
   *
   * Stamped in when this script was served, which only happens for a fetch the
   * browser marked as a worker script fetch, and into a response only this
   * origin can read. Held in the closure so the site's own code — which runs
   * in this same worker — cannot read it off the global and hand it on.
   *
   * A port travels through a document, and a document at this origin is
   * running the site's own code: it could keep the port rather than pass it
   * on. That is worth stopping, because a page's notifications go through
   * Tenna's permission prompt and a worker's do not. See NappTokens.
   */
  var AUTH = %%NAPP_SITE_TOKEN%%;

  function pathOf(url) {
    try { return new URL(url).pathname; } catch (e) { return null; }
  }

  function isWake(url) {
    return pathOf(url) === WAKE_PATH;
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

  // -------------------------------------------------------------------------
  // The port
  // -------------------------------------------------------------------------

  /*
   * One channel to the host, and one call/reply protocol on it.
   *
   * A call is `{id, m, p}` and is answered exactly once with `{id, ok}` or
   * `{id, err}`. A fetch is answered with `{id, head}`, then the body as
   * frames, then `{id, end}`. Bytes travel as framed array buffers — four
   * big-endian bytes of header length, that many bytes of JSON, then the
   * payload — so a frame names the call it belongs to and needs no channel of
   * its own.
   *
   * **The port does not outlive the worker.** Chromium stops an idle one after
   * about thirty seconds, and the next start gets a fresh global with nothing
   * in it — so a port is handed over per worker start rather than once, and
   * the first thing this does is wait for one. It does outlive the *document*
   * that handed it over, which is what makes it usable for a push: the wake
   * page is torn down long before a site's handler has finished.
   *
   * Nor does traffic on it keep a worker alive. A port message is not an event
   * and does not touch the idle timer, so a site with something long to do
   * still has to hold the event open with `waitUntil`, exactly as it would
   * anywhere else — and that is passed through to the `message` the event
   * arrived as, which is the one Chromium is counting.
   */

  /** How long a call waits for a port before giving up on there being one. */
  var PORT_TIMEOUT_MS = 20000;

  /** How much of a body goes in one frame. Matches NappFetchPolicy. */
  var CHUNK_BYTES = 512 * 1024;

  /** How many frames either end may have unacknowledged. Matches it too. */
  var CREDIT = 2;

  /** The largest body this can send. Policy rather than transport. */
  var MAX_BODY_BYTES = 16 * 1024 * 1024;

  var port = null;
  var calls = {};
  var nextId = 1;

  /** Calls made before a port arrived, run in order once one does. */
  var queued = [];

  function adopt(taken) {
    if (!taken) return;
    port = taken;
    taken.onmessage = received;
    if (taken.start) taken.start();

    // Before anything else, and before anything queued: the host answers
    // nothing until it has this, and messages arrive in the order they were
    // sent, so being first is the whole of the protocol.
    post({ m: 'hello', p: { a: AUTH } });

    var waiting = queued;
    queued = [];
    for (var i = 0; i < waiting.length; i++) waiting[i]();
  }

  /** Where a worker with no port rings for one. See NappPort. */
  var PORT_PATH = '/.napp/port';

  /**
   * Ring for a port, which is the one thing that cannot be asked for over one.
   *
   * A bodiless GET carrying nothing, which the host answers by telling one of
   * the site's windows to carry a port across — a port can only be transferred
   * by a frame, and nothing native can reach into a worker.
   *
   * It is not `client.postMessage`, which would be the obvious way to reach a
   * window, because a page does not receive those until something has started
   * its message queue. Starting it on the site's behalf would deliver whatever
   * the site had queued for a listener it has not added yet, which is a change
   * to how the site's own code behaves and no business of Tenna's.
   */
  function ring() {
    fetch(PORT_PATH, { cache: 'no-store' }).catch(function () {});
  }

  /**
   * Run something once there is a port, or tell it there will not be one.
   *
   * A worker nearly always has one already: it was handed over with the event
   * that started this, or by the site's own window at document start. The wait
   * is for the gap — a worker that came up to answer a navigation, whose
   * document has not run its own first line yet.
   */
  function whenReady(run) {
    if (port) { run(true); return; }

    ring();
    var done = false;
    queued.push(function () {
      if (done) return;
      done = true;
      run(true);
    });
    setTimeout(function () {
      if (done) return;
      done = true;
      run(false);
    }, PORT_TIMEOUT_MS);
  }

  /*
   * Say something to the host.
   *
   * **Text, or an ArrayBuffer, and nothing else.** The far end of this port is
   * not another bit of script but a native `WebMessagePort`, which carries
   * those two things and no more: an object handed to one is dropped, without
   * an exception here and without a trace there. So everything structured goes
   * as JSON, and the only thing that crosses as itself is a body chunk.
   */
  function post(message, transfer) {
    if (!port) return false;
    try {
      port.postMessage(
        typeof message === 'string' || message instanceof ArrayBuffer
          ? message
          : JSON.stringify(message),
        transfer || []
      );
      return true;
    } catch (e) {
      // A port whose host has gone. Nothing says so in advance.
      return false;
    }
  }

  /** Ask the host for something, and settle when it answers. */
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      calls[id] = { resolve: resolve, reject: reject };

      whenReady(function (ready) {
        if (!calls[id]) return;
        if (!ready || !post({ id: id, m: method, p: params || {} })) {
          delete calls[id];
          reject(new Error('Tenna is not listening'));
        }
      });
    });
  }

  // ── Frames ────────────────────────────────────────────────────────────────

  function encodeBytes(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeBytes(text) {
    var binary = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** One chunk of a request body, transferred rather than copied. */
  function frame(id, sequence, bytes) {
    if (!BINARY) return post({ id: id, i: sequence, b: encodeBytes(bytes) });

    var header = new TextEncoder().encode(JSON.stringify({ id: id, i: sequence }));
    var buffer = new ArrayBuffer(4 + header.length + bytes.length);
    var out = new Uint8Array(buffer);

    new DataView(buffer).setUint32(0, header.length);
    out.set(header, 4);
    out.set(bytes, 4 + header.length);

    return post(buffer, [buffer]);
  }

  function received(event) {
    var data = event.data;

    if (data instanceof ArrayBuffer) {
      if (data.byteLength < 4) return;
      var length = new DataView(data).getUint32(0);
      if (4 + length > data.byteLength) return;

      var header;
      try {
        header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, length)));
      } catch (e) {
        return;
      }
      chunk(header.id, header.i, new Uint8Array(data, 4 + length));
      return;
    }

    // Text, for the same reason everything but a body chunk is sent as text:
    // a native port carries a string or an ArrayBuffer and nothing else.
    if (typeof data !== 'string') return;
    try {
      data = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    var record = calls[data.id];
    if (!record) return;

    // A frame the long way round, on a WebView with no array buffers.
    if (data.b !== undefined) {
      chunk(data.id, data.i, decodeBytes(data.b));
      return;
    }

    if (data.head !== undefined) {
      if (record.head) record.head(data.head);
      return;
    }

    if (data.ack !== undefined) {
      if (record.ack) record.ack(data.ack);
      return;
    }

    if (data.end) {
      delete calls[data.id];
      if (record.end) record.end(data.err || null);
      else if (data.err) record.reject(new TypeError(data.err));
      else record.resolve(null);
      return;
    }

    delete calls[data.id];
    if (data.err !== undefined) record.reject(new TypeError(String(data.err)));
    else record.resolve(data.ok === undefined ? null : data.ok);
  }

  function chunk(id, sequence, bytes) {
    var record = calls[id];
    if (!record || !record.chunk) return;
    record.chunk(sequence, bytes);
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
    call('close', { key: this.__key }).catch(function () {});
  };

  var registration = self.ServiceWorkerRegistration && self.ServiceWorkerRegistration.prototype;
  if (registration) {
    /*
     * There is no ceiling on this any more.
     *
     * It used to be sixty-four kilobytes, because the whole notification went
     * into the query string of a GET — the host answered it from
     * `shouldInterceptRequest`, which is never given a request body. A message
     * is a message, so what a site may say is now whatever it can structure.
     */
    registration.showNotification = function (title, options) {
      var payload;
      try {
        // Round-tripped so that a site handing over something exotic — a
        // function, a cycle — is told here rather than failing in the host.
        payload = JSON.parse(JSON.stringify(options || {}));
      } catch (err) {
        return Promise.reject(new TypeError('Notification options must be serializable'));
      }
      return call('notification', { title: String(title), options: payload })
        .then(function () {});
    };

    registration.getNotifications = function (filter) {
      var tag = filter && filter.tag ? String(filter.tag) : null;
      return call('notifications', { tag: tag })
        .then(function (records) {
          if (!Array.isArray(records)) return [];
          return records.map(function (record) { return new NappNotification(record); });
        })
        .catch(function () { return []; });
    };
  }

  // -------------------------------------------------------------------------
  // Periodic background sync
  // -------------------------------------------------------------------------

  /*
   * `registration.periodicSync`, which this WebView does not have.
   *
   * The same manager the site's window gets — see `PERIODIC_SYNC_SOURCE` in
   * nsiteNostrProvider.ts — answered over the port rather than the window's
   * bridge. Registering from here asks nobody, since there is nobody to ask,
   * so the host allows it only for a site that already holds a tag. See
   * NappPort.
   */
  function PeriodicSyncManager() {
    throw new TypeError("Failed to construct 'PeriodicSyncManager': Illegal constructor");
  }

  PeriodicSyncManager.prototype.register = function (tag, options) {
    var minInterval = options && options.minInterval != null ? Number(options.minInterval) : 0;
    if (!isFinite(minInterval) || minInterval < 0) minInterval = 0;
    return call('periodicsync', { op: 'register', tag: String(tag), minInterval: minInterval })
      .then(function () {}, function (err) {
        if (!/denied/i.test(String(err && err.message))) throw err;
        throw new DOMException('Permission denied.', 'NotAllowedError');
      });
  };

  PeriodicSyncManager.prototype.unregister = function (tag) {
    return call('periodicsync', { op: 'unregister', tag: String(tag) }).then(function () {});
  };

  PeriodicSyncManager.prototype.getTags = function () {
    return call('periodicsync', { op: 'tags' }).then(function (tags) {
      return Array.isArray(tags) ? tags.map(String) : [];
    });
  };

  var periodicSyncManager = Object.create(PeriodicSyncManager.prototype);
  self.PeriodicSyncManager = PeriodicSyncManager;

  if (registration) {
    try {
      Object.defineProperty(registration, 'periodicSync', {
        configurable: true,
        get: function () { return periodicSyncManager; },
      });
    } catch (err) {}
  }

  if (self.Notification) {
    try {
      Object.defineProperty(self.Notification, 'permission', { get: function () { return 'granted'; } });
    } catch (err) {}
  }

  // -------------------------------------------------------------------------
  // self.napp.fetch
  // -------------------------------------------------------------------------

  /*
   * An HTTP request made on the site's behalf, without CORS.
   *
   * The same API the site's window has as `window.napp.fetch`, and now by much
   * the same road: one message describing the request, the body after it as
   * frames, and the response coming back the same way — headers as a message,
   * then bytes, so the site can read them as they arrive rather than when they
   * are all in.
   *
   * Both directions are acknowledged, because a port has no backpressure of
   * its own: `postMessage` always succeeds and the far end's queue simply
   * grows. Neither end sends more than CREDIT frames without hearing back, so
   * a sixteen-megabyte upload costs about a megabyte and a half on each side
   * rather than sixteen.
   *
   * A request made from in here does not go through this worker's own `fetch`
   * handler — a worker's own fetches never do, and this is not a fetch at all
   * — so unlike the window's, this one needs no protecting from the site's
   * router.
   */

  /** Statuses the Fetch standard says carry no body. */
  var NO_BODY = { 101: true, 103: true, 204: true, 205: true, 304: true };

  function abortError() {
    try {
      return new DOMException('The user aborted a request.', 'AbortError');
    } catch (e) {
      var err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      return err;
    }
  }

  function run(request, headers, blob) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var signal = request.signal;

      var controller = null;
      var opened = false;
      var closed = false;

      // Credit for the request body: a chunk may go out when the host says
      // the one before last is on the socket.
      var credit = CREDIT;
      var waiters = [];

      function grant() {
        credit++;
        var waiter = waiters.shift();
        if (waiter) waiter();
      }

      function spend() {
        if (credit > 0) { credit--; return Promise.resolve(); }
        return new Promise(function (ready) {
          waiters.push(function () { credit--; ready(); });
        });
      }

      function finish(error) {
        if (closed) return;
        closed = true;
        if (!opened) {
          reject(new TypeError(error || 'Request failed'));
          return;
        }
        if (!controller) return;
        try {
          if (error) controller.error(new TypeError(error));
          else controller.close();
        } catch (e) {
          // Already closed by a cancelled reader.
        }
      }

      function give(reason) {
        if (calls[id]) delete calls[id];
        post({ id: id, m: 'abort' });
        if (!opened) reject(reason);
        else if (controller) { try { controller.error(reason); } catch (e) {} }
        closed = true;
      }

      calls[id] = {
        resolve: function () {},
        reject: function (error) { finish(error && error.message); },

        head: function (head) {
          if (closed || opened) return;
          opened = true;

          var body = NO_BODY[head.status] ? null : new ReadableStream({
            start: function (c) { controller = c; },
            cancel: function () { give(abortError()); },
          });

          var response;
          try {
            response = new Response(body, {
              status: head.status,
              statusText: head.statusText,
              headers: head.headers || [],
            });
          } catch (e) {
            opened = false;
            finish('Tenna could not build that response');
            return;
          }

          // `Response.url` cannot be set from script, so where the bytes
          // really came from is a header. See NAPP.md.
          try { response.headers.append('X-Napp-Final-Url', String(head.url || '')); } catch (e) {}

          resolve(response);
        },

        chunk: function (sequence, bytes) {
          if (controller) {
            try { controller.enqueue(bytes); } catch (e) {}
          }
          post({ id: id, m: 'ack', i: sequence });
        },

        ack: grant,
        end: finish,
      };

      if (signal) {
        signal.addEventListener('abort', function () { give(abortError()); });
      }

      whenReady(function (ready) {
        if (closed) return;
        if (!calls[id]) return;

        var sent = ready && post({
          id: id,
          m: 'fetch',
          p: {
            url: request.url,
            method: request.method,
            headers: headers,
            redirect: request.redirect,
            hasBody: blob.size > 0,
            length: blob.size,
          },
        });

        if (!sent) {
          delete calls[id];
          closed = true;
          reject(new TypeError('Tenna is not listening'));
          return;
        }

        if (blob.size === 0) return;

        // The body is kept as a Blob rather than an ArrayBuffer throughout,
        // because a Blob is not obliged to be resident: slicing one gives back
        // the bytes that are wanted without the rest ever being in the heap.
        var offset = 0;
        var sequence = 0;

        function next() {
          if (closed || offset >= blob.size) return;

          var end = Math.min(offset + CHUNK_BYTES, blob.size);
          var slice = blob.slice(offset, end);
          var numbered = sequence++;
          offset = end;

          return spend()
            .then(function () { return closed ? null : slice.arrayBuffer(); })
            .then(function (buffer) {
              if (closed || buffer === null) return;
              frame(id, numbered, new Uint8Array(buffer));
              return next();
            });
        }

        next();
      });
    });
  }

  function nappFetch(input, init) {
    var request;
    try {
      request = new Request(input, init);
    } catch (e) {
      return Promise.reject(e);
    }

    if (request.signal && request.signal.aborted) return Promise.reject(abortError());

    var headers = [];
    request.headers.forEach(function (value, name) { headers.push([name, value]); });

    return request.blob().then(function (blob) {
      if (blob.size > MAX_BODY_BYTES) {
        throw new TypeError('A worker cannot send a body this large');
      }
      return run(request, headers, blob);
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
    return call('open', { url: path === undefined ? null : path })
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
    } else if (kind === 'periodicsync') {
      properties.tag = { value: String(data) };
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

  var KINDS = { push: true, notificationclick: true, notificationclose: true, periodicsync: true };

  self.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || typeof m !== 'object') return;

    var named = m.__napp === 'port' || KINDS[m.__napp];
    if (!named) return;

    // The port rides in with the event, so a site's handler has somewhere to
    // ask from its very first line. A worker that was already running gets a
    // fresh one and uses it; the old one belonged to a document that has since
    // gone, and nothing is waiting on it.
    if (e.ports && e.ports.length) adopt(e.ports[0]);

    if (m.__napp === 'port') return;

    var promises = [];
    var event = raise(m.__napp, m.data, promises);

    if (event) {
      try { self.dispatchEvent(event); } catch (err) {}
    }

    var finished = settle(promises).then(function () {
      reply(e.source, { __napp: 'done', id: m.id });
    });

    // The site's `waitUntil` has to mean to Chromium what it would mean
    // anywhere else. Chromium is tracking this `message`, not the `push` made
    // out of it, so the promises are handed on to the event it can see — and
    // the worker is kept alive for as long as they are pending, under
    // Chromium's own ceiling, rather than being stopped as idle half way
    // through the work.
    if (typeof e.waitUntil === 'function') e.waitUntil(finished);
  });

  /**
   * Wait for every promise, including ones added while waiting.
   *
   * The standard lets a handler call `waitUntil` again later, so long as an
   * earlier promise is still pending, and one that does so is extending the
   * same event rather than starting a new one.
   */
  function settle(promises) {
    var seen = promises.length;
    return Promise.allSettled(promises.slice()).then(function () {
      if (promises.length > seen) return settle(promises);
    });
  }
})();
