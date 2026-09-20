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

export function getNsiteNostrProviderScript(
  pubkey: string | null,
  transport: NsiteRpcTransport = 'postMessage',
  options: NsiteBridgeOptions = {},
): string {
  const { receive, send } = getTransportSource(transport);

  const napp: string[] = [];
  if (options.push) napp.push(NAPP_PUSH_SOURCE);
  if (options.fetch) napp.push(NAPP_FETCH_SOURCE);

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
${options.fetch ? nappFetchImplementation() : ''}
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
