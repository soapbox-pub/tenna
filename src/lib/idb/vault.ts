/**
 * The vault: the one place a site's key material is ever read.
 *
 * Runs as a worker of Tenna's own (`vaultWorker.ts`, served at
 * `/.tenna/vault.js`), which no site code runs in, and holds the site's
 * sealing key — derived per site by `NsiteCryptoKeys.swift` from a master
 * key in the Keychain, and handed over by the realm that starts the vault
 * before any of the site's code has run. See `cryptoKeys.ts` for why.
 *
 * Requests arrive on ports, one per realm that stores keys:
 *
 * - `make`, with the `crypto.subtle` method and its arguments, asked for a
 *   non-extractable key: the key is made extractable here, read, sealed, and
 *   made again non-extractable from what was read. The answer is that key —
 *   or, for a key pair, the pair with that as its private key — and the
 *   sealed copy. Where the key cannot be made extractable, as PBKDF2 and
 *   HKDF keys cannot, `importKey` seals what it was given instead; anything
 *   else is made as asked and comes back unsealed.
 * - `seal`, with an extractable key: its sealed copy.
 * - `open`, with a sealed copy: a new key from it, as it was when sealed.
 * - `{ connect: port }`, on any port: take requests on that one too.
 *
 * The vault answers any request safely, whoever sends it: it never gives out
 * key material or its sealing key, only keys that are no more extractable
 * than they were made, and sealed copies. Its ports are not a secret the
 * page must keep — a worker's own code runs before its port arrives, and
 * could catch it — so nothing depends on only the engine using them.
 *
 * A sealed copy is a version byte, a twelve-byte IV, and AES-GCM of the key's
 * record — format, material, algorithm, extractable, usages — under the
 * sealing key. GCM authenticates it: a copy altered in any bit, or sealed for
 * another site, does not open.
 */

const VERSION = 1;

/** What `make` makes keys with, and nothing else. */
const MAKERS = new Set(['generateKey', 'importKey', 'deriveKey', 'unwrapKey']);
const AAD = new TextEncoder().encode('tenna-idb-crypto-key/1');

interface KeyRecord {
  format: KeyFormat;
  /** A JWK, or base64 bytes for the other formats. */
  data: JsonWebKey | string;
  algorithm: Record<string, unknown>;
  extractable: boolean;
  usages: KeyUsage[];
}

interface Request {
  id: number;
  op?: 'make' | 'seal' | 'open';
  kind?: 'generateKey' | 'importKey' | 'deriveKey' | 'unwrapKey';
  args?: unknown[];
  key?: CryptoKey;
  sealed?: ArrayBuffer;
  connect?: MessagePort;
}

type Subtle = SubtleCrypto;

function base64(bytes: ArrayBuffer): string {
  let text = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x2000) {
    text += String.fromCharCode.apply(null, view.subarray(i, i + 0x2000) as unknown as number[]);
  }
  return btoa(text);
}

function unbase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** What `importKey` needs to make a key like this one again. */
function importParams(algorithm: KeyAlgorithm): Record<string, unknown> {
  const a = algorithm as KeyAlgorithm & { hash?: { name: string }; namedCurve?: string; length?: number };
  const out: Record<string, unknown> = { name: a.name };
  if (a.hash) out.hash = { name: a.hash.name };
  if (a.namedCurve) out.namedCurve = a.namedCurve;
  if (a.name.toUpperCase() === 'HMAC' && a.length) out.length = a.length;
  return out;
}

/**
 * Serve requests with this sealing key, on `first` and on every port
 * connected after it. `subtle` is taken whole now, before anything else in
 * the realm can have changed it.
 */
export async function serveVault(keyBytes: Uint8Array<ArrayBuffer>, first: MessagePort, subtle: Subtle = crypto.subtle): Promise<void> {
  const call = <T>(name: string, ...args: unknown[]): Promise<T> =>
    Reflect.apply((subtle as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[name], subtle, args);
  const sealingKey = call<CryptoKey>('importKey', 'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  keyBytes.fill(0);

  async function sealRecord(record: KeyRecord): Promise<ArrayBuffer> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(record));
    const sealed = new Uint8Array(await call<ArrayBuffer>('encrypt', { name: 'AES-GCM', iv, additionalData: AAD }, await sealingKey, plain));
    plain.fill(0);
    const out = new Uint8Array(1 + 12 + sealed.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(sealed, 13);
    return out.buffer;
  }

  async function openRecord(sealed: ArrayBuffer): Promise<KeyRecord> {
    const bytes = new Uint8Array(sealed);
    if (bytes.length < 13 + 16 || bytes[0] !== VERSION) throw new DOMException('Not a sealed key.', 'DataError');
    const plain = await call<ArrayBuffer>('decrypt', { name: 'AES-GCM', iv: bytes.slice(1, 13), additionalData: AAD }, await sealingKey, bytes.slice(13));
    return JSON.parse(new TextDecoder().decode(plain)) as KeyRecord;
  }

  /** Read an extractable key into a record. */
  async function read(key: CryptoKey, extractable: boolean): Promise<KeyRecord> {
    const algorithm = importParams(key.algorithm);
    const usages = [...key.usages];
    try {
      return { format: 'jwk', data: await call<JsonWebKey>('exportKey', 'jwk', key), algorithm, extractable, usages };
    } catch {
      const format: KeyFormat = key.type === 'secret' ? 'raw' : key.type === 'private' ? 'pkcs8' : 'spki';
      return { format, data: base64(await call<ArrayBuffer>('exportKey', format, key)), algorithm, extractable, usages };
    }
  }

  function restore(record: KeyRecord, extractable = record.extractable): Promise<CryptoKey> {
    const data = typeof record.data === 'string' ? unbase64(record.data) : record.data;
    return call<CryptoKey>('importKey', record.format, data, record.algorithm, extractable, record.usages);
  }

  /** Make what a site asked for as non-extractable, with its sealed copy. */
  async function make(kind: NonNullable<Request['kind']>, args: unknown[]): Promise<{ value: unknown; sealed: ArrayBuffer | null }> {
    if (!MAKERS.has(kind) || !Array.isArray(args)) throw new TypeError('Not a way to make a key.');
    if (kind === 'importKey') {
      // What was given is the material; the key comes out exactly as asked.
      const [format, data] = args as [KeyFormat, BufferSource | JsonWebKey];
      const key = await call<CryptoKey>('importKey', ...args);
      const record: KeyRecord = {
        format,
        data: format === 'jwk' ? (data as JsonWebKey) : base64(copy(data as BufferSource)),
        algorithm: importParams(key.algorithm),
        extractable: false,
        usages: [...key.usages],
      };
      return { value: key, sealed: await sealRecord(record) };
    }
    const at = kind === 'generateKey' ? 1 : kind === 'deriveKey' ? 3 : 5;
    const readable = args.slice();
    readable[at] = true;
    let made: CryptoKey | CryptoKeyPair;
    try {
      made = await call<CryptoKey | CryptoKeyPair>(kind, ...readable);
    } catch {
      // Not one that can be made extractable: as asked, and unsealed.
      return { value: await call(kind, ...args), sealed: null };
    }
    const pair = 'privateKey' in made;
    const secret = pair ? (made as CryptoKeyPair).privateKey : (made as CryptoKey);
    const record = await read(secret, false);
    const locked = await restore(record);
    const sealed = await sealRecord(record);
    const value = pair ? { publicKey: (made as CryptoKeyPair).publicKey, privateKey: locked } : locked;
    return { value, sealed };
  }

  function listen(port: MessagePort): void {
    port.onmessage = async (event) => {
      const request = event.data as Request;
      if (request.connect) {
        listen(request.connect);
        return;
      }
      try {
        switch (request.op) {
          case 'make': {
            const { value, sealed } = await make(request.kind!, request.args!);
            port.postMessage({ id: request.id, value, sealed });
            break;
          }
          case 'seal':
            port.postMessage({ id: request.id, sealed: await sealRecord(await read(request.key!, true)) });
            break;
          case 'open':
            port.postMessage({ id: request.id, value: await restore(await openRecord(request.sealed!)) });
            break;
        }
      } catch (error) {
        const e = error as Error;
        port.postMessage({
          id: request.id,
          error: { name: String(e?.name ?? 'OperationError'), message: String(e?.message ?? e), type: e instanceof TypeError },
        });
      }
    };
  }

  listen(first);
}

function copy(source: BufferSource): ArrayBuffer {
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  return (source as ArrayBuffer).slice(0);
}
