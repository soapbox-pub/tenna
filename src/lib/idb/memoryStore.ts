/**
 * The protocol answered from memory.
 *
 * The reference for `NsiteIndexedDB.swift`: the conformance tests run the
 * engine against this, so where the two disagree, this is the one the tests
 * vouch for. It differs from the SQLite store in one way the tests cannot
 * see: a readonly transaction reads live data rather than a snapshot. Within
 * one realm the engine's scheduler already keeps a readonly transaction from
 * overlapping a writer on the same stores, so the difference only shows
 * between realms.
 */

import { decode, encode, type Wire } from './wire';
import { keyNumber, numberKey } from './keys';
import type { Schema, SchemaStore, WireRange } from './protocol';

interface Entry {
  key: string;
  pk: string;
}

class SortedEntries {
  items: Entry[] = [];

  /** The first position whose entry is at or after `[key, pk]`. */
  lowerBound(key: string, pk: string | null): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = this.items[mid];
      if (e.key < key || (e.key === key && pk !== null && e.pk < pk)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The first position whose entry is after `[key, pk]`, or after all of `key` when pk is null. */
  upperBound(key: string, pk: string | null): number {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = this.items[mid];
      if (e.key < key || (e.key === key && (pk === null || e.pk <= pk))) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  insert(entry: Entry): void {
    const at = this.lowerBound(entry.key, entry.pk);
    const there = this.items[at];
    if (there && there.key === entry.key && there.pk === entry.pk) return;
    this.items.splice(at, 0, entry);
  }

  remove(key: string, pk: string): void {
    const at = this.lowerBound(key, pk);
    const there = this.items[at];
    if (there && there.key === key && there.pk === pk) this.items.splice(at, 1);
  }

  /** Positions `[from, to)` of the entries inside a range. */
  span(range: WireRange): [number, number] {
    if (!range) return [0, this.items.length];
    const [lower, upper, lowerOpen, upperOpen] = range;
    const from = lower === null ? 0 : lowerOpen ? this.upperBound(lower, null) : this.lowerBound(lower, null);
    const to = upper === null ? this.items.length : upperOpen ? this.lowerBound(upper, null) : this.upperBound(upper, null);
    return [from, Math.max(from, to)];
  }
}

interface MemoryIndex {
  id: number;
  name: string;
  keyPath: string;
  unique: number;
  multiEntry: number;
  entries: SortedEntries;
  /** The keys each primary key has in this index. */
  byPrimary: Map<string, string[]>;
}

interface MemoryObjectStore {
  id: number;
  name: string;
  keyPath: string | null;
  autoIncrement: number;
  generator: number;
  /** Records, as entries whose primary key is their key. */
  keys: SortedEntries;
  values: Map<string, string>;
  indexes: Map<number, MemoryIndex>;
}

interface MemoryDatabase {
  /** False until the upgrade that created it commits. */
  committed: boolean;
  /** The version as of the last upgrade that committed. */
  committedVersion: number;
  name: string;
  version: number;
  incarnation: string;
  stores: Map<number, MemoryObjectStore>;
}

interface MemoryTransaction {
  realm: string;
  database: MemoryDatabase | null;
  name: string;
  mode: 'r' | 'w' | 'v';
  undo: (() => void)[];
  stale: boolean;
  ended: boolean;
  chain: Promise<unknown>;
  writer: boolean;
}

class Failure {
  constructor(readonly name: string, readonly message: string) {}
}

function fail(name: string, message: string): never {
  throw new Failure(name, message);
}

/**
 * Of each run of equal keys, the entry with the lowest primary key — the
 * first of the run going forward, the last going backward.
 */
function uniqueEntries(entries: Entry[], reverse: boolean): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!reverse) {
      if (i === 0 || entries[i - 1].key !== e.key) out.push(e);
    } else if (i === entries.length - 1 || entries[i + 1].key !== e.key) {
      out.push(e);
    }
  }
  return out;
}

/** The largest key a key generator may produce. */
const GENERATOR_LIMIT = 2 ** 53;

let incarnations = 0;

export class MemoryStore {
  private readonly databases = new Map<string, MemoryDatabase>();
  private readonly transactions = new Map<string, MemoryTransaction>();
  private readonly writers = new Map<string, (() => void)[]>();
  private readonly busy = new Set<string>();
  /** Whether a realm has recorded copying its old data in. */
  migrated = false;
  private readonly waiters = new Map<string, { resolve: (notices: Wire[]) => void; open: [string, number, string][] }>();

  /**
   * @param later — how an answer is held back to a later task, as the
   * native store's are by the bridge. Without it, answers arrive within the
   * microtasks of the message that asked.
   */
  constructor(private readonly later?: (fn: () => void) => void) {}

  /** The transport a realm's engine talks to. */
  readonly transport = (message: string): Promise<string> => this.handle(message);

  async handle(message: string): Promise<string> {
    const request = decode(message) as Wire[];
    const answer = encode(await this.dispatch(request));
    if (this.later) await new Promise<void>((resolve) => this.later!(resolve));
    return answer;
  }

  private async dispatch(request: Wire[]): Promise<Wire> {
    switch (request[0]) {
      case 'databases':
        return [...this.databases.values()].filter((db) => db.committed).map((db) => [db.name, db.committedVersion]);
      case 'schema': {
        const db = this.databases.get(request[1] as string);
        return db ? this.schema(db) : null;
      }
      case 'drop':
        return this.drop(request[1] as string, request[2] as string);
      case 'tx':
        if (request[5]) this.endReads(request[1] as string, request[5] as string[]);
        return this.transaction(request[1] as string, request[2] as string, request[3] as Wire[] | null, request[4] as Wire[][]);
      case 'end':
        this.endReads(request[1] as string, request[2] as string[]);
        return 0;
      case 'wait':
        return this.wait(request[1] as string, request[2] as [string, number, string][]);
      case 'migration':
        if (request.length > 1) this.migrated = true;
        return this.migrated ? 1 : 0;
      case 'bye':
        this.bye(request[1] as string);
        return 0;
      default:
        throw new Error(`Unknown command ${String(request[0])}`);
    }
  }

  private schema(db: MemoryDatabase): Schema {
    const stores: SchemaStore[] = [...db.stores.values()].map((s) => [
      s.id,
      s.name,
      s.keyPath,
      s.autoIncrement,
      [...s.indexes.values()].map((i) => [i.id, i.name, i.keyPath, i.unique, i.multiEntry]),
    ]);
    return [db.version, db.incarnation, stores];
  }

  private async acquire(name: string): Promise<void> {
    if (!this.busy.has(name)) {
      this.busy.add(name);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = this.writers.get(name) ?? [];
      queue.push(resolve);
      this.writers.set(name, queue);
    });
  }

  private release(name: string): void {
    const next = this.writers.get(name)?.shift();
    if (next) next();
    else this.busy.delete(name);
  }

  /** A database as a realm would see it: committed, or not there. */
  private current(name: string): [number, string] {
    const db = this.databases.get(name);
    return db && db.committed ? [db.committedVersion, db.incarnation] : [0, ''];
  }

  private differences(open: [string, number, string][]): Wire[] {
    const out: Wire[] = [];
    for (const [name, version, incarnation] of open) {
      const [v, i] = this.current(name);
      if (v !== version || i !== incarnation) out.push([name, v, i]);
    }
    return out;
  }

  /** Something committed: answer every wait it matters to. */
  private notify(): void {
    for (const [realm, waiter] of this.waiters) {
      const found = this.differences(waiter.open);
      if (!found.length) continue;
      this.waiters.delete(realm);
      waiter.resolve(found);
    }
  }

  private wait(realm: string, open: [string, number, string][]): Promise<Wire> {
    this.waiters.get(realm)?.resolve([]);
    this.waiters.delete(realm);
    const found = this.differences(open);
    if (found.length) return Promise.resolve(found);
    return new Promise((resolve) => {
      this.waiters.set(realm, { resolve, open });
    });
  }

  /** End readonly transactions, in their turn after what they already had. */
  private endReads(realm: string, ids: string[]): void {
    for (const id of ids) {
      const key = realm + '\u0000' + id;
      const txn = this.transactions.get(key);
      if (!txn) continue;
      txn.chain = txn.chain.then(() => {
        this.end(txn, true);
        this.transactions.delete(key);
      });
    }
  }

  private bye(realm: string): void {
    for (const [id, txn] of this.transactions) {
      if (txn.realm === realm) {
        this.end(txn, false);
        this.transactions.delete(id);
      }
    }
    this.waiters.get(realm)?.resolve([]);
    this.waiters.delete(realm);
  }

  private async drop(_realm: string, name: string): Promise<Wire> {
    await this.acquire(name);
    try {
      const db = this.databases.get(name);
      if (!db) return 0;
      this.databases.delete(name);
      this.notify();
      return db.committed ? db.committedVersion : 0;
    } finally {
      this.release(name);
    }
  }

  private transaction(realm: string, id: string, begin: Wire[] | null, ops: Wire[][]): Promise<Wire> {
    const key = realm + '\u0000' + id;
    let txn = this.transactions.get(key);
    if (!txn) {
      if (!begin) throw new Error(`Transaction ${id} has not begun`);
      txn = {
        realm,
        database: null,
        name: begin[1] as string,
        mode: begin[0] as 'r' | 'w' | 'v',
        undo: [],
        stale: false,
        ended: false,
        chain: Promise.resolve(),
        writer: false,
      };
      this.transactions.set(key, txn);
    }
    const t = txn;
    const run = t.chain.then(async (): Promise<Wire> => {
      let header: Wire = null;
      if (begin) header = await this.begin(t, begin);
      const results: Wire[] = [header];
      for (const op of ops) {
        if (t.stale || t.ended) {
          results.push(null);
          continue;
        }
        results.push(this.op(t, op));
      }
      if (t.ended) this.transactions.delete(key);
      return results;
    });
    t.chain = run.catch(() => undefined);
    return run;
  }

  private async begin(txn: MemoryTransaction, begin: Wire[]): Promise<Wire> {
    const name = begin[1] as string;
    if (txn.mode === 'r' || txn.mode === 'w') {
      if (txn.mode === 'w') {
        await this.acquire(name);
        txn.writer = true;
      }
      const db = this.databases.get(name);
      if (!db || db.version !== begin[2] || db.incarnation !== begin[3]) {
        txn.stale = true;
        this.end(txn, false);
        return 'stale';
      }
      txn.database = db;
      return 'ok';
    }
    await this.acquire(name);
    txn.writer = true;
    const version = begin[2] as number;
    let db = this.databases.get(name);
    if (db && db.version >= version) {
      const schema = this.schema(db);
      txn.stale = true;
      this.end(txn, false);
      return ['skip', schema];
    }
    if (!db) {
      const created: MemoryDatabase = { committed: false, committedVersion: 0, name, version: 0, incarnation: `m${++incarnations}`, stores: new Map() };
      this.databases.set(name, created);
      txn.undo.push(() => this.databases.delete(name));
      db = created;
    }
    const header = this.schema(db);
    const old = db.version;
    const target = db;
    txn.undo.push(() => {
      target.version = old;
    });
    db.version = version;
    txn.database = db;
    return header;
  }

  private end(txn: MemoryTransaction, commit: boolean): void {
    if (txn.ended) return;
    txn.ended = true;
    if (!commit) {
      for (let i = txn.undo.length - 1; i >= 0; i--) txn.undo[i]();
    }
    txn.undo = [];
    if (txn.writer) this.release(txn.name);
    if (commit && txn.mode === 'v' && txn.database) {
      txn.database.committed = true;
      txn.database.committedVersion = txn.database.version;
      this.notify();
    }
  }

  private op(txn: MemoryTransaction, op: Wire[]): Wire {
    const mark = txn.undo.length;
    try {
      return this.run(txn, op);
    } catch (error) {
      // An op that fails leaves no trace of itself.
      for (let i = txn.undo.length - 1; i >= mark; i--) txn.undo[i]();
      txn.undo.length = mark;
      if (error instanceof Failure) return ['!', error.name, error.message];
      return ['!', 'UnknownError', String(error)];
    }
  }

  private store(txn: MemoryTransaction, id: Wire): MemoryObjectStore {
    const store = txn.database!.stores.get(id as number);
    if (!store) fail('UnknownError', `No object store ${String(id)}`);
    return store;
  }

  private index(txn: MemoryTransaction, id: Wire): [MemoryObjectStore, MemoryIndex] {
    for (const store of txn.database!.stores.values()) {
      const index = store.indexes.get(id as number);
      if (index) return [store, index];
    }
    fail('UnknownError', `No index ${String(id)}`);
  }

  private run(txn: MemoryTransaction, op: Wire[]): Wire {
    const db = txn.database!;
    switch (op[0]) {
      case 'commit':
        this.end(txn, true);
        return 0;
      case 'abort':
        this.end(txn, false);
        return 0;
      case 'cs': {
        const store: MemoryObjectStore = {
          id: op[1] as number,
          name: op[2] as string,
          keyPath: op[3] as string | null,
          autoIncrement: op[4] as number,
          generator: 1,
          keys: new SortedEntries(),
          values: new Map(),
          indexes: new Map(),
        };
        db.stores.set(store.id, store);
        txn.undo.push(() => db.stores.delete(store.id));
        return 0;
      }
      case 'ds': {
        const store = this.store(txn, op[1]);
        db.stores.delete(store.id);
        txn.undo.push(() => db.stores.set(store.id, store));
        return 0;
      }
      case 'rs': {
        const store = this.store(txn, op[1]);
        const old = store.name;
        store.name = op[2] as string;
        txn.undo.push(() => {
          store.name = old;
        });
        return 0;
      }
      case 'ci': {
        const store = this.store(txn, op[2]);
        const index: MemoryIndex = {
          id: op[1] as number,
          name: op[3] as string,
          keyPath: op[4] as string,
          unique: op[5] as number,
          multiEntry: op[6] as number,
          entries: new SortedEntries(),
          byPrimary: new Map(),
        };
        store.indexes.set(index.id, index);
        txn.undo.push(() => store.indexes.delete(index.id));
        return 0;
      }
      case 'di': {
        const [store, index] = this.index(txn, op[1]);
        store.indexes.delete(index.id);
        txn.undo.push(() => store.indexes.set(index.id, index));
        return 0;
      }
      case 'ri': {
        const [, index] = this.index(txn, op[1]);
        const old = index.name;
        index.name = op[2] as string;
        txn.undo.push(() => {
          index.name = old;
        });
        return 0;
      }
      case 'put':
        return this.put(txn, this.store(txn, op[1]), op[2] as string | null, op[3] as string, op[4] as number, op[5] as Wire[][], op[6] as string | null);
      case 'ia': {
        const [store, index] = this.index(txn, op[1]);
        for (const row of op[2] as Wire[][]) {
          const pk = row[0] as string;
          for (const key of row[1] as string[]) this.addEntry(txn, store, index, key, pk);
        }
        return 0;
      }
      case 'del': {
        const store = this.store(txn, op[1]);
        const [from, to] = store.keys.span(op[2] as WireRange);
        for (const entry of store.keys.items.slice(from, to)) this.removeRecord(txn, store, entry.key);
        return 0;
      }
      case 'clr': {
        const store = this.store(txn, op[1]);
        for (const entry of store.keys.items.slice()) this.removeRecord(txn, store, entry.key);
        return 0;
      }
      case 'get':
        return this.get(txn, op);
      case 'iter':
        return this.iter(txn, op);
      default:
        fail('UnknownError', `Unknown op ${String(op[0])}`);
    }
  }

  private addEntry(txn: MemoryTransaction, _store: MemoryObjectStore, index: MemoryIndex, key: string, pk: string): void {
    if (index.unique) {
      const at = index.entries.lowerBound(key, null);
      const there = index.entries.items[at];
      if (there && there.key === key && there.pk !== pk) {
        fail('ConstraintError', 'A unique index already has this key.');
      }
    }
    const keys = index.byPrimary.get(pk) ?? [];
    if (keys.includes(key)) return;
    index.entries.insert({ key, pk });
    keys.push(key);
    index.byPrimary.set(pk, keys);
    txn.undo.push(() => {
      index.entries.remove(key, pk);
      const now = index.byPrimary.get(pk);
      if (!now) return;
      const i = now.indexOf(key);
      if (i >= 0) now.splice(i, 1);
      if (!now.length) index.byPrimary.delete(pk);
    });
  }

  private removeRecord(txn: MemoryTransaction, store: MemoryObjectStore, pk: string): void {
    const value = store.values.get(pk);
    if (value === undefined) return;
    store.keys.remove(pk, pk);
    store.values.delete(pk);
    txn.undo.push(() => {
      store.keys.insert({ key: pk, pk });
      store.values.set(pk, value);
    });
    for (const index of store.indexes.values()) {
      const keys = index.byPrimary.get(pk);
      if (!keys) continue;
      index.byPrimary.delete(pk);
      for (const key of keys) index.entries.remove(key, pk);
      txn.undo.push(() => {
        index.byPrimary.set(pk, keys);
        for (const key of keys) index.entries.insert({ key, pk });
      });
    }
  }

  private put(
    txn: MemoryTransaction,
    store: MemoryObjectStore,
    given: string | null,
    value: string,
    overwrite: number,
    entries: Wire[][],
    template: string | null,
  ): Wire {
    let key = given;
    if (key === null) {
      if (store.generator > GENERATOR_LIMIT) fail('ConstraintError', 'The key generator has run out of keys.');
      key = numberKey(store.generator);
    }
    if (store.values.has(key)) {
      if (!overwrite) fail('ConstraintError', 'A record with this key already exists.');
      this.removeRecord(txn, store, key);
    }
    store.keys.insert({ key, pk: key });
    store.values.set(key, value);
    const k = key;
    txn.undo.push(() => {
      store.keys.remove(k, k);
      store.values.delete(k);
    });
    for (const [indexId, keys] of entries) {
      const index = store.indexes.get(indexId as number);
      if (!index) fail('UnknownError', `No index ${String(indexId)}`);
      for (const indexKey of keys as string[]) {
        this.addEntry(txn, store, index, template === null ? indexKey : indexKey.split(template).join(key), key);
      }
    }
    // The generator moves only for a put that succeeded: past a generated
    // key, or past an explicit number at or beyond it.
    if (store.autoIncrement) {
      const n = keyNumber(key);
      if (n !== undefined && n >= store.generator) {
        const old = store.generator;
        const floor = Math.floor(Math.min(n, GENERATOR_LIMIT));
        store.generator = floor >= GENERATOR_LIMIT ? Infinity : floor + 1;
        txn.undo.push(() => {
          store.generator = old;
        });
      }
    }
    return given === null ? key : 0;
  }

  /** The entries of a source, in the order a cursor in `direction` meets them. */
  private walk(txn: MemoryTransaction, source: Wire, id: Wire, range: WireRange, reverse: boolean): { entries: Entry[]; values: Map<string, string> } {
    if (source === 's') {
      const store = this.store(txn, id);
      const [from, to] = store.keys.span(range);
      const entries = store.keys.items.slice(from, to);
      return { entries: reverse ? entries.reverse() : entries, values: store.values };
    }
    const [store, index] = this.index(txn, id);
    const [from, to] = index.entries.span(range);
    const entries = index.entries.items.slice(from, to);
    return { entries: reverse ? entries.reverse() : entries, values: store.values };
  }

  private get(txn: MemoryTransaction, op: Wire[]): Wire {
    const [, source, id, range, limit, direction, what] = op as [string, string, number, WireRange, number, string, string];
    const { entries, values } = this.walk(txn, source, id, range, direction === 'p' || direction === 'pu');
    if (what === 'c') return entries.length;
    const ordered = direction === 'nu' || direction === 'pu' ? uniqueEntries(entries, direction === 'pu') : entries;
    const taken = limit > 0 ? ordered.slice(0, limit) : ordered;
    switch (what) {
      case 'v': return taken.map((e) => values.get(e.pk)!);
      case 'k': return taken.map((e) => e.pk);
      default: return taken.map((e) => [e.key, e.pk, values.get(e.pk)!]);
    }
  }

  private iter(txn: MemoryTransaction, op: Wire[]): Wire {
    const [, source, id, range, direction, keysOnly, position, limit] = op as [string, string, number, WireRange, string, number, Wire[] | null, number];
    const reverse = direction === 'p' || direction === 'pu';
    const unique = direction === 'nu' || direction === 'pu';
    const { entries, values } = this.walk(txn, source, id, range, reverse);
    let candidates = unique ? uniqueEntries(entries, reverse) : entries;
    if (position) {
      const [key, pk, inclusive] = position as [string, string | null, number];
      candidates = candidates.filter((e) => {
        let cmp = e.key < key ? -1 : e.key > key ? 1 : 0;
        if (cmp === 0 && pk !== null && !unique) cmp = e.pk < pk ? -1 : e.pk > pk ? 1 : 0;
        if (reverse) cmp = -cmp;
        return inclusive ? cmp >= 0 : cmp > 0;
      });
    }
    const taken = limit > 0 ? candidates.slice(0, limit) : candidates;
    return taken.map((e) => [e.key, e.pk, keysOnly ? null : values.get(e.pk)!]);
  }
}

