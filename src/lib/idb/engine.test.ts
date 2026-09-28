import { describe, expect, it } from 'vitest';

import { connect, IDBFactory as EngineFactory } from './engine';
import { INTERNAL } from './keyRange';
import { MemoryStore } from './memoryStore';
import { decode, type Wire } from './wire';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onabort = () => reject(txn.error);
  });
}

describe('durability', () => {
  it('asks the store for a synced commit only for a strict transaction', async () => {
    const store = new MemoryStore();
    const begins: Wire[] = [];
    connect((message) => {
      const request = decode(message) as Wire[];
      if (request[0] === 'tx' && request[3]) begins.push(request[3]);
      return store.transport(message);
    });
    const factory = new EngineFactory(INTERNAL) as unknown as IDBFactory;
    const open = factory.open('d', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('s');
    const db = await done(open);

    for (const durability of ['default', 'relaxed', 'strict'] as const) {
      const txn = db.transaction('s', 'readwrite', { durability });
      txn.objectStore('s').put(durability, durability);
      await finished(txn);
    }
    const reads = db.transaction('s', 'readonly', { durability: 'strict' });
    reads.objectStore('s').get('strict');
    await finished(reads);

    const writes = begins.filter((b) => (b as Wire[])[0] === 'w');
    expect(writes.map((b) => (b as Wire[])[4] ?? null)).toEqual([null, null, 's']);
    // A read commits nothing, so there is nothing to sync.
    expect((begins.find((b) => (b as Wire[])[0] === 'r') as Wire[])[4]).toBeUndefined();
    db.close();
  });
});
