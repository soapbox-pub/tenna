/**
 * Tenna's IndexedDB, installed into whatever realm evaluates this.
 *
 * Built by `scripts/build-idb.mjs` into one script that runs before any of a
 * site's own code: at document start in a site's page and its same-origin
 * frames, and ahead of a site's workers. It replaces `indexedDB` and every
 * IndexedDB interface with ones whose records live in Tenna's store for the
 * site — a SQLite file per database in the App Group, which the page and the
 * notification extension's copy of the site's service worker both open.
 * WebKit's own IndexedDB keeps each process's data to itself, and Lockdown
 * Mode takes it away entirely; this one is the same everywhere.
 *
 * How the realm reaches the store:
 *
 * - `self.__tennaIDBTransport`, when whatever loaded this script set one
 *   first — a test. Taken and deleted, so a site cannot call it.
 * - `webkit.messageHandlers.tennaIDB`, which answers each message with a
 *   promise: a site's page and its frames.
 * - In a worker, a MessagePort, which the realm that started the worker sends
 *   as its first message and answers through its own transport: a worker
 *   the site's page starts, one that worker starts, and the service worker
 *   the notification extension runs, whose host page does the same.
 *
 * A realm with a transport starts its workers with the engine loaded ahead of
 * them — see `wrapWorkers`.
 *
 * CryptoKeys are kept through a vault (`cryptoKeys.ts`): a page's realm starts
 * one with the sealing key left for it in `self.__tennaIDBVaultKey`, and a
 * worker is handed a port to its starter's with the port to the store.
 *
 * And, riding along because this is the script that runs first in every one
 * of a site's realms, the Cache API is taught the site's own URLs
 * (`caches.ts`).
 */

import { INTERNAL } from './keyRange';
import { installCaches } from './caches';
import { bindVault, expectVault, vaultPort, wrapSubtle } from './cryptoKeys';
import { connect, disconnect, IDBFactory, INTERFACES, DOMStringList } from './engine';
import type { Transport } from './protocol';

interface Scope {
  __tennaIDBTransport?: Transport;
  /** The site's sealing key, base64: see `NsiteCryptoKeys.swift`. */
  __tennaIDBVaultKey?: string;
  /** A vault to use as it is: tests. */
  __tennaIDBVault?: MessagePort;
  SubtleCrypto?: { prototype: object };
  importScripts?: unknown;
  Worker?: typeof Worker;
  origin?: string;
  location?: { href: string };
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
  if (typeof scope.importScripts === 'function') return portTransport(scope as typeof globalThis & Scope);
  return undefined;
}

/**
 * Start this realm's vault, if it was given what to start one with. The key is
 * taken and deleted before any of the site's code can look, and goes straight
 * to the vault, a worker the site never gets hold of.
 */
function startVault(scope: typeof globalThis & Scope, NativeWorker: typeof Worker | undefined): void {
  const given = scope.__tennaIDBVault;
  if (given) {
    delete scope.__tennaIDBVault;
    bindVault(given);
    return;
  }
  const key = scope.__tennaIDBVaultKey;
  if (typeof key !== 'string') return;
  delete scope.__tennaIDBVaultKey;
  if (typeof NativeWorker !== 'function' || !scope.origin) return;
  const raw = atob(key);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const channel = new MessageChannel();
  const worker = new NativeWorker(`${scope.origin}/.tenna/vault.js`);
  worker.postMessage({ key: bytes, port: channel.port2 }, [bytes.buffer, channel.port2]);
  bindVault(channel.port1, worker);
}

/** A relayed message, and its answer. */
interface Relayed {
  id: number;
  text?: string;
  reply?: string;
  error?: string;
}

const PORT_MARKER = '__tennaIDBPort';

/**
 * A worker's way to the store: the port its starter sends first. The
 * listener goes on before any of the site's code runs, and takes the port's
 * message before a listener of the site's could see it.
 */
function portTransport(scope: typeof globalThis & Scope): Transport {
  let port: MessagePort | null = null;
  const vaultCame = expectVault();
  const queue: Relayed[] = [];
  const pending = new Map<number, [(text: string) => void, (error: Error) => void]>();
  let next = 1;
  scope.addEventListener('message', (event: Event) => {
    const message = (event as MessageEvent).data as Record<string, unknown> | null;
    if (!message || typeof message !== 'object' || message[PORT_MARKER] !== true) return;
    event.stopImmediatePropagation();
    port = (event as MessageEvent).ports[0];
    vaultCame((event as MessageEvent).ports[1] ?? null);
    port.onmessage = (reply) => {
      const answer = reply.data as Relayed;
      const waiter = pending.get(answer.id);
      pending.delete(answer.id);
      if (!waiter) return;
      if (typeof answer.error === 'string') waiter[1](new Error(answer.error));
      else waiter[0](answer.reply!);
    };
    for (const queued of queue.splice(0)) port.postMessage(queued);
  });
  return (text) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, [resolve, reject]);
      const message: Relayed = { id, text };
      if (port) port.postMessage(message);
      else queue.push(message);
    });
}

/**
 * The Blob behind each `blob:` URL this realm has made and not revoked, so
 * that a worker started on one can be started on a copy of it instead.
 *
 * A worker's own script may be a blob with no type at all — `new Blob([code])`,
 * which bundlers and libraries write all the time — but a script it imports
 * may not: WebKit refuses one whose type is not JavaScript's, and the worker
 * fails with "Load failed". So the engine's wrapper imports a copy under
 * JavaScript's type instead. The copy is made here, when the worker is
 * constructed, because the usual next line is `URL.revokeObjectURL(url)`, and
 * the wrapper runs later, in the worker. A Map rather than a WeakMap costs
 * nothing: the platform holds each Blob until its URL is revoked anyway.
 */
const blobs = new Map<string, Blob>();

/**
 * Start recording, and hand back the platform's own `createObjectURL` and
 * the record's own `get`, which a site replacing either later cannot reach.
 */
function recordBlobs(scope: typeof globalThis): { create: (blob: Blob) => string; lookup: (url: string) => Blob | undefined } {
  const Url = scope.URL;
  const create = Url.createObjectURL;
  const revoke = Url.revokeObjectURL;
  const mapGet = Map.prototype.get;
  const recorder = {
    create: (blob: Blob) => Reflect.apply(create, Url, [blob]) as string,
    lookup: (url: string) => Reflect.apply(mapGet, blobs, [url]) as Blob | undefined,
  };
  const mapSet = Map.prototype.set;
  const mapDelete = Map.prototype.delete;
  const methods = {
    createObjectURL(object: Blob | MediaSource): string {
      const url = Reflect.apply(create, Url, [object]) as string;
      if (object instanceof Blob) Reflect.apply(mapSet, blobs, [url, object]);
      return url;
    },
    revokeObjectURL(url: string): void {
      Reflect.apply(mapDelete, blobs, [String(url)]);
      return Reflect.apply(revoke, Url, [url]) as void;
    },
  };
  for (const name of ['createObjectURL', 'revokeObjectURL'] as const) {
    Object.defineProperty(methods[name], 'length', { value: 1 });
    Object.defineProperty(Url, name, { value: methods[name], writable: true, configurable: true, enumerable: true });
  }
  return recorder;
}

/**
 * The script a `blob:` worker is really started with: the engine, then the
 * site's blob. `typed` when `href` is this realm's JavaScript-typed copy of
 * it; otherwise the blob was made somewhere else and is read and retyped in
 * the worker — synchronously in a classic one, so the site's code still runs
 * in the worker's first task, and with top-level await in a module.
 */
function blobWrapper(engine: string, href: string, module: boolean, typed: boolean): string {
  if (typed) {
    return module
      ? `import ${JSON.stringify(engine)};
import ${JSON.stringify(href)};
`
      : `importScripts(${JSON.stringify(engine)}, ${JSON.stringify(href)});
`;
  }
  if (module) {
    return `import ${JSON.stringify(engine)};
const response = await fetch(${JSON.stringify(href)});
const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: 'text/javascript' }));
try { await import(url); } finally { URL.revokeObjectURL(url); }
`;
  }
  return `importScripts(${JSON.stringify(engine)});
(function () {
  var request = new XMLHttpRequest();
  request.open('GET', ${JSON.stringify(href)}, false);
  request.responseType = 'arraybuffer';
  request.send();
  var url = URL.createObjectURL(new Blob([request.response], { type: 'text/javascript' }));
  try { importScripts(url); } finally { URL.revokeObjectURL(url); }
})();
`;
}

/**
 * Start the site's workers with the engine ahead of them, reaching the store
 * through this realm. A script of the site's is started at its own URL with a
 * marker, which the scheme handler answers with the engine and then the
 * script (`NsiteSchemeHandler.indexedDB`); a `blob:` script through a
 * wrapper blob that does the same — see `recordBlobs`. Anybody else's script is started as it
 * is, and has WebKit's IndexedDB.
 */
function wrapWorkers(scope: typeof globalThis & Scope, transport: Transport): void {
  const Native = scope.Worker;
  if (typeof Native !== 'function' || !scope.location) return;
  const origin = scope.origin;
  const engine = `${origin}/.tenna/idb.js`;
  const { create, lookup } = recordBlobs(scope);

  const Worker = function Worker(this: unknown, url: string | URL, options?: WorkerOptions) {
    if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
    const target = new URL(String(url), scope.location!.href);
    const module = options?.type === 'module';
    let start: string;
    if (target.protocol === 'blob:') {
      const blob = lookup(target.href);
      const script = blob ? create(new Blob([blob], { type: 'text/javascript' })) : target.href;
      start = create(new Blob([blobWrapper(engine, script, module, !!blob)], { type: 'text/javascript' }));
    } else if (target.origin === origin) {
      target.searchParams.append('__tenna_idb_worker', module ? 'module' : 'classic');
      start = target.href;
    } else {
      return Reflect.construct(Native, [url, options], new.target) as Worker;
    }
    const worker = Reflect.construct(Native, [start, options], new.target) as Worker;
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const message = event.data as Relayed;
      transport(message.text!).then(
        (reply) => channel.port1.postMessage({ id: message.id, reply }),
        (error: unknown) => channel.port1.postMessage({ id: message.id, error: String((error as Error)?.message ?? error) }),
      );
    };
    const vault = vaultPort();
    worker.postMessage({ [PORT_MARKER]: true }, vault ? [channel.port2, vault] : [channel.port2]);
    return worker;
  };
  Worker.prototype = Native.prototype;
  Object.setPrototypeOf(Worker, Native);
  Object.defineProperty(Native.prototype, 'constructor', { value: Worker, writable: true, configurable: true });
  Object.defineProperty(scope, 'Worker', { value: Worker, writable: true, configurable: true, enumerable: false });
}

function install(scope: typeof globalThis & Scope, transport: Transport): void {
  connect(transport);
  // The platform's Worker, before `wrapWorkers` replaces it: the vault is not
  // a worker of the site's.
  startVault(scope, scope.Worker);
  wrapSubtle(scope);
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
  wrapWorkers(scope, transport);
}

const scope = globalThis as typeof globalThis & Scope;
const transport = transportFor(scope);
if (transport) install(scope, transport);
installCaches(scope);
