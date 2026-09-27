/**
 * Tenna's IndexedDB, installed into whatever realm evaluates this.
 *
 * Built by `scripts/build-idb.mjs` into one script that runs before any of a
 * site's own code: at document start in a site's page and its same-origin
 * frames, and ahead of a site's workers. It replaces `indexedDB` and every
 * IndexedDB interface with ones whose records live in Tenna's store for the
 * site — one SQLite file per site in the App Group, which the page and the
 * notification extension's copy of the site's service worker both open.
 * WebKit's own IndexedDB keeps each process's data to itself, and Lockdown
 * Mode takes it away entirely; this one is the same everywhere.
 *
 * How the realm reaches the store:
 *
 * - `self.__tennaIDBTransport`, when whatever loaded this script set one
 *   first — a worker, relaying through the page or host page that made it,
 *   or a test. Taken and deleted, so a site cannot call it.
 * - Otherwise `webkit.messageHandlers.tennaIDB`, which answers each message
 *   with a promise: a site's page and its frames.
 *
 * With neither, the realm keeps whatever IndexedDB it had.
 */

import { INTERNAL } from './keyRange';
import { connect, disconnect, IDBFactory, INTERFACES, DOMStringList } from './engine';
import type { Transport } from './protocol';

interface Scope {
  __tennaIDBTransport?: Transport;
  webkit?: { messageHandlers?: { tennaIDB?: { postMessage(message: string): Promise<string> } } };
  addEventListener?: (type: string, listener: () => void) => void;
}

function transportFor(scope: Scope): Transport | undefined {
  const given = scope.__tennaIDBTransport;
  if (typeof given === 'function') {
    delete scope.__tennaIDBTransport;
    return given;
  }
  const handler = scope.webkit?.messageHandlers?.tennaIDB;
  if (handler) {
    const post = handler.postMessage.bind(handler);
    return (message) => post(message);
  }
  return undefined;
}

function install(scope: typeof globalThis & Scope, transport: Transport): void {
  connect(transport);
  const factory = new IDBFactory(INTERNAL);
  const get = function (this: unknown) {
    if (this !== undefined && this !== null && this !== scope) throw new TypeError('Illegal invocation');
    return factory;
  };
  Object.defineProperty(get, 'name', { value: 'get indexedDB' });
  Object.defineProperty(scope, 'indexedDB', { get, enumerable: true, configurable: true });
  for (const [cls, name] of INTERFACES) {
    Object.defineProperty(cls, 'name', { value: name, configurable: true });
    Object.defineProperty(scope, name, { value: cls, writable: true, configurable: true, enumerable: false });
  }
  // The platform's own DOMStringList stays: WebKit hands those out too. Ours
  // inherits from it, so `instanceof DOMStringList` holds for both, and its
  // own members shadow the native ones that would refuse it.
  const Native = (scope as unknown as { DOMStringList?: { prototype: object } }).DOMStringList;
  if (Native && Native !== DOMStringList) Object.setPrototypeOf(DOMStringList.prototype, Native.prototype);
  else Object.defineProperty(scope, 'DOMStringList', { value: DOMStringList, writable: true, configurable: true, enumerable: false });
  scope.addEventListener?.('pagehide', disconnect);
}

const scope = globalThis as typeof globalThis & Scope;
const transport = transportFor(scope);
if (transport) install(scope, transport);
