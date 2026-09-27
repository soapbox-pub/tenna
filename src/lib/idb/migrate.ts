/**
 * Moving a site's IndexedDB out of WebKit, once.
 *
 * Before Tenna had its own IndexedDB, a site's databases lived in WebKit's
 * store for the site. The first time the site's page loads with this engine,
 * before it can make a request of its own, every one of those databases is
 * copied in: the same version, the same stores and indexes, every record with
 * its key. Each copy is checked — the same count in every store, the same keys
 * in the same order — and only a database whose copy checks out is deleted
 * from WebKit. Then the store is told the move is done, and it never runs
 * again.
 *
 * A database that cannot be copied is left in WebKit, where nothing can reach
 * it any more: a value this engine cannot store, such as a CryptoKey, is the
 * one way that happens. The move is still recorded, so a site is not held up
 * trying on every load.
 *
 * A key generator's current number is not something IndexedDB will say, so a
 * copied store's generator carries on from past its largest numeric key —
 * which is where it would be unless records at the top were deleted.
 */

import { IDBKeyRange as EngineKeyRange, type IDBFactory as EngineFactory } from './engine';

/**
 * The platform's own IndexedDB, as it was before this engine replaced it, or
 * nothing when there was none.
 */
export interface Native {
  indexedDB: IDBFactory;
  IDBKeyRange: typeof IDBKeyRange;
}

const BATCH = 500;

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onabort = () => reject(txn.error ?? new DOMException('The transaction was aborted.', 'AbortError'));
  });
}

interface StoreShape {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
}

/**
 * Copy every database out of the platform's IndexedDB into the engine's, and
 * record that it has been done. Resolves when there is nothing left to wait
 * for, whether or not every database came across.
 */
export async function migrate(native: Native | undefined, ours: EngineFactory, send: (message: unknown[]) => Promise<unknown>): Promise<void> {
  if ((await send(['migration'])) === 1) return;
  // With no IndexedDB of WebKit's — Lockdown Mode — there is nothing to
  // move now, and the move is recorded all the same: data WebKit turned up
  // with later would be older than what the site has written here since.
  let databases: IDBDatabaseInfo[] = [];
  try {
    if (native) databases = await native.indexedDB.databases();
  } catch {
    databases = [];
  }
  for (const info of databases) {
    if (!info.name) continue;
    try {
      await copy(native!, ours as unknown as IDBFactory, info.name);
    } catch (error) {
      console.warn(`[tenna] IndexedDB "${info.name}" could not be moved:`, error);
    }
  }
  await send(['migration', 1]);
}

async function copy(native: Native, ours: IDBFactory, name: string): Promise<void> {
  const source = await done(native.indexedDB.open(name));
  try {
    const version = source.version;
    const shapes = shapesOf(source);

    // Whatever this engine already has under the name — a worker that ran
    // before the page did — gives way to what the site had.
    await done(ours.deleteDatabase(name));
    const open = ours.open(name, version);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const shape of shapes) {
        const store = db.createObjectStore(shape.name, { keyPath: shape.keyPath, autoIncrement: shape.autoIncrement });
        for (const index of shape.indexes) {
          store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
    };
    const target = await done(open);
    try {
      for (const shape of shapes) await copyStore(native, source, target, shape);
      for (const shape of shapes) await verify(native, source, target, ours, shape);
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
  // Only a database whose copy checked out is taken out of WebKit.
  await done(native.indexedDB.deleteDatabase(name));
}

function shapesOf(db: IDBDatabase): StoreShape[] {
  const names = [...db.objectStoreNames];
  if (!names.length) return [];
  const txn = db.transaction(names, 'readonly');
  return names.map((name) => {
    const store = txn.objectStore(name);
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: [...store.indexNames].map((indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }),
    };
  });
}

/** Read a store's records in key order, a batch at a time. */
async function batch(native: Native, db: IDBDatabase, store: string, after: IDBValidKey | undefined): Promise<[IDBValidKey[], unknown[]]> {
  const txn = db.transaction(store, 'readonly');
  const range = after === undefined ? undefined : native.IDBKeyRange.lowerBound(after, true);
  const s = txn.objectStore(store);
  const [keys, values] = await Promise.all([done(s.getAllKeys(range, BATCH)), done(s.getAll(range, BATCH))]);
  return [keys, values];
}

async function copyStore(native: Native, source: IDBDatabase, target: IDBDatabase, shape: StoreShape): Promise<void> {
  let after: IDBValidKey | undefined;
  for (;;) {
    const [keys, values] = await batch(native, source, shape.name, after);
    if (!keys.length) return;
    const txn = target.transaction(shape.name, 'readwrite');
    const store = txn.objectStore(shape.name);
    for (let i = 0; i < keys.length; i++) {
      if (shape.keyPath === null) store.put(values[i], keys[i]);
      else store.put(values[i]);
    }
    await finished(txn);
    after = keys[keys.length - 1];
  }
}

async function verify(native: Native, source: IDBDatabase, target: IDBDatabase, ours: IDBFactory, shape: StoreShape): Promise<void> {
  const count = async (db: IDBDatabase) => done(db.transaction(shape.name, 'readonly').objectStore(shape.name).count());
  const [had, has] = await Promise.all([count(source), count(target)]);
  if (had !== has) throw new Error(`"${shape.name}" has ${has} records of ${had}`);
  let after: IDBValidKey | undefined;
  for (;;) {
    const [keys] = await batch(native, source, shape.name, after);
    if (!keys.length) return;
    const txn = target.transaction(shape.name, 'readonly');
    const range = after === undefined ? undefined : EngineKeyRange.lowerBound(after, true);
    const copied = await done(txn.objectStore(shape.name).getAllKeys(range, BATCH));
    if (copied.length !== keys.length || keys.some((key, i) => ours.cmp(key, copied[i]) !== 0)) {
      throw new Error(`"${shape.name}" has different keys`);
    }
    after = keys[keys.length - 1];
  }
}
