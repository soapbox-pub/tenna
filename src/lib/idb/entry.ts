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
 */

import { INTERNAL } from './keyRange';
import { connect, disconnect, IDBFactory, INTERFACES, DOMStringList } from './engine';
import type { Transport } from './protocol';

interface Scope {
  __tennaIDBTransport?: Transport;
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
  const queue: Relayed[] = [];
  const pending = new Map<number, [(text: string) => void, (error: Error) => void]>();
  let next = 1;
  scope.addEventListener('message', (event: Event) => {
    const message = (event as MessageEvent).data as Record<string, unknown> | null;
    if (!message || typeof message !== 'object' || message[PORT_MARKER] !== true) return;
    event.stopImmediatePropagation();
    port = (event as MessageEvent).ports[0];
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
 * Start the site's workers with the engine ahead of them, reaching the store
 * through this realm. A script of the site's is started at its own URL with a
 * marker, which the scheme handler answers with the engine and then the
 * script (`NsiteSchemeHandler.indexedDB`); a `blob:` script through a
 * wrapper blob that does the same. Anybody else's script is started as it
 * is, and has WebKit's IndexedDB.
 */
function wrapWorkers(scope: typeof globalThis & Scope, transport: Transport): void {
  const Native = scope.Worker;
  if (typeof Native !== 'function' || !scope.location) return;
  const origin = scope.origin;
  const engine = `${origin}/.tenna/idb.js`;

  const Worker = function Worker(this: unknown, url: string | URL, options?: WorkerOptions) {
    if (!new.target) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator.");
    const target = new URL(String(url), scope.location!.href);
    const module = options?.type === 'module';
    let start: string;
    if (target.protocol === 'blob:') {
      const source = module
        ? `import ${JSON.stringify(engine)};
import ${JSON.stringify(target.href)};
`
        : `importScripts(${JSON.stringify(engine)}, ${JSON.stringify(target.href)});
`;
      start = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
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
    worker.postMessage({ [PORT_MARKER]: true }, [channel.port2]);
    return worker;
  };
  Worker.prototype = Native.prototype;
  Object.setPrototypeOf(Worker, Native);
  Object.defineProperty(Native.prototype, 'constructor', { value: Worker, writable: true, configurable: true });
  Object.defineProperty(scope, 'Worker', { value: Worker, writable: true, configurable: true, enumerable: false });
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
  wrapWorkers(scope, transport);
}

const scope = globalThis as typeof globalThis & Scope;
const transport = transportFor(scope);
if (transport) install(scope, transport);
