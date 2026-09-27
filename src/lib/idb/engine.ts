/**
 * IndexedDB, over a store that only keeps records.
 *
 * Everything IndexedDB decides synchronously is decided here: key
 * conversion, key paths, cloning, the schema a connection sees, which
 * transaction may run, and when a transaction is active. Records live in the
 * store at the other end of the realm's transport (`protocol.ts`).
 *
 * A transaction's requests stream to the store without waiting for each
 * other: every request made in one turn of the event loop goes out as one
 * message, and the answers come back in order. A request whose op cannot be
 * written yet — it waits on a Blob's bytes or on the key generator — holds
 * back the requests behind it, so the store always runs them in the order
 * they were made. Each answer is then delivered as its own task, which is
 * what makes the transaction active for exactly the span of its handlers and
 * the microtasks they leave.
 */

/* eslint-disable prefer-rest-params -- WebIDL tells an argument passed as
   undefined from one left out, and only `arguments.length` can. */

import { canInjectKey, convertKeyPath, extractKey, injectKey, isValidKeyPath, type KeyPath } from './keyPath';
import { arrayMembers, keyToValue, toKey } from './keys';
import { complete, completeNow, deserialize, deserializePending, serialize, type Serialized } from './clone';
import { beforeNextTask, dispatch, defineHandlers, IDBVersionChangeEvent, makeEvent, noteActivity, onCheckpoint, queueTask, registerTarget } from './events';
import { INTERNAL, IDBKeyRange, isPotentiallyValidKeyRange, keyWireRange, toRange } from './keyRange';
import { DOMStringList, nameList, webidl } from './domStringList';
import { isWireError, type Schema, type Transport, type WireRange } from './protocol';
import { decode, encode, type Wire } from './wire';

// ---------------------------------------------------------------------------
// Errors and argument conversions

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

function needArgs(count: number, args: IArguments, what: string): void {
  if (args.length < count) throw new TypeError(`${what} needs ${count} argument${count === 1 ? '' : 's'}.`);
}

/** WebIDL `DOMString`: ToString, which a Symbol refuses. */
function domString(value: unknown): string {
  return `${value as string}`;
}

/** WebIDL `[EnforceRange] unsigned long`. */
function enforceUnsignedLong(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError('The number is out of range.');
  const t = Math.trunc(n);
  if (t < 0 || t > 0xffffffff) throw new TypeError('The number is out of range.');
  return t;
}

/** WebIDL `[EnforceRange] unsigned long long`. */
function enforceUnsignedLongLong(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError('The number is out of range.');
  const t = Math.trunc(n);
  if (t < 0 || t > Number.MAX_SAFE_INTEGER) throw new TypeError('The number is out of range.');
  return t;
}

type Direction = 'next' | 'nextunique' | 'prev' | 'prevunique';

function toDirection(value: unknown): Direction {
  const d = value === undefined ? 'next' : domString(value);
  if (d !== 'next' && d !== 'nextunique' && d !== 'prev' && d !== 'prevunique') {
    throw new TypeError(`"${d}" is not a cursor direction.`);
  }
  return d;
}

const WIRE_DIRECTION: Record<Direction, string> = { next: 'n', nextunique: 'nu', prev: 'p', prevunique: 'pu' };


// ---------------------------------------------------------------------------
// The realm: its transport, its id, and the databases it has open

interface Realm {
  id: string;
  send(message: Wire): Promise<Wire>;
  nextTransaction: number;
  /** Open connections by database name. */
  connections: Map<string, Set<Connection>>;
  schedulers: Map<string, Scheduler>;
  /** Open and delete requests queue per database name. */
  queues: Map<string, Promise<void>>;
  waiting: boolean;
  /** Settles once any one-time work before the first request is done. */
  ready: Promise<void>;
}

let realm: Realm;

/** Bind the engine to the transport it talks to. */
export function connect(transport: Transport, ready: Promise<void> = Promise.resolve()): void {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  realm = {
    id,
    send: async (message) => decode(await transport(encode(message))),
    nextTransaction: 1,
    connections: new Map(),
    schedulers: new Map(),
    queues: new Map(),
    waiting: false,
    ready,
  };
}

/** Tell the store this realm is going away. */
export function disconnect(): void {
  void realm.send(['bye', realm.id]).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Schema, as a connection holds it

interface StoreMeta {
  id: number;
  name: string;
  keyPath: KeyPath;
  /** The value `keyPath` returns, the same object every time. */
  keyPathValue: unknown;
  autoIncrement: boolean;
  indexes: Map<string, IndexMeta>;
  deleted: boolean;
  /** The upgrade that created it, whose abort leaves its name alone. */
  createdIn?: TxnState;
}

interface IndexMeta {
  id: number;
  name: string;
  keyPath: string | string[];
  keyPathValue: unknown;
  unique: boolean;
  multiEntry: boolean;
  store: StoreMeta;
  deleted: boolean;
  createdIn?: TxnState;
}

function keyPathJson(path: KeyPath): string | null {
  return path === null ? null : JSON.stringify(path);
}

function parseKeyPath(json: string | null): KeyPath {
  return json === null ? null : (JSON.parse(json) as KeyPath);
}

function keyPathValue(path: KeyPath): unknown {
  return Array.isArray(path) ? path.slice() : path;
}

/** Undo steps for an upgrade transaction's schema changes. */
type SchemaUndo = () => void;

// ---------------------------------------------------------------------------
// Connections

class Connection {
  readonly transactions = new Set<TxnState>();
  readonly stores = new Map<string, StoreMeta>();
  closePending = false;
  closed = false;
  upgrade: TxnState | null = null;
  nextId = 1;
  readonly api: IDBDatabase;
  private readonly closeWaiters: (() => void)[] = [];

  constructor(readonly name: string, public version: number, public incarnation: string, schema: Schema | null) {
    if (schema) this.load(schema);
    this.api = new IDBDatabase(INTERNAL, this);
  }

  load(schema: Schema): void {
    this.stores.clear();
    for (const [id, name, keyPath, autoIncrement, indexes] of schema[2]) {
      const path = parseKeyPath(keyPath);
      const meta: StoreMeta = {
        id,
        name,
        keyPath: path,
        keyPathValue: keyPathValue(path),
        autoIncrement: !!autoIncrement,
        indexes: new Map(),
        deleted: false,
      };
      this.nextId = Math.max(this.nextId, id + 1);
      for (const [indexId, indexName, indexPath, unique, multiEntry] of indexes) {
        const p = parseKeyPath(indexPath) as string | string[];
        meta.indexes.set(indexName, {
          id: indexId,
          name: indexName,
          keyPath: p,
          keyPathValue: keyPathValue(p),
          unique: !!unique,
          multiEntry: !!multiEntry,
          store: meta,
          deleted: false,
        });
        this.nextId = Math.max(this.nextId, indexId + 1);
      }
      this.stores.set(name, meta);
    }
  }

  /** Register with the realm, so version changes can find it. */
  register(): void {
    let set = realm.connections.get(this.name);
    if (!set) {
      set = new Set();
      realm.connections.set(this.name, set);
    }
    set.add(this);
    listen();
  }

  /** Close once every transaction has finished. */
  maybeClose(): void {
    if (this.closed || !this.closePending || this.transactions.size) return;
    this.closed = true;
    realm.connections.get(this.name)?.delete(this);
    for (const waiter of this.closeWaiters.splice(0)) waiter();
  }

  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  /**
   * The spec's "close a database connection" with forced set: abort what is
   * running, and say so with a `close` event.
   */
  forceClose(): void {
    if (this.closed) return;
    this.closePending = true;
    for (const txn of [...this.transactions]) txn.abort(domError('AbortError', 'The connection was closed.'));
    const wasClosed = this.closed;
    this.maybeClose();
    const fire = () => {
      void dispatch(this.api, makeEvent('close', false, false));
    };
    if (wasClosed || this.closed) queueTask(fire);
    else void this.whenClosed().then(() => queueTask(fire));
  }
}

/**
 * Keep one `wait` outstanding while any connection is open, and act on what
 * it reports: another realm upgraded or deleted a database this one has open.
 */
function listen(): void {
  if (realm.waiting) return;
  realm.waiting = true;
  const loop = async () => {
    while ([...realm.connections.values()].some((set) => set.size)) {
      let notices: Wire;
      try {
        notices = await realm.send(['wait', realm.id]);
      } catch {
        break;
      }
      for (const notice of notices as Wire[][]) {
        const [name, version, incarnation] = notice as [string, number, string];
        for (const conn of [...(realm.connections.get(name) ?? [])]) {
          if (conn.closePending) continue;
          if (conn.version === version && conn.incarnation === incarnation) continue;
          queueTask(async () => {
            if (conn.closePending) return;
            await dispatch(conn.api, new IDBVersionChangeEvent('versionchange', { oldVersion: conn.version, newVersion: version || null }));
            // The change has already happened elsewhere and cannot wait for
            // this connection: one that did not close itself is closed.
            if (!conn.closePending) conn.forceClose();
          });
        }
      }
    }
    realm.waiting = false;
  };
  void loop();
}

// ---------------------------------------------------------------------------
// Scheduling: which transactions may run

class Scheduler {
  private readonly queue: TxnState[] = [];

  add(txn: TxnState): void {
    this.queue.push(txn);
    this.run();
  }

  done(txn: TxnState): void {
    const at = this.queue.indexOf(txn);
    if (at >= 0) this.queue.splice(at, 1);
    this.run();
  }

  private run(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const txn = this.queue[i];
      if (txn.started) continue;
      let blocked = false;
      for (let j = 0; j < i && !blocked; j++) {
        const earlier = this.queue[j];
        if (earlier.mode === 'versionchange' || txn.mode === 'versionchange') {
          blocked = true;
        } else if (earlier.mode === 'readwrite' || txn.mode === 'readwrite') {
          blocked = earlier.scope.some((name) => txn.scope.includes(name));
        }
      }
      if (!blocked) txn.start();
    }
  }
}

function schedulerFor(name: string): Scheduler {
  let scheduler = realm.schedulers.get(name);
  if (!scheduler) {
    scheduler = new Scheduler();
    realm.schedulers.set(name, scheduler);
  }
  return scheduler;
}

// ---------------------------------------------------------------------------
// Transactions

type Outcome = { result: unknown } | { error: DOMException };

/**
 * One op in a transaction's stream. A request's entries fire its events; an
 * entry without a request is the engine's own bookkeeping.
 */
interface Entry {
  request: IDBRequest | null;
  /** What goes to the store; null while it waits to be written. */
  op: Wire[] | null;
  /** Answered here, without the store. */
  local: boolean;
  answered: boolean;
  answer: Wire;
  /** Turn the store's answer into the request's outcome. */
  finish: (answer: Wire) => Outcome;
  /** For entries without a request: act on the answer in turn. */
  then?: (answer: Wire) => void;
}

type Mode = 'readonly' | 'readwrite' | 'versionchange';

/**
 * Transactions made since the last microtask checkpoint, which go inactive
 * at the next one: the spec's "cleanup Indexed Database transactions". The
 * engine sees the checkpoints after the listeners it calls; any other ends
 * with its task, which `deactivateSoon` catches.
 */
const created = new Set<TxnState>();

onCheckpoint(() => {
  for (const txn of created) if (txn.state === 'active') txn.state = 'inactive';
  created.clear();
});

class TxnState {
  readonly id: string;
  readonly api: IDBTransaction;
  state: 'active' | 'inactive' | 'committing' | 'finished' = 'active';
  started = false;
  begun = false;
  aborted = false;
  error: DOMException | null = null;
  /** Entries whose events have not been fired, in order. */
  readonly entries: Entry[] = [];
  /** Entries not yet sent, in order. */
  private readonly unsent: Entry[] = [];
  private flushQueued = false;
  private taskQueued = false;
  /** An event is being dispatched; the next one waits. */
  private firing = false;
  readonly handles = new Map<StoreMeta, IDBObjectStore>();
  /** Bumped by every write, so a cursor knows when what it read ahead is stale. */
  writes = 0;
  readonly undo: SchemaUndo[] = [];
  /** Called when the transaction has finished, completed or not. */
  onFinish: (() => void) | null = null;
  private commitSent = false;

  constructor(readonly conn: Connection, readonly mode: Mode, readonly scope: string[], readonly durability: string, id?: string) {
    this.id = id ?? String(realm.nextTransaction++);
    this.api = new IDBTransaction(INTERNAL, this);
    conn.transactions.add(this);
    // A transaction is active until the task that made it ends. An upgrade
    // is made active by the open that runs it instead.
    if (mode !== 'versionchange') {
      created.add(this);
      this.deactivateSoon();
      this.queueTask();
    }
  }

  /** Go inactive before the next task, if still active then. */
  deactivateSoon(): void {
    beforeNextTask(() => {
      if (this.state === 'active') this.state = 'inactive';
    });
  }

  get active(): boolean {
    return this.state === 'active';
  }

  /** Read through a getter: a dispatch can finish the transaction under a narrowed `state`. */
  get finished(): boolean {
    return this.state === 'finished';
  }

  start(): void {
    this.started = true;
    this.queueFlush();
    this.queueTask();
  }

  // -- Entries ---------------------------------------------------------------

  /** Add a request's entry to the stream. */
  add(entry: Entry): void {
    this.entries.push(entry);
    if (!entry.local) this.unsent.push(entry);
    if (entry.op && isWrite(entry.op)) this.writes++;
    this.queueFlush();
  }

  /** An entry for one op, whose answer becomes the request's outcome. */
  request(request: IDBRequest | null, op: Wire[] | null, finish: (answer: Wire) => Outcome): Entry {
    const entry: Entry = { request, op, local: false, answered: false, answer: null, finish };
    this.add(entry);
    return entry;
  }

  /** An entry answered here, its outcome worked out when its turn comes. */
  local(request: IDBRequest, finish: () => Outcome): Entry {
    const entry: Entry = { request, op: null, local: true, answered: true, answer: null, finish };
    this.add(entry);
    this.queueTask();
    return entry;
  }

  /** An op of the engine's own, acted on when its turn comes. */
  system(op: Wire[] | null, then?: (answer: Wire) => void): Entry {
    const entry: Entry = { request: null, op, local: false, answered: false, answer: null, finish: () => ({ result: undefined }), then };
    this.add(entry);
    return entry;
  }

  /** An entry's op is ready to go. */
  ready(entry: Entry, op: Wire[]): void {
    entry.op = op;
    this.queueFlush();
  }

  /** An entry that was waiting will not go to the store after all. */
  settle(entry: Entry, outcome: Outcome): void {
    entry.local = true;
    entry.answered = true;
    entry.finish = () => outcome;
    const at = this.unsent.indexOf(entry);
    if (at >= 0) this.unsent.splice(at, 1);
    this.queueFlush();
    this.queueTask();
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Send every entry that is ready, up to the first that is not. */
  private flush(): void {
    if (!this.started || this.aborted) return;
    const batch: Entry[] = [];
    while (this.unsent.length) {
      const entry = this.unsent[0];
      if (entry.op === null) break;
      batch.push(entry);
      this.unsent.shift();
    }
    if (!batch.length) return;
    const begin = this.begun ? null : this.beginSpec();
    this.begun = true;
    const message: Wire = ['tx', realm.id, this.id, begin, batch.map((e) => e.op!)];
    realm.send(message).then(
      (answer) => {
        const results = answer as Wire[];
        if (begin && results[0] === 'stale') {
          this.conn.forceClose();
          return;
        }
        for (let i = 0; i < batch.length; i++) {
          const entry = batch[i];
          entry.answered = true;
          entry.answer = results[i + 1];
          if (!entry.request && entry.then && !this.inTurn(entry)) {
            // Bookkeeping that later ops wait on acts as soon as it lands.
            const then = entry.then;
            entry.then = undefined;
            then(entry.answer);
          }
        }
        this.queueTask();
      },
      (error) => {
        this.abort(domError('UnknownError', `The database could not be reached: ${String(error)}`));
      },
    );
  }

  /** Whether an entry's answer must wait for its turn to be acted on. */
  private inTurn(entry: Entry): boolean {
    return entry.op !== null && (entry.op[0] === 'ia' || entry.op[0] === 'commit');
  }

  private beginSpec(): Wire {
    const m = this.mode === 'readonly' ? 'r' : 'w';
    return [m, this.conn.name, this.conn.version, this.conn.incarnation];
  }

  // -- Delivering answers, one task at a time --------------------------------

  queueTask(): void {
    if (this.taskQueued) return;
    this.taskQueued = true;
    queueTask(() => {
      this.taskQueued = false;
      this.turn();
    });
  }

  /**
   * One task's worth of work: the transaction goes inactive, then the next
   * answered request gets its event, or, when there is nothing left to wait
   * on, the transaction commits.
   */
  private turn(): void {
    if (this.firing) return;
    if (this.state === 'active') this.state = 'inactive';
    if (this.state === 'finished') return;
    while (this.entries.length) {
      const head = this.entries[0];
      if (!head.answered) return;
      this.entries.shift();
      if (!head.request) {
        const then = head.then;
        head.then = undefined;
        if (isWireError(head.answer)) {
          if (head.op?.[0] !== 'commit') {
            this.abort(domError(head.answer[1], head.answer[2]));
            return;
          }
        }
        then?.(head.answer);
        if (this.finished) return;
        continue;
      }
      this.firing = true;
      void this.fire(head).finally(() => {
        this.firing = false;
        // The dispatch ended with a checkpoint; the spec's transaction goes
        // inactive right after it, before this task is over.
        if (this.state === 'active') this.state = 'inactive';
        this.queueTask();
      });
      return;
    }
    if (this.started && (this.state === 'inactive' || this.state === 'committing')) this.commit();
  }

  /** Fire a request's success or error event, with the transaction active. */
  private async fire(entry: Entry): Promise<void> {
    const request = entry.request!;
    const answer = entry.answer;
    let outcome: Outcome;
    if (isWireError(answer)) {
      outcome = { error: domError(answer[1], answer[2]) };
    } else {
      // A value that cannot be read back — a type this realm cannot make —
      // fails its request rather than the engine.
      try {
        outcome = entry.finish(answer);
      } catch (error) {
        outcome = { error: error instanceof DOMException ? error : domError('DataCloneError', String(error)) };
      }
    }
    const r = requestState(request);
    r.done = true;
    if (this.state !== 'committing') {
      this.state = 'active';
      // Registered before the handlers run, so it comes ahead of any timer
      // they set.
      this.deactivateSoon();
    }
    if ('error' in outcome) {
      r.result = undefined;
      r.error = outcome.error;
      const { threw, canceled } = await dispatch(request, makeEvent('error', true, true));
      if (this.finished) return;
      // After an explicit commit, a throwing handler no longer aborts.
      if (threw && this.state !== 'committing') this.abort(domError('AbortError', 'A request\'s error handler threw.'));
      else if (!canceled) this.abort(outcome.error);
    } else {
      r.result = outcome.result;
      r.error = null;
      const { threw } = await dispatch(request, makeEvent('success', false, false));
      if (threw && !this.finished && this.state !== 'committing') this.abort(domError('AbortError', 'A request\'s success handler threw.'));
    }
  }

  // -- Ending ----------------------------------------------------------------

  /** Everything has been answered: write down the generators and commit. */
  private commit(): void {
    if (this.commitSent) return;
    this.state = 'committing';
    this.commitSent = true;
    if (!this.begun && !this.unsent.length) {
      this.complete();
      return;
    }
    this.system(['commit'], (answer) => {
      if (isWireError(answer)) {
        this.commitSent = false;
        this.abort(domError(answer[1], answer[2]));
      } else {
        this.complete();
      }
    });
  }

  /** The spec's "commit" finishing: fire `complete`. */
  private complete(): void {
    this.state = 'finished';
    queueTask(async () => {
      if (this.conn.upgrade === this) this.conn.upgrade = null;
      await dispatch(this.api, makeEvent('complete', false, false));
      this.cleanUp();
    });
  }

  /** The spec's "abort a transaction". */
  abort(error: DOMException | null): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    this.aborted = true;
    this.error = error;
    if (this.begun) {
      void realm.send(['tx', realm.id, this.id, null, [['abort']]]).catch(() => undefined);
    }
    this.unsent.length = 0;
    if (this.mode === 'versionchange') {
      for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]();
      this.undo.length = 0;
    }
    const pending = this.entries.splice(0).filter((e) => e.request);
    queueTask(async () => {
      for (const entry of pending) {
        const r = requestState(entry.request!);
        r.done = true;
        r.result = undefined;
        r.error = domError('AbortError', 'The transaction was aborted.');
        await dispatch(entry.request!, makeEvent('error', true, true));
      }
      if (this.conn.upgrade === this) this.conn.upgrade = null;
      await dispatch(this.api, makeEvent('abort', true, false));
      this.cleanUp();
    });
  }

  private cleanUp(): void {
    this.conn.transactions.delete(this);
    if (this.mode !== 'versionchange') schedulerFor(this.conn.name).done(this);
    const finish = this.onFinish;
    this.onFinish = null;
    finish?.();
    this.conn.maybeClose();
  }

  /** The object store handle for a store, the same one every time. */
  handle(meta: StoreMeta): IDBObjectStore {
    let handle = this.handles.get(meta);
    if (!handle) {
      handle = new IDBObjectStore(INTERNAL, meta, this);
      this.handles.set(meta, handle);
    }
    return handle;
  }

  scopeNames(): string[] {
    if (this.mode === 'versionchange') return [...this.conn.stores.keys()];
    return this.scope;
  }
}

function isWrite(op: Wire[]): boolean {
  switch (op[0]) {
    case 'put':
    case 'del':
    case 'clr':
    case 'ds':
    case 'ia':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Requests

interface RequestState {
  source: unknown;
  txn: TxnState | null;
  done: boolean;
  result: unknown;
  error: DOMException | null;
}

let requestState: (request: IDBRequest) => RequestState;

const requests = new WeakSet<object>();
const openRequests = new WeakSet<object>();

export class IDBRequest extends EventTarget {
  #s: RequestState;

  static {
    requestState = (request) => request.#s;
  }

  constructor(token: symbol, source: unknown, txn: TxnState | null) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    super();
    this.#s = { source, txn, done: false, result: undefined, error: null };
    requests.add(this);
    registerTarget(this, () => this.#s.txn?.api ?? null);
  }

  get result(): unknown {
    if (!this.#s.done) throw domError('InvalidStateError', 'The request has not finished.');
    return this.#s.result;
  }

  get error(): DOMException | null {
    if (!this.#s.done) throw domError('InvalidStateError', 'The request has not finished.');
    return this.#s.error;
  }

  get source(): unknown {
    return this.#s.source;
  }

  get transaction(): IDBTransaction | null {
    return this.#s.txn?.api ?? null;
  }

  get readyState(): IDBRequestReadyState {
    return this.#s.done ? 'done' : 'pending';
  }
}

defineHandlers(IDBRequest.prototype, ['success', 'error'], (v) => requests.has(v as object));

export class IDBOpenDBRequest extends IDBRequest {
  constructor(token: symbol) {
    super(token, null, null);
    openRequests.add(this);
  }
}

defineHandlers(IDBOpenDBRequest.prototype, ['blocked', 'upgradeneeded'], (v) => openRequests.has(v as object));

export class IDBRecord {
  #key: unknown;
  #primaryKey: unknown;
  #value: unknown;

  constructor(token: symbol, key: unknown, primaryKey: unknown, value: unknown) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#key = key;
    this.#primaryKey = primaryKey;
    this.#value = value;
  }

  get key(): unknown {
    return this.#key;
  }

  get primaryKey(): unknown {
    return this.#primaryKey;
  }

  get value(): unknown {
    return this.#value;
  }
}

// ---------------------------------------------------------------------------
// IDBTransaction

let txnState: (txn: IDBTransaction) => TxnState;

const transactions = new WeakSet<object>();

export class IDBTransaction extends EventTarget {
  #t: TxnState;

  static {
    txnState = (txn) => txn.#t;
  }

  constructor(token: symbol, t: TxnState) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    super();
    this.#t = t;
    transactions.add(this);
    registerTarget(this, () => this.#t.conn.api);
  }

  get objectStoreNames(): DOMStringList {
    return nameList(this.#t.scopeNames());
  }

  get mode(): IDBTransactionMode {
    return this.#t.mode;
  }

  get durability(): IDBTransactionDurability {
    return this.#t.durability as IDBTransactionDurability;
  }

  get db(): IDBDatabase {
    return this.#t.conn.api;
  }

  get error(): DOMException | null {
    return this.#t.error;
  }

  objectStore(name: string): IDBObjectStore {
    needArgs(1, arguments, 'objectStore');
    name = domString(name);
    const t = this.#t;
    if (t.state === 'finished') throw domError('InvalidStateError', 'The transaction has finished.');
    const meta = t.conn.stores.get(name);
    if (!meta || (t.mode !== 'versionchange' && !t.scope.includes(name))) {
      throw domError('NotFoundError', `No object store named "${name}" is in this transaction's scope.`);
    }
    return t.handle(meta);
  }

  commit(): void {
    const t = this.#t;
    if (t.state !== 'active') throw domError('InvalidStateError', 'The transaction is not active.');
    t.state = 'committing';
    t.queueTask();
  }

  abort(): void {
    const t = this.#t;
    if (t.state === 'committing' || t.state === 'finished') {
      throw domError('InvalidStateError', 'The transaction has already committed or aborted.');
    }
    t.abort(null);
  }
}

defineHandlers(IDBTransaction.prototype, ['abort', 'complete', 'error'], (v) => transactions.has(v as object));

// ---------------------------------------------------------------------------
// IDBDatabase

let connectionOf: (db: IDBDatabase) => Connection;

const databases = new WeakSet<object>();

export class IDBDatabase extends EventTarget {
  #c: Connection;

  static {
    connectionOf = (db) => db.#c;
  }

  constructor(token: symbol, c: Connection) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    super();
    this.#c = c;
    databases.add(this);
    registerTarget(this, () => null);
  }

  get name(): string {
    return this.#c.name;
  }

  get version(): number {
    return this.#c.version;
  }

  get objectStoreNames(): DOMStringList {
    return nameList(this.#c.stores.keys());
  }

  transaction(storeNames: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions): IDBTransaction {
    needArgs(1, arguments, 'transaction');
    const c = this.#c;
    const names = new Set(typeof storeNames === 'string' ? [storeNames] : convertNames(storeNames));
    const m = mode === undefined ? 'readonly' : domString(mode);
    if (m !== 'readonly' && m !== 'readwrite' && m !== 'versionchange') {
      throw new TypeError(`"${m}" is not a transaction mode.`);
    }
    let durability = 'default';
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw new TypeError('The options are not an object.');
      const d = options.durability;
      if (d !== undefined) {
        durability = domString(d);
        if (durability !== 'default' && durability !== 'strict' && durability !== 'relaxed') {
          throw new TypeError(`"${durability}" is not a durability.`);
        }
      }
    }
    if (c.upgrade && c.upgrade.state !== 'finished') {
      throw domError('InvalidStateError', 'A version change transaction is running.');
    }
    if (c.closePending) throw domError('InvalidStateError', 'The connection is closing.');
    for (const name of names) {
      if (!c.stores.has(name)) throw domError('NotFoundError', `No object store named "${name}".`);
    }
    if (!names.size) throw domError('InvalidAccessError', 'A transaction needs at least one object store.');
    if (m !== 'readonly' && m !== 'readwrite') throw new TypeError(`A transaction cannot be created with mode "${m}".`);
    const txn = new TxnState(c, m, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), durability);
    schedulerFor(c.name).add(txn);
    return txn.api;
  }

  close(): void {
    const c = this.#c;
    c.closePending = true;
    c.maybeClose();
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): IDBObjectStore {
    needArgs(1, arguments, 'createObjectStore');
    name = domString(name);
    let autoIncrement = false;
    let keyPath: string | string[] | null = null;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw new TypeError('The options are not an object.');
      autoIncrement = !!options.autoIncrement;
      const kp = options.keyPath;
      keyPath = kp === undefined || kp === null ? null : convertKeyPath(kp);
    }
    const c = this.#c;
    const txn = c.upgrade;
    if (!txn) throw domError('InvalidStateError', 'Object stores can only be created while upgrading.');
    if (txn.state !== 'active') throw domError('TransactionInactiveError', 'The upgrade transaction is not active.');
    if (keyPath !== null && !isValidKeyPath(keyPath)) throw domError('SyntaxError', 'The key path is not valid.');
    if (c.stores.has(name)) throw domError('ConstraintError', `An object store named "${name}" already exists.`);
    if (autoIncrement && (keyPath === '' || Array.isArray(keyPath))) {
      throw domError('InvalidAccessError', 'An auto-incrementing store cannot have an empty or array key path.');
    }
    const meta: StoreMeta = {
      id: c.nextId++,
      name,
      keyPath,
      keyPathValue: keyPathValue(keyPath),
      autoIncrement,
      indexes: new Map(),
      deleted: false,
      createdIn: txn,
    };
    c.stores.set(name, meta);
    txn.undo.push(() => {
      c.stores.delete(meta.name);
      meta.deleted = true;
    });
    txn.system(['cs', meta.id, name, keyPathJson(keyPath), autoIncrement ? 1 : 0]);
    return txn.handle(meta);
  }

  deleteObjectStore(name: string): void {
    needArgs(1, arguments, 'deleteObjectStore');
    name = domString(name);
    const c = this.#c;
    const txn = c.upgrade;
    if (!txn) throw domError('InvalidStateError', 'Object stores can only be deleted while upgrading.');
    if (txn.state !== 'active') throw domError('TransactionInactiveError', 'The upgrade transaction is not active.');
    const meta = c.stores.get(name);
    if (!meta) throw domError('NotFoundError', `No object store named "${name}".`);
    c.stores.delete(name);
    meta.deleted = true;
    const indexes = [...meta.indexes.values()];
    for (const index of indexes) index.deleted = true;
    txn.undo.push(() => {
      meta.deleted = false;
      for (const index of indexes) index.deleted = false;
      c.stores.set(meta.name, meta);
    });
    txn.system(['ds', meta.id]);
  }
}

function convertNames(value: unknown): string[] {
  if (value !== null && typeof value === 'object' && typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function') {
    return Array.from(value as Iterable<unknown>, domString);
  }
  return [domString(value)];
}

defineHandlers(IDBDatabase.prototype, ['abort', 'close', 'error', 'versionchange'], (v) => databases.has(v as object));

// ---------------------------------------------------------------------------
// Values going in: put, add, cursor update

/**
 * Serialize a value with the transaction inactive, as the spec has it, so a
 * getter that tries to use the transaction finds it closed.
 */
function cloneForStorage(txn: TxnState, value: unknown): Serialized {
  const before = txn.state;
  txn.state = 'inactive';
  try {
    return serialize(value);
  } finally {
    if (txn.state === 'inactive') txn.state = before;
  }
}

function indexEntries(meta: StoreMeta, clone: unknown, generatedAt: string | null = null): Wire[] {
  const entries: Wire[] = [];
  for (const index of meta.indexes.values()) {
    // A path into a generated key reads a property of a number, which fails;
    // the stand-in is a string, which would not.
    if (generatedAt !== null && (Array.isArray(index.keyPath) ? index.keyPath : [index.keyPath]).some((p) => p.startsWith(generatedAt + '.'))) {
      continue;
    }
    const key = extractKey(clone, index.keyPath, index.multiEntry);
    if (key === null || key === undefined) continue;
    entries.push([index.id, index.multiEntry ? arrayMembers(key) : [key]]);
  }
  return entries;
}

/**
 * What a generated key stands in as while index keys are worked out, before
 * the store has chosen the key. Its encoding is the template the store
 * replaces with the real key's.
 */
const GENERATED = '\u0000tenna:generated-key\u0000';
const GENERATED_KEY = toKey(GENERATED)!;

/**
 * A stored value whose key the store generated starts with this, and has the
 * key written in when it is read — the key does not exist until the store
 * runs the put, and a failed put must not use one up.
 */
const INJECT = 'K';

/** A stored value as the site gets it back: its generated key written in. */
function readValue(meta: StoreMeta, stored: string, primaryKey: string): unknown {
  if (stored[0] !== INJECT) return deserialize(stored);
  const value = deserialize(stored.slice(1));
  injectKey(value, meta.keyPath as string, keyToValue(primaryKey));
  return value;
}

/** Whether a store's values may need their key written in on the way out. */
function injects(meta: StoreMeta): boolean {
  return meta.autoIncrement && meta.keyPath !== null;
}

/**
 * Store a value: the shared tail of `put`, `add` and `IDBCursor.update`,
 * after their argument checks. `key` is the encoded key, or null for the
 * store's key generator to choose one.
 */
function storeValue(
  txn: TxnState,
  meta: StoreMeta,
  request: IDBRequest,
  serialized: Serialized,
  clone: unknown,
  key: string | null,
  overwrite: boolean,
): void {
  // Counted now, not when the op is written: a cursor deciding whether what
  // it read ahead is still good must see this write even while it waits.
  txn.writes++;
  const inject = key === null && meta.keyPath !== null;
  let entries: Wire[] = [];
  if (meta.indexes.size) {
    if (inject) injectKey(clone, meta.keyPath as string, GENERATED);
    entries = indexEntries(meta, clone, inject ? (meta.keyPath as string) : null);
  }
  const entry = txn.request(request, null, (answer) => ({ result: keyToValue(key ?? (answer as string)) }));
  const op = (text: string): Wire[] => [
    'put', meta.id, key, (inject ? INJECT : '') + text, overwrite ? 1 : 0, entries, inject ? GENERATED_KEY : null,
  ];
  const whole = completeNow(serialized);
  if (whole !== undefined) {
    txn.ready(entry, op(whole));
  } else {
    complete(serialized).then(
      (text) => txn.ready(entry, op(text)),
      (error) => txn.settle(entry, { error: domError('DataError', `A Blob could not be read: ${String(error)}`) }),
    );
  }
}

// ---------------------------------------------------------------------------
// Reading many: getAll, getAllKeys, getAllRecords

interface GetAllArgs {
  range: WireRange;
  count: number;
  direction: Direction;
}

function getAllArgs(args: IArguments, queryOrOptions: unknown, count: unknown): GetAllArgs {
  if (args.length === 0 || queryOrOptions === undefined || queryOrOptions === null || isPotentiallyValidKeyRange(queryOrOptions)) {
    return {
      range: toRange(queryOrOptions),
      count: count === undefined ? 0 : enforceUnsignedLong(count),
      direction: 'next',
    };
  }
  if (typeof queryOrOptions !== 'object' && typeof queryOrOptions !== 'function') {
    return { range: toRange(queryOrOptions), count: count === undefined ? 0 : enforceUnsignedLong(count), direction: 'next' };
  }
  const options = queryOrOptions as { query?: unknown; count?: unknown; direction?: unknown };
  // Dictionary members convert in lexicographic order.
  const c = options.count === undefined ? 0 : enforceUnsignedLong(options.count);
  const direction = toDirection(options.direction);
  const query = options.query;
  return { range: toRange(query), count: c, direction };
}

// ---------------------------------------------------------------------------
// IDBObjectStore

interface StoreHandle {
  meta: StoreMeta;
  txn: TxnState;
  indexes: Map<IndexMeta, IDBIndex>;
  /** What `keyPath` returns: the same object from one handle, a new one from each. */
  keyPath: unknown;
}

let storeHandle: (store: IDBObjectStore) => StoreHandle;

function checkStore(h: StoreHandle): void {
  if (h.meta.deleted) throw domError('InvalidStateError', 'The object store has been deleted.');
}

function checkActive(txn: TxnState): void {
  noteActivity();
  if (txn.state !== 'active') throw domError('TransactionInactiveError', 'The transaction is not active.');
}

function checkWritable(txn: TxnState): void {
  if (txn.mode === 'readonly') throw domError('ReadOnlyError', 'The transaction is read-only.');
}

export class IDBObjectStore {
  #h: StoreHandle;

  static {
    storeHandle = (store) => store.#h;
  }

  constructor(token: symbol, meta: StoreMeta, txn: TxnState) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#h = { meta, txn, indexes: new Map(), keyPath: keyPathValue(meta.keyPath) };
  }

  get name(): string {
    return this.#h.meta.name;
  }

  set name(value: string) {
    const name = domString(value);
    const { meta, txn } = this.#h;
    if (txn.mode !== 'versionchange') throw domError('InvalidStateError', 'Object stores can only be renamed while upgrading.');
    checkStore(this.#h);
    checkActive(txn);
    if (name === meta.name) return;
    const conn = txn.conn;
    if (conn.stores.has(name)) throw domError('ConstraintError', `An object store named "${name}" already exists.`);
    const old = meta.name;
    conn.stores.delete(old);
    meta.name = name;
    conn.stores.set(name, meta);
    txn.undo.push(() => {
      // A store the aborted upgrade made keeps the name it was last given.
      if (meta.createdIn === txn) return;
      conn.stores.delete(meta.name);
      meta.name = old;
      if (!meta.deleted) conn.stores.set(old, meta);
    });
    txn.system(['rs', meta.id, name]);
  }

  get keyPath(): unknown {
    return this.#h.keyPath;
  }

  get indexNames(): DOMStringList {
    const meta = this.#h.meta;
    return nameList(meta.deleted ? [] : meta.indexes.keys());
  }

  get transaction(): IDBTransaction {
    return this.#h.txn.api;
  }

  get autoIncrement(): boolean {
    return this.#h.meta.autoIncrement;
  }

  put(value: unknown, key?: unknown): IDBRequest {
    needArgs(1, arguments, 'put');
    return this.#add(value, key, arguments.length > 1, true);
  }

  add(value: unknown, key?: unknown): IDBRequest {
    needArgs(1, arguments, 'add');
    return this.#add(value, key, arguments.length > 1, false);
  }

  #add(value: unknown, key: unknown, keyGiven: boolean, overwrite: boolean): IDBRequest {
    const h = this.#h;
    const { meta, txn } = h;
    checkStore(h);
    checkActive(txn);
    checkWritable(txn);
    const hasKey = keyGiven && key !== undefined;
    if (meta.keyPath !== null && hasKey) throw domError('DataError', 'A store with a key path takes no key argument.');
    if (meta.keyPath === null && !meta.autoIncrement && !hasKey) throw domError('DataError', 'This store needs a key.');
    let encoded: string | null = null;
    if (hasKey) {
      encoded = toKey(key);
      if (encoded === null) throw domError('DataError', 'The key is not valid.');
    }
    const serialized = cloneForStorage(txn, value);
    const clone = meta.keyPath !== null || meta.indexes.size ? deserializePending(serialized) : undefined;
    if (meta.keyPath !== null) {
      const extracted = extractKey(clone, meta.keyPath);
      if (extracted === null) throw domError('DataError', 'The key path does not lead to a valid key.');
      if (extracted === undefined) {
        if (!meta.autoIncrement) throw domError('DataError', 'The key path does not lead to a key.');
        if (!canInjectKey(clone, meta.keyPath as string)) throw domError('DataError', 'A generated key cannot be written into this value.');
      } else {
        encoded = extracted;
      }
    }
    const request = new IDBRequest(INTERNAL, this, txn);
    storeValue(txn, meta, request, serialized, clone, encoded, overwrite);
    return request;
  }

  delete(query: unknown): IDBRequest {
    needArgs(1, arguments, 'delete');
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    checkWritable(h.txn);
    const range = toRange(query, true);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    h.txn.request(request, ['del', h.meta.id, range], () => ({ result: undefined }));
    return request;
  }

  clear(): IDBRequest {
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    checkWritable(h.txn);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    h.txn.request(request, ['clr', h.meta.id], () => ({ result: undefined }));
    return request;
  }

  get(query: unknown): IDBRequest {
    needArgs(1, arguments, 'get');
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    const range = toRange(query, true);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    const meta = h.meta;
    const asked = injects(meta) ? 'r' : 'v';
    h.txn.request(request, ['get', 's', meta.id, range, 1, 'n', asked], (answer) => {
      const found = readMany(meta, answer as Wire[], 'v', asked);
      return { result: found.length ? found[0] : undefined };
    });
    return request;
  }

  getKey(query: unknown): IDBRequest {
    needArgs(1, arguments, 'getKey');
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    const range = toRange(query, true);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    h.txn.request(request, ['get', 's', h.meta.id, range, 1, 'n', 'k'], (answer) => {
      const keys = answer as string[];
      return { result: keys.length ? keyToValue(keys[0]) : undefined };
    });
    return request;
  }

  getAll(queryOrOptions?: unknown, count?: unknown): IDBRequest {
    return this.#getAll(getAllArgs(arguments, queryOrOptions, count), 'v');
  }

  getAllKeys(queryOrOptions?: unknown, count?: unknown): IDBRequest {
    return this.#getAll(getAllArgs(arguments, queryOrOptions, count), 'k');
  }

  getAllRecords(options?: unknown): IDBRequest {
    const o = (options ?? {}) as { query?: unknown; count?: unknown; direction?: unknown };
    if (typeof o !== 'object') throw new TypeError('The options are not an object.');
    const c = o.count === undefined ? 0 : enforceUnsignedLong(o.count);
    const direction = toDirection(o.direction);
    return this.#getAll({ range: toRange(o.query), count: c, direction }, 'r');
  }

  #getAll(args: GetAllArgs, what: 'v' | 'k' | 'r'): IDBRequest {
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    const meta = h.meta;
    const asked = what === 'v' && injects(meta) ? 'r' : what;
    h.txn.request(request, ['get', 's', meta.id, args.range, args.count, WIRE_DIRECTION[args.direction], asked], (answer) => ({
      result: readMany(meta, answer as Wire[], what, asked),
    }));
    return request;
  }

  count(query?: unknown): IDBRequest {
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    const range = toRange(query);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    h.txn.request(request, ['get', 's', h.meta.id, range, 0, 'n', 'c'], (answer) => ({ result: answer as number }));
    return request;
  }

  openCursor(query?: unknown, direction?: IDBCursorDirection): IDBRequest {
    return this.#open(query, direction, false);
  }

  openKeyCursor(query?: unknown, direction?: IDBCursorDirection): IDBRequest {
    return this.#open(query, direction, true);
  }

  #open(query: unknown, direction: unknown, keysOnly: boolean): IDBRequest {
    const h = this.#h;
    checkStore(h);
    checkActive(h.txn);
    const range = toRange(query);
    const d = toDirection(direction);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    openCursor(h.txn, request, this, 's', h.meta.id, range, d, keysOnly);
    return request;
  }

  index(name: string): IDBIndex {
    needArgs(1, arguments, 'index');
    name = domString(name);
    const h = this.#h;
    checkStore(h);
    if (h.txn.state === 'finished') throw domError('InvalidStateError', 'The transaction has finished.');
    const meta = h.meta.indexes.get(name);
    if (!meta) throw domError('NotFoundError', `No index named "${name}".`);
    return indexHandle(h, this, meta);
  }

  createIndex(name: string, keyPath: string | string[], options?: IDBIndexParameters): IDBIndex {
    needArgs(2, arguments, 'createIndex');
    name = domString(name);
    const path = convertKeyPath(keyPath);
    let multiEntry = false;
    let unique = false;
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object') throw new TypeError('The options are not an object.');
      multiEntry = !!options.multiEntry;
      unique = !!options.unique;
    }
    const h = this.#h;
    const { meta: store, txn } = h;
    if (txn.mode !== 'versionchange') throw domError('InvalidStateError', 'Indexes can only be created while upgrading.');
    checkStore(h);
    checkActive(txn);
    if (store.indexes.has(name)) throw domError('ConstraintError', `An index named "${name}" already exists.`);
    if (!isValidKeyPath(path)) throw domError('SyntaxError', 'The key path is not valid.');
    if (multiEntry && Array.isArray(path)) throw domError('InvalidAccessError', 'A multi-entry index cannot have an array key path.');
    const meta: IndexMeta = {
      id: txn.conn.nextId++,
      name,
      keyPath: path,
      keyPathValue: keyPathValue(path),
      unique,
      multiEntry,
      store,
      deleted: false,
      createdIn: txn,
    };
    store.indexes.set(name, meta);
    txn.undo.push(() => {
      store.indexes.delete(meta.name);
      meta.deleted = true;
    });
    txn.system(['ci', meta.id, store.id, name, keyPathJson(path)!, unique ? 1 : 0, multiEntry ? 1 : 0]);
    populate(txn, store, meta);
    return indexHandle(h, this, meta);
  }

  deleteIndex(name: string): void {
    needArgs(1, arguments, 'deleteIndex');
    name = domString(name);
    const h = this.#h;
    const { meta: store, txn } = h;
    if (txn.mode !== 'versionchange') throw domError('InvalidStateError', 'Indexes can only be deleted while upgrading.');
    checkStore(h);
    checkActive(txn);
    const meta = store.indexes.get(name);
    if (!meta) throw domError('NotFoundError', `No index named "${name}".`);
    store.indexes.delete(name);
    meta.deleted = true;
    txn.undo.push(() => {
      meta.deleted = false;
      store.indexes.set(meta.name, meta);
    });
    txn.system(['di', meta.id]);
  }
}

/**
 * Fill a new index from the records already in its store. The records are
 * read and their index keys worked out here, and the ops behind wait for it,
 * so nothing written after `createIndex` is indexed twice or from a stale
 * value.
 */
function populate(txn: TxnState, store: StoreMeta, index: IndexMeta): void {
  txn.system(['get', 's', store.id, null, 0, 'n', 'r'], (answer) => {
    if (isWireError(answer)) {
      txn.settle(fill, { result: undefined });
      return;
    }
    const rows: Wire[] = [];
    for (const [, pk, value] of answer as [string, string, string][]) {
      const key = extractKey(readValue(store, value, pk), index.keyPath, index.multiEntry);
      if (key === null || key === undefined) continue;
      rows.push([pk, index.multiEntry ? arrayMembers(key) : [key]]);
    }
    txn.ready(fill, ['ia', index.id, rows]);
  });
  const fill = txn.system(null);
}

function readMany(meta: StoreMeta, answer: Wire[], what: 'v' | 'k' | 'r', asked: 'v' | 'k' | 'r'): unknown[] {
  switch (what) {
    case 'v':
      if (asked === 'r') return (answer as [string, string, string][]).map(([, pk, value]) => readValue(meta, value, pk));
      return (answer as string[]).map((v) => deserialize(v));
    case 'k':
      return (answer as string[]).map((k) => keyToValue(k));
    default:
      return (answer as [string, string, string][]).map(
        ([key, pk, value]) => new IDBRecord(INTERNAL, keyToValue(key), keyToValue(pk), readValue(meta, value, pk)),
      );
  }
}

// ---------------------------------------------------------------------------
// IDBIndex

interface IndexHandle {
  meta: IndexMeta;
  store: IDBObjectStore;
  txn: TxnState;
  keyPath: unknown;
}

let indexHandleOf: (index: IDBIndex) => IndexHandle;

function indexHandle(h: StoreHandle, store: IDBObjectStore, meta: IndexMeta): IDBIndex {
  let index = h.indexes.get(meta);
  if (!index) {
    index = new IDBIndex(INTERNAL, meta, store, h.txn);
    h.indexes.set(meta, index);
  }
  return index;
}

function checkIndex(h: IndexHandle): void {
  if (h.meta.deleted || h.meta.store.deleted) throw domError('InvalidStateError', 'The index has been deleted.');
}

export class IDBIndex {
  #h: IndexHandle;

  static {
    indexHandleOf = (index) => index.#h;
  }

  constructor(token: symbol, meta: IndexMeta, store: IDBObjectStore, txn: TxnState) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#h = { meta, store, txn, keyPath: keyPathValue(meta.keyPath) };
  }

  get name(): string {
    return this.#h.meta.name;
  }

  set name(value: string) {
    const name = domString(value);
    const { meta, txn } = this.#h;
    if (txn.mode !== 'versionchange') throw domError('InvalidStateError', 'Indexes can only be renamed while upgrading.');
    checkIndex(this.#h);
    checkActive(txn);
    if (name === meta.name) return;
    const store = meta.store;
    if (store.indexes.has(name)) throw domError('ConstraintError', `An index named "${name}" already exists.`);
    const old = meta.name;
    store.indexes.delete(old);
    meta.name = name;
    store.indexes.set(name, meta);
    txn.undo.push(() => {
      if (meta.createdIn === txn) return;
      store.indexes.delete(meta.name);
      meta.name = old;
      if (!meta.deleted) store.indexes.set(old, meta);
    });
    txn.system(['ri', meta.id, name]);
  }

  get objectStore(): IDBObjectStore {
    return this.#h.store;
  }

  get keyPath(): unknown {
    return this.#h.keyPath;
  }

  get multiEntry(): boolean {
    return this.#h.meta.multiEntry;
  }

  get unique(): boolean {
    return this.#h.meta.unique;
  }

  get(query: unknown): IDBRequest {
    needArgs(1, arguments, 'get');
    const h = this.#h;
    checkIndex(h);
    checkActive(h.txn);
    const range = toRange(query, true);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    const store = h.meta.store;
    const asked = injects(store) ? 'r' : 'v';
    h.txn.request(request, ['get', 'i', h.meta.id, range, 1, 'n', asked], (answer) => {
      const found = readMany(store, answer as Wire[], 'v', asked);
      return { result: found.length ? found[0] : undefined };
    });
    return request;
  }

  getKey(query: unknown): IDBRequest {
    needArgs(1, arguments, 'getKey');
    const h = this.#h;
    checkIndex(h);
    checkActive(h.txn);
    const range = toRange(query, true);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    h.txn.request(request, ['get', 'i', h.meta.id, range, 1, 'n', 'k'], (answer) => {
      const keys = answer as string[];
      return { result: keys.length ? keyToValue(keys[0]) : undefined };
    });
    return request;
  }

  getAll(queryOrOptions?: unknown, count?: unknown): IDBRequest {
    return this.#getAll(getAllArgs(arguments, queryOrOptions, count), 'v');
  }

  getAllKeys(queryOrOptions?: unknown, count?: unknown): IDBRequest {
    return this.#getAll(getAllArgs(arguments, queryOrOptions, count), 'k');
  }

  getAllRecords(options?: unknown): IDBRequest {
    const o = (options ?? {}) as { query?: unknown; count?: unknown; direction?: unknown };
    if (typeof o !== 'object') throw new TypeError('The options are not an object.');
    const c = o.count === undefined ? 0 : enforceUnsignedLong(o.count);
    const direction = toDirection(o.direction);
    return this.#getAll({ range: toRange(o.query), count: c, direction }, 'r');
  }

  #getAll(args: GetAllArgs, what: 'v' | 'k' | 'r'): IDBRequest {
    const h = this.#h;
    checkIndex(h);
    checkActive(h.txn);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    const store = h.meta.store;
    const asked = what === 'v' && injects(store) ? 'r' : what;
    h.txn.request(request, ['get', 'i', h.meta.id, args.range, args.count, WIRE_DIRECTION[args.direction], asked], (answer) => ({
      result: readMany(store, answer as Wire[], what, asked),
    }));
    return request;
  }

  count(query?: unknown): IDBRequest {
    const h = this.#h;
    checkIndex(h);
    checkActive(h.txn);
    const range = toRange(query);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    h.txn.request(request, ['get', 'i', h.meta.id, range, 0, 'n', 'c'], (answer) => ({ result: answer as number }));
    return request;
  }

  openCursor(query?: unknown, direction?: IDBCursorDirection): IDBRequest {
    return this.#open(query, direction, false);
  }

  openKeyCursor(query?: unknown, direction?: IDBCursorDirection): IDBRequest {
    return this.#open(query, direction, true);
  }

  #open(query: unknown, direction: unknown, keysOnly: boolean): IDBRequest {
    const h = this.#h;
    checkIndex(h);
    checkActive(h.txn);
    const range = toRange(query);
    const d = toDirection(direction);
    const request = new IDBRequest(INTERNAL, this, h.txn);
    openCursor(h.txn, request, this, 'i', h.meta.id, range, d, keysOnly);
    return request;
  }
}

// ---------------------------------------------------------------------------
// Cursors

/** A record as `iter` answers it. */
type Row = [string, string, string | null];

interface CursorState {
  txn: TxnState;
  request: IDBRequest;
  source: IDBObjectStore | IDBIndex;
  kind: 's' | 'i';
  id: number;
  range: WireRange;
  direction: Direction;
  keysOnly: boolean;
  /** The current position, encoded. */
  key: string | null;
  primaryKey: string | null;
  value: string | null;
  keyValue: unknown;
  primaryKeyValue: unknown;
  valueValue: unknown;
  valueRead: boolean;
  gotValue: boolean;
  /** Records read ahead of the position, and the write count when read. */
  ahead: Row[];
  aheadWrites: number;
  /** Whether the store had nothing past the last record read ahead. */
  exhausted: boolean;
  /** How many records the next read asks for. */
  prefetch: number;
  api: IDBCursor;
}

const MAX_PREFETCH = 256;

let cursorState: (cursor: IDBCursor) => CursorState;

function openCursor(
  txn: TxnState,
  request: IDBRequest,
  source: IDBObjectStore | IDBIndex,
  kind: 's' | 'i',
  id: number,
  range: WireRange,
  direction: Direction,
  keysOnly: boolean,
): void {
  const Cls = keysOnly ? IDBCursor : IDBCursorWithValue;
  const cursor = new Cls(INTERNAL, {
    txn,
    request,
    source,
    kind,
    id,
    range,
    direction,
    keysOnly,
    key: null,
    primaryKey: null,
    value: null,
    keyValue: undefined,
    primaryKeyValue: undefined,
    valueValue: undefined,
    valueRead: false,
    gotValue: false,
    ahead: [],
    aheadWrites: 0,
    exhausted: false,
    prefetch: 1,
    api: undefined as unknown as IDBCursor,
  });
  iterate(cursorState(cursor), null, 1);
}

function sourceDeleted(c: CursorState): boolean {
  if (c.kind === 's') return storeHandle(c.source as IDBObjectStore).meta.deleted;
  const meta = indexHandleOf(c.source as IDBIndex).meta;
  return meta.deleted || meta.store.deleted;
}

/**
 * Move a cursor: to the `count`th record past `position` (null: from the
 * edge of the range), served from what was read ahead when that is still
 * good, and from the store otherwise.
 */
function iterate(c: CursorState, position: [string, string | null, number] | null, count: number, target?: (row: Row) => boolean): void {
  const r = requestState(c.request);
  r.done = false;
  c.gotValue = false;
  const txn = c.txn;
  const unique = c.direction === 'nextunique' || c.direction === 'prevunique';

  // Serve from the records read ahead, if nothing has been written since.
  if (c.ahead.length && c.aheadWrites === txn.writes) {
    let remaining = count;
    let i = 0;
    for (; i < c.ahead.length; i++) {
      if (target && !target(c.ahead[i])) continue;
      if (--remaining === 0) break;
    }
    if (i < c.ahead.length) {
      const row = c.ahead[i];
      c.ahead = c.ahead.slice(i + 1);
      txn.local(c.request, () => ({ result: land(c, row) }));
      return;
    }
    if (c.exhausted) {
      c.ahead = [];
      txn.local(c.request, () => ({ result: land(c, null) }));
      return;
    }
    // What was read ahead ran out first; read on from its end.
    const last = c.ahead[c.ahead.length - 1];
    position = [last[0], unique || c.kind === 's' ? null : last[1], 0];
    count = remaining;
  }
  c.ahead = [];

  const limit = Math.max(count, c.prefetch);
  const writes = txn.writes;
  const op: Wire[] = ['iter', c.kind, c.id, c.range, WIRE_DIRECTION[c.direction], c.keysOnly ? 1 : 0, position, limit];
  txn.request(c.request, op, (answer) => {
    const rows = answer as Row[];
    let found: Row | null = null;
    let remaining = count;
    let at = 0;
    for (; at < rows.length; at++) {
      if (target && !target(rows[at])) continue;
      if (--remaining === 0) {
        found = rows[at];
        break;
      }
    }
    c.ahead = found ? rows.slice(at + 1) : [];
    c.aheadWrites = writes;
    c.exhausted = rows.length < limit;
    c.prefetch = Math.min(MAX_PREFETCH, c.prefetch * 2);
    return { result: land(c, found) };
  });
}

/** Put the cursor on a record, or past the end; the request's result. */
function land(c: CursorState, row: Row | null): IDBCursor | null {
  if (!row) {
    c.key = null;
    c.primaryKey = null;
    c.value = null;
    c.keyValue = undefined;
    c.primaryKeyValue = undefined;
    c.valueValue = undefined;
    c.gotValue = false;
    return null;
  }
  c.key = row[0];
  c.primaryKey = row[1];
  c.value = row[2];
  c.keyValue = keyToValue(row[0]);
  c.primaryKeyValue = c.kind === 's' ? c.keyValue : keyToValue(row[1]);
  c.valueRead = false;
  c.valueValue = undefined;
  c.gotValue = true;
  return c.api;
}

export class IDBCursor {
  #c: CursorState;

  static {
    cursorState = (cursor) => cursor.#c;
  }

  constructor(token: symbol, c: CursorState) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#c = c;
    c.api = this;
  }

  get source(): IDBObjectStore | IDBIndex {
    return this.#c.source;
  }

  get direction(): IDBCursorDirection {
    return this.#c.direction;
  }

  get key(): unknown {
    return this.#c.keyValue;
  }

  get primaryKey(): unknown {
    return this.#c.primaryKeyValue;
  }

  get request(): IDBRequest {
    return this.#c.request;
  }

  advance(count: number): void {
    needArgs(1, arguments, 'advance');
    const n = enforceUnsignedLong(count);
    if (n === 0) throw new TypeError('A cursor cannot advance by zero.');
    const c = this.#c;
    checkActive(c.txn);
    if (sourceDeleted(c)) throw domError('InvalidStateError', 'The cursor\'s source has been deleted.');
    if (!c.gotValue) throw domError('InvalidStateError', 'The cursor is being iterated or has finished.');
    iterate(c, this.#after(), n);
  }

  continue(key?: unknown): void {
    const c = this.#c;
    checkActive(c.txn);
    if (sourceDeleted(c)) throw domError('InvalidStateError', 'The cursor\'s source has been deleted.');
    if (!c.gotValue) throw domError('InvalidStateError', 'The cursor is being iterated or has finished.');
    if (key === undefined) {
      iterate(c, this.#after(), 1);
      return;
    }
    const k = toKey(key);
    if (k === null) throw domError('DataError', 'The key is not valid.');
    const forward = c.direction === 'next' || c.direction === 'nextunique';
    if (forward ? k <= c.key! : k >= c.key!) {
      throw domError('DataError', 'The key is not past the cursor\'s position.');
    }
    iterate(c, [k, null, 1], 1, (row) => (forward ? row[0] >= k : row[0] <= k));
  }

  continuePrimaryKey(key: unknown, primaryKey: unknown): void {
    needArgs(2, arguments, 'continuePrimaryKey');
    const c = this.#c;
    checkActive(c.txn);
    if (sourceDeleted(c)) throw domError('InvalidStateError', 'The cursor\'s source has been deleted.');
    if (c.kind !== 'i') throw domError('InvalidAccessError', 'Only an index cursor has primary keys to continue to.');
    if (c.direction !== 'next' && c.direction !== 'prev') {
      throw domError('InvalidAccessError', 'A unique cursor cannot continue to a primary key.');
    }
    if (!c.gotValue) throw domError('InvalidStateError', 'The cursor is being iterated or has finished.');
    const k = toKey(key);
    if (k === null) throw domError('DataError', 'The key is not valid.');
    const pk = toKey(primaryKey);
    if (pk === null) throw domError('DataError', 'The primary key is not valid.');
    const forward = c.direction === 'next';
    if (forward ? k < c.key! || (k === c.key && pk <= c.primaryKey!) : k > c.key! || (k === c.key && pk >= c.primaryKey!)) {
      throw domError('DataError', 'The key is not past the cursor\'s position.');
    }
    iterate(c, [k, pk, 1], 1, (row) =>
      forward ? row[0] > k || (row[0] === k && row[1] >= pk) : row[0] < k || (row[0] === k && row[1] <= pk),
    );
  }

  /** The position just past the current record. */
  #after(): [string, string | null, number] {
    const c = this.#c;
    const unique = c.direction === 'nextunique' || c.direction === 'prevunique';
    return [c.key!, c.kind === 's' || unique ? null : c.primaryKey, 0];
  }

  update(value: unknown): IDBRequest {
    needArgs(1, arguments, 'update');
    const c = this.#c;
    const txn = c.txn;
    checkActive(txn);
    checkWritable(txn);
    if (sourceDeleted(c)) throw domError('InvalidStateError', 'The cursor\'s source has been deleted.');
    if (!c.gotValue || c.keysOnly) throw domError('InvalidStateError', 'The cursor has no value to update.');
    const meta = c.kind === 's' ? storeHandle(c.source as IDBObjectStore).meta : indexHandleOf(c.source as IDBIndex).meta.store;
    const serialized = cloneForStorage(txn, value);
    const clone = meta.keyPath !== null || meta.indexes.size ? deserializePending(serialized) : undefined;
    if (meta.keyPath !== null) {
      const key = extractKey(clone, meta.keyPath);
      if (key !== c.primaryKey) throw domError('DataError', 'The value\'s key does not match the cursor\'s.');
    }
    const request = new IDBRequest(INTERNAL, this, txn);
    storeValue(txn, meta, request, serialized, clone, c.primaryKey!, true);
    return request;
  }

  delete(): IDBRequest {
    const c = this.#c;
    const txn = c.txn;
    checkActive(txn);
    checkWritable(txn);
    if (sourceDeleted(c)) throw domError('InvalidStateError', 'The cursor\'s source has been deleted.');
    if (!c.gotValue || c.keysOnly) throw domError('InvalidStateError', 'The cursor has no record to delete.');
    const meta = c.kind === 's' ? storeHandle(c.source as IDBObjectStore).meta : indexHandleOf(c.source as IDBIndex).meta.store;
    const request = new IDBRequest(INTERNAL, this, txn);
    txn.request(request, ['del', meta.id, keyWireRange(c.primaryKey!)], () => ({ result: undefined }));
    return request;
  }
}

export class IDBCursorWithValue extends IDBCursor {
  get value(): unknown {
    const c = cursorState(this);
    if (!c.valueRead) {
      const meta = c.kind === 's' ? storeHandle(c.source as IDBObjectStore).meta : indexHandleOf(c.source as IDBIndex).meta.store;
      c.valueValue = c.value === null ? undefined : readValue(meta, c.value, c.primaryKey!);
      c.valueRead = true;
    }
    return c.valueValue;
  }
}

// ---------------------------------------------------------------------------
// IDBFactory: open, deleteDatabase, databases, cmp

/** Run open and delete requests for one name one after another. */
function enqueue(name: string, work: () => Promise<void>): void {
  const before = realm.queues.get(name) ?? realm.ready;
  const next = before.then(work, work).catch(() => undefined);
  realm.queues.set(name, next);
}

/**
 * Ask every other connection to the database in this realm to close, and
 * wait until they have: the `versionchange` events, then `blocked` if any
 * stayed open.
 */
async function closeOthers(name: string, request: IDBOpenDBRequest, oldVersion: number, newVersion: number | null, except?: Connection): Promise<void> {
  const others = [...(realm.connections.get(name) ?? [])].filter((c) => c !== except && !c.closed);
  if (!others.length) return;
  await new Promise<void>((resolve) =>
    queueTask(async () => {
      for (const c of others) {
        if (c.closePending) continue;
        await dispatch(c.api, new IDBVersionChangeEvent('versionchange', { oldVersion, newVersion }));
      }
      resolve();
    }),
  );
  if (others.some((c) => !c.closed)) {
    await new Promise<void>((resolve) =>
      queueTask(async () => {
        await dispatch(request, new IDBVersionChangeEvent('blocked', { oldVersion, newVersion }));
        resolve();
      }),
    );
  }
  await Promise.all(others.map((c) => c.whenClosed()));
}

function fireOpenError(request: IDBOpenDBRequest, error: DOMException): Promise<void> {
  return new Promise((resolve) =>
    queueTask(async () => {
      const r = requestState(request);
      r.done = true;
      r.result = undefined;
      r.error = error;
      r.txn = null;
      await dispatch(request, makeEvent('error', true, true));
      resolve();
    }),
  );
}

function fireOpenSuccess(request: IDBOpenDBRequest, conn: Connection): Promise<void> {
  return new Promise((resolve) =>
    queueTask(async () => {
      const r = requestState(request);
      r.done = true;
      r.result = conn.api;
      r.error = null;
      r.txn = null;
      await dispatch(request, makeEvent('success', false, false));
      resolve();
    }),
  );
}

async function runOpen(request: IDBOpenDBRequest, name: string, requested: number | undefined): Promise<void> {
  let schema: Schema | null;
  try {
    schema = (await realm.send(['schema', name])) as Schema | null;
  } catch (error) {
    await fireOpenError(request, domError('UnknownError', String(error)));
    return;
  }
  let current = schema ? schema[0] : 0;
  const version = requested ?? (schema ? current : 1);
  if (current > version) {
    await fireOpenError(request, domError('VersionError', `The database is at version ${current}, past ${version}.`));
    return;
  }
  if (schema && current === version) {
    const conn = new Connection(name, version, schema[1], schema);
    conn.register();
    await fireOpenSuccess(request, conn);
    return;
  }

  await closeOthers(name, request, current, version);

  const txnId = String(realm.nextTransaction++);
  let header: Wire;
  try {
    header = ((await realm.send(['tx', realm.id, txnId, ['v', name, version], []])) as Wire[])[0];
  } catch (error) {
    await fireOpenError(request, domError('UnknownError', String(error)));
    return;
  }
  if (Array.isArray(header) && header[0] === 'skip') {
    // Another realm upgraded while this one waited.
    const now = header[1] as Schema;
    if (now[0] > version) {
      await fireOpenError(request, domError('VersionError', `The database is at version ${now[0]}, past ${version}.`));
      return;
    }
    const conn = new Connection(name, version, now[1], now);
    conn.register();
    await fireOpenSuccess(request, conn);
    return;
  }

  const before = header as Schema;
  current = before[0];
  const conn = new Connection(name, version, before[1], before);
  conn.register();
  // The begin went out above; this transaction's stream continues it.
  const txn = new TxnState(conn, 'versionchange', [], 'default', txnId);
  txn.begun = true;
  txn.started = true;
  conn.upgrade = txn;
  const oldVersion = current;
  txn.undo.push(() => {
    conn.version = oldVersion;
  });

  const finished = new Promise<void>((resolve) => {
    txn.onFinish = () => {
      requestState(request).txn = null;
      resolve();
    };
  });

  await new Promise<void>((resolve) =>
    queueTask(async () => {
      const r = requestState(request);
      r.done = true;
      r.result = conn.api;
      r.error = null;
      r.txn = txn;
      txn.state = 'active';
      txn.deactivateSoon();
      const { threw } = await dispatch(request, new IDBVersionChangeEvent('upgradeneeded', { oldVersion: current, newVersion: version }));
      if (threw) txn.abort(domError('AbortError', 'The upgradeneeded handler threw.'));
      if (txn.state === 'active') txn.state = 'inactive';
      txn.queueTask();
      resolve();
    }),
  );

  await finished;
  conn.upgrade = null;
  if (txn.aborted) {
    conn.closePending = true;
    conn.maybeClose();
    await fireOpenError(request, domError('AbortError', 'The upgrade was aborted.'));
    return;
  }
  if (conn.closePending) {
    await fireOpenError(request, domError('AbortError', 'The connection was closed during the upgrade.'));
    return;
  }
  await fireOpenSuccess(request, conn);
}

async function runDelete(request: IDBOpenDBRequest, name: string): Promise<void> {
  let schema: Schema | null;
  try {
    schema = (await realm.send(['schema', name])) as Schema | null;
  } catch (error) {
    await fireOpenError(request, domError('UnknownError', String(error)));
    return;
  }
  const current = schema ? schema[0] : 0;
  await closeOthers(name, request, current, null);
  let old: number;
  try {
    old = (await realm.send(['drop', realm.id, name])) as number;
  } catch (error) {
    await fireOpenError(request, domError('UnknownError', String(error)));
    return;
  }
  await new Promise<void>((resolve) =>
    queueTask(async () => {
      const r = requestState(request);
      r.done = true;
      r.result = undefined;
      r.error = null;
      await dispatch(request, new IDBVersionChangeEvent('success', { oldVersion: old, newVersion: null }));
      resolve();
    }),
  );
}

let isFactory: (value: unknown) => boolean;

export class IDBFactory {
  #brand = true;

  static {
    isFactory = (value) => {
      try {
        return (value as IDBFactory).#brand;
      } catch {
        return false;
      }
    };
  }

  constructor(token: symbol) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
  }

  open(name: string, version?: number): IDBOpenDBRequest {
    if (!isFactory(this)) throw new TypeError('Illegal invocation');
    needArgs(1, arguments, 'open');
    name = domString(name);
    let v: number | undefined;
    if (version !== undefined) {
      v = enforceUnsignedLongLong(version);
      if (v === 0) throw new TypeError('The version must be at least 1.');
    }
    const request = new IDBOpenDBRequest(INTERNAL);
    enqueue(name, () => runOpen(request, name, v));
    return request;
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    if (!isFactory(this)) throw new TypeError('Illegal invocation');
    needArgs(1, arguments, 'deleteDatabase');
    name = domString(name);
    const request = new IDBOpenDBRequest(INTERNAL);
    enqueue(name, () => runDelete(request, name));
    return request;
  }

  async databases(): Promise<IDBDatabaseInfo[]> {
    if (!isFactory(this)) throw new TypeError('Illegal invocation');
    await realm.ready;
    const list = (await realm.send(['databases'])) as [string, number][];
    return list.map(([name, version]) => ({ name, version }));
  }

  cmp(first: unknown, second: unknown): number {
    if (!isFactory(this)) throw new TypeError('Illegal invocation');
    needArgs(2, arguments, 'cmp');
    const a = toKey(first);
    if (a === null) throw domError('DataError', 'The first key is not valid.');
    const b = toKey(second);
    if (b === null) throw domError('DataError', 'The second key is not valid.');
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

/**
 * Every interface a site can see, by the name it goes by. The names are
 * written out because a minifier renames classes.
 */
export const INTERFACES: [{ prototype: object; name: string }, string][] = [
  [IDBFactory, 'IDBFactory'],
  [IDBDatabase, 'IDBDatabase'],
  [IDBTransaction, 'IDBTransaction'],
  [IDBRequest, 'IDBRequest'],
  [IDBOpenDBRequest, 'IDBOpenDBRequest'],
  [IDBObjectStore, 'IDBObjectStore'],
  [IDBIndex, 'IDBIndex'],
  [IDBCursor, 'IDBCursor'],
  [IDBCursorWithValue, 'IDBCursorWithValue'],
  [IDBKeyRange, 'IDBKeyRange'],
  [IDBRecord, 'IDBRecord'],
  [IDBVersionChangeEvent, 'IDBVersionChangeEvent'],
];

/** Each operation's `length`: how many of its arguments the IDL requires. */
const LENGTHS: Record<string, Record<string, number>> = {
  IDBFactory: { open: 1, deleteDatabase: 1, databases: 0, cmp: 2 },
  IDBDatabase: { transaction: 1, close: 0, createObjectStore: 1, deleteObjectStore: 1 },
  IDBTransaction: { objectStore: 1, commit: 0, abort: 0 },
  IDBObjectStore: {
    put: 1, add: 1, delete: 1, clear: 0, get: 1, getKey: 1, getAll: 0, getAllKeys: 0, getAllRecords: 0,
    count: 0, openCursor: 0, openKeyCursor: 0, index: 1, createIndex: 2, deleteIndex: 1,
  },
  IDBIndex: { get: 1, getKey: 1, getAll: 0, getAllKeys: 0, getAllRecords: 0, count: 0, openCursor: 0, openKeyCursor: 0 },
  IDBCursor: { advance: 1, continue: 0, continuePrimaryKey: 2, update: 1, delete: 0 },
  IDBKeyRange: { includes: 1, 'static only': 1, 'static lowerBound': 1, 'static upperBound': 1, 'static bound': 2 },
};

for (const [cls, name] of INTERFACES) webidl(cls, name, LENGTHS[name], name === 'IDBVersionChangeEvent' ? 1 : 0);
webidl(DOMStringList, 'DOMStringList', { item: 1, contains: 1 });

export { connectionOf, txnState, IDBKeyRange, IDBVersionChangeEvent, DOMStringList };
