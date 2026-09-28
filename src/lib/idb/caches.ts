/**
 * The Cache API for a site's own URLs, on a scheme WebKit's will not key.
 *
 * WebKit's `caches` is there on iOS and works, but only for http and https:
 * `cache.put('/app.js', response)` in a site served from `nsite://` throws
 * "Request url is not HTTP/HTTPS", and so does `cache.add`, which is every
 * offline cache and every Workbox precache there is. So a site's own URL is
 * kept under a stand-in — `nsite://<host>/x` as `https://<host>/x`, the same
 * host, which is `*.nsite.localhost` and so never a real one — and turned
 * back on the way out. Anybody else's URL is left alone.
 *
 * The records are WebKit's, in the site's own data store: the page and its
 * workers share them, and the notification extension's copy of the service
 * worker has a store of its own that never sees them. What a push handler
 * needs belongs in IndexedDB, which is shared.
 *
 * `add` and `addAll` fetch for themselves rather than through WebKit's, which
 * would fetch the stand-in.
 */

interface Scope {
  origin?: string;
  location?: { href: string };
  Cache?: { prototype: Cache };
  CacheStorage?: { prototype: CacheStorage };
  Request: typeof Request;
  fetch: typeof fetch;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

export function installCaches(scope: Scope): void {
  const CacheProto = scope.Cache?.prototype;
  const StorageProto = scope.CacheStorage?.prototype;
  if (!CacheProto || !StorageProto || typeof scope.origin !== 'string') return;
  let own: URL;
  try {
    own = new URL(scope.origin);
  } catch {
    return;
  }
  if (own.protocol === 'http:' || own.protocol === 'https:' || !own.host) return;

  const NativeRequest = scope.Request;
  const nativeFetch = scope.fetch;
  const native = <T>(proto: T, name: keyof T) => proto[name] as unknown as Method;
  const put = native(CacheProto, 'put');
  const standIn = `https://${own.host}`;

  /** A site's own URL as its stand-in; anything else, or nothing to parse, as null. */
  function toKey(href: string): string | null {
    let url: URL;
    try {
      url = new URL(href, scope.location?.href);
    } catch {
      return null;
    }
    if (url.protocol !== own.protocol || url.host !== own.host) return null;
    return standIn + url.pathname + url.search + url.hash;
  }

  function fromKey(href: string): string | null {
    return href.startsWith(`${standIn}/`) ? `${own.protocol}//${own.host}${href.slice(standIn.length)}` : null;
  }

  /** A request like `request`, at another URL. Only what matching reads — and keys() hands back — comes along. */
  function moved(request: Request, url: string): Request {
    return new NativeRequest(url, {
      method: request.method,
      headers: request.headers,
      mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
      credentials: request.credentials,
      cache: request.cache === 'only-if-cached' ? 'default' : request.cache,
      redirect: request.redirect,
      integrity: request.integrity,
      referrerPolicy: request.referrerPolicy,
    });
  }

  /** The argument a native method is given in place of a site's `request`. */
  function inward(request: unknown): unknown {
    if (request instanceof NativeRequest) {
      const key = toKey(request.url);
      return key ? moved(request, key) : request;
    }
    if (typeof request === 'string' || request instanceof URL) return toKey(String(request)) ?? request;
    return request;
  }

  function outward(request: Request): Request {
    const url = fromKey(request.url);
    return url ? moved(request, url) : request;
  }

  async function addAll(cache: Cache, requests: Iterable<RequestInfo | URL>): Promise<void> {
    const list = Array.from(requests, (request) => new NativeRequest(request));
    for (const request of list) {
      if (request.method !== 'GET') throw new TypeError('Cache.addAll: only GET requests can be cached.');
    }
    const responses = await Promise.all(list.map((request) => Reflect.apply(nativeFetch, scope, [request]) as Promise<Response>));
    for (const response of responses) {
      if (!response.ok) throw new TypeError(`Cache.addAll: a response had status ${response.status}.`);
      if (response.headers.get('Vary')?.split(',').some((field) => field.trim() === '*')) {
        throw new TypeError("Cache.addAll: a response had 'Vary: *'.");
      }
    }
    await Promise.all(list.map((request, i) => Reflect.apply(put, cache, [inward(request), responses[i]])));
  }

  const cacheMatch = native(CacheProto, 'match');
  const cacheMatchAll = native(CacheProto, 'matchAll');
  const cacheDelete = native(CacheProto, 'delete');
  const cacheKeys = native(CacheProto, 'keys');
  const cacheAddAll = native(CacheProto, 'addAll');
  const storageMatch = native(StorageProto, 'match');

  const cacheMethods = {
    match(this: Cache, request: RequestInfo | URL, options?: CacheQueryOptions) {
      return Reflect.apply(cacheMatch, this, [inward(request), options]) as Promise<Response | undefined>;
    },
    matchAll(this: Cache, ...args: [(RequestInfo | URL)?, CacheQueryOptions?]) {
      if (args.length && args[0] !== undefined) args[0] = inward(args[0]) as RequestInfo;
      return Reflect.apply(cacheMatchAll, this, args) as Promise<readonly Response[]>;
    },
    add(this: Cache, request: RequestInfo | URL) {
      return cacheMethods.addAll.call(this, [request]);
    },
    addAll(this: Cache, requests: Iterable<RequestInfo | URL>) {
      // A brand check before anything is fetched, as the platform's does.
      if (!(this instanceof (scope.Cache as unknown as typeof Cache))) {
        return Reflect.apply(cacheAddAll, this, [requests]) as Promise<void>;
      }
      return addAll(this, requests);
    },
    put(this: Cache, request: RequestInfo | URL, response: Response) {
      return Reflect.apply(put, this, [inward(request), response]) as Promise<void>;
    },
    delete(this: Cache, request: RequestInfo | URL, options?: CacheQueryOptions) {
      return Reflect.apply(cacheDelete, this, [inward(request), options]) as Promise<boolean>;
    },
    async keys(this: Cache, ...args: [(RequestInfo | URL)?, CacheQueryOptions?]) {
      if (args.length && args[0] !== undefined) args[0] = inward(args[0]) as RequestInfo;
      const requests = await (Reflect.apply(cacheKeys, this, args) as Promise<readonly Request[]>);
      return requests.map(outward);
    },
  };
  const storageMethods = {
    match(this: CacheStorage, request: RequestInfo | URL, options?: MultiCacheQueryOptions) {
      return Reflect.apply(storageMatch, this, [inward(request), options]) as Promise<Response | undefined>;
    },
  };

  const lengths: Record<string, number> = { match: 1, matchAll: 0, add: 1, addAll: 1, put: 2, delete: 1, keys: 0 };
  const define = (proto: object, methods: Record<string, unknown>) => {
    for (const [name, method] of Object.entries(methods)) {
      Object.defineProperty(method, 'name', { value: name });
      Object.defineProperty(method, 'length', { value: lengths[name] });
      Object.defineProperty(proto, name, { value: method, writable: true, configurable: true, enumerable: true });
    }
  };
  define(CacheProto, cacheMethods);
  define(StorageProto, storageMethods);
}
