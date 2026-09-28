import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import { beforeAll, describe, expect, it } from 'vitest';

import { bindCloneRealm } from './clone';
import { bindVault, open, seal, wrapSubtle } from './cryptoKeys';
import { connect, IDBFactory as EngineFactory } from './engine';
import { INTERNAL } from './keyRange';
import { MemoryStore } from './memoryStore';
import { serveVault } from './vault';

const node = webcrypto.subtle as unknown as SubtleCrypto;
const NodeCryptoKey = globalThis.CryptoKey;

/** A realm's SubtleCrypto of its own to wrap, so wrapping it does not wrap Node's. */
class TestSubtle {}
for (const name of ['generateKey', 'importKey', 'deriveKey', 'unwrapKey', 'exportKey', 'wrapKey', 'encrypt', 'decrypt', 'sign', 'verify', 'deriveBits']) {
  (TestSubtle.prototype as Record<string, unknown>)[name] = function (...args: unknown[]) {
    return Reflect.apply((node as unknown as Record<string, (...a: unknown[]) => unknown>)[name], node, args);
  };
}
const subtle = new TestSubtle() as unknown as SubtleCrypto;

function sealingKey(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(fill);
}

function startVault(fill: number): MessagePort {
  const { port1, port2 } = new MessageChannel();
  void serveVault(sealingKey(fill), port2 as unknown as MessagePort, node);
  return port1 as unknown as MessagePort;
}

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let db: IDBDatabase;

async function roundTrip<T>(value: T): Promise<T> {
  const txn = db.transaction('s', 'readwrite');
  const key = Math.random();
  txn.objectStore('s').put(value, key);
  return (await done(db.transaction('s', 'readwrite').objectStore('s').get(key))) as T;
}

const data = Uint8Array.from(Buffer.from('the message'));

function bytes(buffer: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(buffer));
}

beforeAll(async () => {
  bindCloneRealm({ ...(globalThis as unknown as Parameters<typeof bindCloneRealm>[0]), DOMException, CryptoKey: NodeCryptoKey });
  connect(new MemoryStore().transport);
  bindVault(startVault(7));
  wrapSubtle({ SubtleCrypto: TestSubtle, DOMException });
  const factory = new EngineFactory(INTERNAL) as unknown as IDBFactory;
  const request = factory.open('keys', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('s');
  db = await done(request);
});

describe('CryptoKeys in IndexedDB', () => {
  it('keeps a non-extractable AES key, still non-extractable and still the same key', async () => {
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    expect(key.extractable).toBe(false);
    await expect(subtle.exportKey('raw', key)).rejects.toThrow();
    const iv = new Uint8Array(12);
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

    const back = await roundTrip({ key });
    expect(back.key).toBeInstanceOf(NodeCryptoKey);
    expect(back.key).not.toBe(key);
    expect(back.key.extractable).toBe(false);
    expect(back.key.usages.sort()).toEqual(['decrypt', 'encrypt']);
    expect(back.key.algorithm).toEqual(key.algorithm);
    await expect(subtle.exportKey('raw', back.key)).rejects.toThrow();
    expect(bytes(await subtle.decrypt({ name: 'AES-GCM', iv }, back.key, sealed))).toEqual(Array.from(data));
  });

  it('keeps the private half of a pair, and a key stored twice in one value once', async () => {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    expect(pair.privateKey.extractable).toBe(false);
    expect(pair.publicKey.extractable).toBe(true);
    const back = await roundTrip({ pair, again: pair.privateKey });
    expect(back.again).toBe(back.pair.privateKey);
    const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, back.pair.privateKey, data);
    expect(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, data)).toBe(true);
  });

  it('keeps Ed25519, HMAC and RSA keys', async () => {
    const ed = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const hmac = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-384' }, false, ['sign']);
    const rsa = await subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    const back = await roundTrip({ ed: ed.privateKey, hmac, rsa: rsa.privateKey });

    const edSig = await subtle.sign('Ed25519', back.ed, data);
    expect(await subtle.verify('Ed25519', ed.publicKey, edSig, data)).toBe(true);
    expect(bytes(await subtle.sign('HMAC', back.hmac, data))).toEqual(bytes(await subtle.sign('HMAC', hmac, data)));
    expect((back.hmac.algorithm as HmacKeyAlgorithm).hash.name).toBe('SHA-384');
    const rsaSig = await subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, back.rsa, data);
    expect(await subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, rsa.publicKey, rsaSig, data)).toBe(true);
  });

  it('keeps imported, derived and unwrapped keys, PBKDF2 included', async () => {
    const password = await subtle.importKey('raw', new TextEncoder().encode('hunter2'), 'PBKDF2', false, ['deriveKey']);
    const back = await roundTrip(password);
    expect(back.extractable).toBe(false);
    const params = { name: 'PBKDF2', salt: new Uint8Array(16), iterations: 1000, hash: 'SHA-256' };
    const derived = await subtle.deriveKey(params, back, { name: 'AES-GCM', length: 128 }, false, ['encrypt']);
    const derivedBack = await roundTrip(derived);
    const fresh = await subtle.deriveKey(params, password, { name: 'AES-GCM', length: 128 }, true, ['encrypt']);
    const iv = new Uint8Array(12);
    expect(bytes(await subtle.encrypt({ name: 'AES-GCM', iv }, derivedBack, data)))
      .toEqual(bytes(await subtle.encrypt({ name: 'AES-GCM', iv }, fresh, data)));

    const wrapper = await subtle.generateKey({ name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey']);
    const wrapped = await subtle.wrapKey('raw', fresh, wrapper, 'AES-KW');
    const unwrapped = await subtle.unwrapKey('raw', wrapped, wrapper, 'AES-KW', 'AES-GCM', false, ['encrypt']);
    const unwrappedBack = await roundTrip(unwrapped);
    expect(unwrappedBack.extractable).toBe(false);
    expect(bytes(await subtle.encrypt({ name: 'AES-GCM', iv }, unwrappedBack, data)))
      .toEqual(bytes(await subtle.encrypt({ name: 'AES-GCM', iv }, fresh, data)));
  });

  it('keeps an extractable key extractable', async () => {
    const key = await subtle.generateKey({ name: 'AES-CBC', length: 128 }, true, ['encrypt']);
    const back = await roundTrip(key);
    expect(back.extractable).toBe(true);
    expect(bytes(await subtle.exportKey('raw', back) as ArrayBuffer)).toEqual(bytes(await subtle.exportKey('raw', key) as ArrayBuffer));
  });

  it('refuses a non-extractable key it did not see being made, at once', async () => {
    const unseen = await node.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt']);
    const txn = db.transaction('s', 'readwrite');
    expect(() => txn.objectStore('s').put(unseen, 'unseen')).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    txn.abort();
  });

  it('opens no sealed copy that was altered or sealed for another site', async () => {
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sealed = await seal(key);
    const altered = new Uint8Array(sealed.slice(0));
    altered[altered.length - 1] ^= 1;
    await expect(open(altered.buffer)).rejects.toMatchObject({ name: 'DataError' });

    bindVault(startVault(8));
    try {
      await expect(open(sealed.slice(0))).rejects.toMatchObject({ name: 'DataError' });
    } finally {
      bindVault(startVault(7));
    }
    expect((await open(sealed.slice(0))).extractable).toBe(false);
  });

  it('fails the read, not the engine, for a stored key that does not open', async () => {
    const key = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const txn = db.transaction('s', 'readwrite');
    txn.objectStore('s').put({ key }, 'moved');
    await done(db.transaction('s').objectStore('s').count());
    bindVault(startVault(9));
    try {
      await expect(done(db.transaction('s').objectStore('s').get('moved'))).rejects.toMatchObject({ name: 'DataError' });
    } finally {
      bindVault(startVault(7));
    }
  });
});

describe('the vault', () => {
  it('makes keys and nothing else, whoever asks', async () => {
    const port = startVault(7);
    const key = await node.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
    const locked = await node.importKey('raw', await node.exportKey('raw', key), 'AES-GCM', false, ['encrypt']);
    const answers: unknown[] = [];
    await new Promise<void>((resolve) => {
      port.onmessage = (event) => {
        answers.push(event.data);
        if (answers.length === 3) resolve();
      };
      port.postMessage({ id: 1, op: 'make', kind: 'exportKey', args: ['jwk', key] });
      port.postMessage({ id: 2, op: 'make', kind: 'encrypt', args: [{ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(4)] });
      port.postMessage({ id: 3, op: 'seal', key: locked });
    });
    port.close();
    for (const answer of answers) {
      expect(answer).toMatchObject({ error: expect.anything() });
      expect(answer).not.toHaveProperty('value');
      expect(answer).not.toHaveProperty('sealed');
    }
  });
});
