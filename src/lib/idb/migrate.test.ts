import { IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { connect, IDBFactory as EngineFactory, send } from './engine';
import { INTERNAL } from './keyRange';
import { MemoryStore } from './memoryStore';
import { migrate, type Native } from './migrate';
import type { Wire } from './wire';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The platform's IndexedDB, as the test setup provides it. */
const native: Native = { indexedDB: globalThis.indexedDB, IDBKeyRange: FakeKeyRange as unknown as typeof IDBKeyRange };

async function seed(): Promise<void> {
  const open = native.indexedDB.open('app', 3);
  open.onupgradeneeded = () => {
    const db = open.result;
    const kv = db.createObjectStore('kv');
    kv.put({ when: new Date(5), bytes: new Uint8Array([1, 2]) }, 'a');
    kv.put('second', [1, 'b']);
    kv.put('third', 7);
    const items = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    items.createIndex('by_tag', 'tags', { multiEntry: true });
    for (let i = 0; i < 1203; i++) items.put({ tags: i % 2 ? ['odd', `n${i}`] : ['even'] });
  };
  (await done(open)).close();
  const other = native.indexedDB.open('empty', 1);
  other.onupgradeneeded = () => other.result.createObjectStore('nothing');
  (await done(other)).close();
}

describe('moving a site out of WebKit', () => {
  it('copies every database, checks it, and takes it out of the old store', async () => {
    await seed();
    const store = new MemoryStore();
    connect(store.transport);
    const ours = new EngineFactory(INTERNAL, true) as unknown as IDBFactory;
    const sender = (message: unknown[]) => send(message as Wire);

    await migrate(native, ours as unknown as EngineFactory, sender);

    expect(await native.indexedDB.databases()).toEqual([]);
    expect((await ours.databases()).map((d) => [d.name, d.version]).sort()).toEqual([['app', 3], ['empty', 1]]);

    const db = await done(ours.open('app'));
    expect([...db.objectStoreNames]).toEqual(['items', 'kv']);
    const txn = db.transaction(['kv', 'items'], 'readwrite');
    const kv = txn.objectStore('kv');
    const a = (await done(kv.get('a'))) as { when: Date; bytes: Uint8Array };
    expect(a.when.getTime()).toBe(5);
    expect([...a.bytes]).toEqual([1, 2]);
    expect(await done(kv.get([1, 'b']))).toBe('second');
    expect(await done(kv.getAllKeys())).toEqual([7, 'a', [1, 'b']]);

    const items = txn.objectStore('items');
    expect(items.keyPath).toBe('id');
    expect(items.autoIncrement).toBe(true);
    expect(await done(items.count())).toBe(1203);
    expect(await done(items.index('by_tag').count('even'))).toBe(602);
    expect(((await done(items.get(1204 - 1))) as { id: number }).id).toBe(1203);
    // The generator carries on past the largest key.
    expect(await done(items.put({ tags: [] }))).toBe(1204);
    db.close();

    // Recorded, so it does not run again.
    expect(await sender(['migration'])).toBe(1);
  });

  it('records the move when there is no old store to move from', async () => {
    const store = new MemoryStore();
    connect(store.transport);
    await migrate(undefined, new EngineFactory(INTERNAL, true), (message) => send(message as Wire));
    expect(store.migrated).toBe(true);
  });
});
