/**
 * CryptoKeys in a site's IndexedDB, without their secrets ever in the page.
 *
 * WebKit stores a non-extractable key by reaching into it natively, which
 * script cannot do. So Tenna sees every key being made instead: the realm's
 * `crypto.subtle` is wrapped before a site's code runs, and a request for a
 * non-extractable key is carried out by the **vault** (`vault.ts`) — a worker
 * of Tenna's that no site code runs in. The vault makes the key extractable,
 * reads it, seals what it read with the site's sealing key, and hands back a
 * real non-extractable key made from it, and the sealed copy.
 *
 * The page holds only those two: a key that will not give up its secret, and
 * a sealed blob it cannot open. Storing the key stores the blob; reading it
 * back asks the vault to open the blob into a new key. Nothing in the page —
 * which a site can instrument by replacing any built-in it likes — ever holds
 * key material, and the sealing key exists only in the vault. A blob that has
 * been tampered with fails to open.
 *
 * A key made in some other realm and passed in — a worker's key posted to the
 * page — was not seen being made, and cannot be stored unless it is
 * extractable.
 */

/** A vault's answer to a request. */
interface Answer {
  id: number;
  value?: unknown;
  sealed?: ArrayBuffer | null;
  error?: { name: string; message: string; type: boolean };
}

interface Vault {
  port: MessagePort;
  /** The vault's worker, when this realm started it: held so it lives. */
  worker?: Worker;
  next: number;
  pending: Map<number, [(answer: Answer) => void, (error: unknown) => void]>;
}

let vault: Vault | null = null;

/**
 * Settles once a worker's vault port has come, or it is known none will. A
 * worker gets its port in the first message its starter sends, after its own
 * top-level code has already run; until then a request waits rather than
 * slipping past the vault.
 */
let arriving: Promise<void> | null = null;

/** A vault port is on its way: call the result with it, or with null. */
export function expectVault(): (port: MessagePort | null) => void {
  let settle!: () => void;
  arriving = new Promise((resolve) => {
    settle = resolve;
  });
  return (port) => {
    if (port) bindVault(port);
    arriving = null;
    settle();
  };
}

/**
 * The sealed copy of every non-extractable key this realm has seen made or
 * read back. A WeakMap's own methods, taken now: a site that replaces
 * `WeakMap.prototype.set` later sees nothing through these.
 */
const sealedKeys = new WeakMap<CryptoKey, ArrayBuffer>();
const weakGet = WeakMap.prototype.get;
const weakSet = WeakMap.prototype.set;
const apply = Reflect.apply;

function sealedOf(key: CryptoKey): ArrayBuffer | undefined {
  return apply(weakGet, sealedKeys, [key]) as ArrayBuffer | undefined;
}

function remember(key: CryptoKey, sealed: ArrayBuffer): void {
  apply(weakSet, sealedKeys, [key, sealed]);
}

/** Talk to the vault on the other end of this port. */
export function bindVault(port: MessagePort, worker?: Worker): void {
  const v: Vault = { port, worker, next: 1, pending: new Map() };
  port.onmessage = (event) => {
    const answer = event.data as Answer;
    const waiter = v.pending.get(answer.id);
    v.pending.delete(answer.id);
    waiter?.[0](answer);
  };
  vault = v;
}

/** Whether this realm has a vault, or will have one, and so can store CryptoKeys. */
export function hasVault(): boolean {
  return vault !== null || arriving !== null;
}

/**
 * A new port to this realm's vault, for a worker this realm starts. The
 * vault takes the other end; the worker gets this one.
 */
export function vaultPort(): MessagePort | null {
  if (!vault) return null;
  // A worker started before this realm's own port came gets none; it is the
  // rare worker a worker starts in its first moment.
  const channel = new MessageChannel();
  vault.port.postMessage({ connect: channel.port2 }, [channel.port2]);
  return channel.port1;
}

/**
 * Ask the vault for something. Throws at once if the request cannot be sent
 * — a value that cannot be cloned — and rejects if there turns out to be no
 * vault.
 */
function ask(request: Record<string, unknown>): Promise<Answer> {
  if (!vault) {
    if (!arriving) return Promise.reject(new DOMException('This realm cannot keep keys.', 'DataCloneError'));
    // Checked now, so an argument that cannot be sent still falls back at once.
    structuredClone(request.args ?? null);
    return arriving.then(() => ask(request));
  }
  const v = vault;
  const id = v.next++;
  const answered = new Promise<Answer>((resolve, reject) => v.pending.set(id, [resolve, reject]));
  try {
    v.port.postMessage({ ...request, id });
  } catch (error) {
    v.pending.delete(id);
    throw error;
  }
  return answered;
}

function failure(answer: Answer, realm: { DOMException: typeof DOMException }): Error {
  const { name, message, type } = answer.error!;
  if (type) return new TypeError(message);
  return new realm.DOMException(message, name);
}

/**
 * Whether a key can be stored: one this realm has the sealed copy of, or one
 * the vault can read because it is extractable. Synchronous, as `put()` must
 * decide.
 */
export function storable(key: CryptoKey, extractable: boolean): boolean {
  return hasVault() && (sealedOf(key) !== undefined || extractable);
}

/** The sealed copy of a key, sealing an extractable one first. */
export async function seal(key: CryptoKey): Promise<ArrayBuffer> {
  const known = sealedOf(key);
  if (known) return known;
  const answer = await ask({ op: 'seal', key });
  if (answer.error) throw new DOMException(answer.error.message, 'DataCloneError');
  return answer.sealed!;
}

/** A new key from a sealed copy. Rejects with a DataError for a copy that does not open. */
export async function open(sealed: ArrayBuffer): Promise<CryptoKey> {
  if (!hasVault()) throw new DOMException('This realm cannot read stored keys.', 'DataError');
  const answer = await ask({ op: 'open', sealed });
  if (answer.error) throw new DOMException(`A stored key could not be read: ${answer.error.message}`, 'DataError');
  const key = answer.value as CryptoKey;
  remember(key, sealed);
  return key;
}

/** Where each wrapped operation takes its `extractable` argument. */
const EXTRACTABLE_AT: Record<string, number> = { generateKey: 1, importKey: 3, deriveKey: 3, unwrapKey: 5 };

/**
 * Wrap the realm's `crypto.subtle` so that the vault makes every
 * non-extractable key. An extractable one is made as before: the page may
 * read it anyway, and the vault reads it when it is stored.
 *
 * Should the vault be unable to take a request — an algorithm dictionary it
 * cannot be sent — the platform makes the key as it always would, and it is
 * one that cannot be stored.
 */
export function wrapSubtle(scope: { SubtleCrypto?: { prototype: object }; DOMException: typeof DOMException }): void {
  const proto = scope.SubtleCrypto?.prototype as Record<string, unknown> | undefined;
  if (!proto) return;
  for (const name of Object.keys(EXTRACTABLE_AT)) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    const at = EXTRACTABLE_AT[name];
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (!hasVault() || args.length <= at || args[at]) return apply(original, this, args);
      let answered: Promise<Answer>;
      try {
        answered = ask({ op: 'make', kind: name, args });
      } catch {
        return apply(original, this, args);
      }
      return answered.then((answer) => {
        if (answer.error) throw failure(answer, scope);
        const value = answer.value as CryptoKey | CryptoKeyPair;
        if (answer.sealed) {
          const secret = 'privateKey' in (value as object) ? (value as CryptoKeyPair).privateKey : (value as CryptoKey);
          remember(secret, answer.sealed);
        }
        return value;
      });
    };
    Object.defineProperty(wrapped, 'name', { value: name });
    Object.defineProperty(wrapped, 'length', { value: (original as (...a: unknown[]) => unknown).length });
    Object.defineProperty(proto, name, { value: wrapped, writable: true, enumerable: true, configurable: true });
  }
}
