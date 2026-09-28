/**
 * The vault as a worker: `/.tenna/vault.js`, built from this by
 * `scripts/build-idb.mjs`.
 *
 * Its first message, from the realm that started it, is the site's sealing key
 * and the port to serve, and it listens for nothing else: more ports arrive
 * through that one. A worker started at this URL by anything else never gets
 * a key, and answers nothing. See `vault.ts`.
 */

import { serveVault } from './vault';

interface VaultScope {
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as VaultScope;
const subtle = crypto.subtle;
let first = true;

scope.onmessage = (event) => {
  const message = event.data as { key?: Uint8Array<ArrayBuffer>; port?: MessagePort };
  if (!first || !message || !message.key || !message.port) return;
  first = false;
  scope.onmessage = null;
  void serveVault(message.key, message.port, subtle);
};
