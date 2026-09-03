/**
 * Generates the injected NIP-07 provider script for sandboxed nsites.
 *
 * The script defines `window.nostr` conforming to the NIP-07 interface.
 * `getPublicKey()` returns the embedded pubkey instantly (always allowed).
 * All other methods (`signEvent`, `nip04.*`, `nip44.*`) send JSON-RPC 2.0
 * requests to the host and await responses.
 *
 * A serial queue ensures only one RPC is in flight at a time, preventing
 * the host from being overwhelmed with concurrent permission prompts.
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

export function getNsiteNostrProviderScript(
  pubkey: string,
  transport: NsiteRpcTransport = 'postMessage',
): string {
  const { receive, send } = getTransportSource(transport);

  return `(function() {
  'use strict';

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

  function rpc(method, params) {
    return enqueue(function() {
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
    });
  }

  // ------------------------------------------------------------------
  // NIP-07 provider
  // ------------------------------------------------------------------
  var pubkey = ${JSON.stringify(pubkey)};

  window.nostr = {
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

  // Signal availability to the nsite.
  try {
    window.dispatchEvent(new Event('nostr:ready'));
  } catch(e) {}
})();`;
}
