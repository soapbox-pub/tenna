/**
 * What the engine asks of a store, and what the store answers.
 *
 * The engine does everything IndexedDB decides synchronously — key
 * conversion, key paths, cloning, the schema, which transaction runs when —
 * and a store only keeps records. There are two stores: `NsiteIndexedDB.swift`
 * on the phone, one SQLite file per site, and `memoryStore.ts`, which the
 * conformance tests run against. They answer this protocol identically.
 *
 * Every message is a list encoded by `wire.ts`, `[command, ...arguments]`,
 * and so is every answer. Keys are encoded by `keys.ts` and compared as
 * strings; values are opaque strings from `clone.ts`; key paths are the JSON
 * of the path, or null. Stores and indexes are named by the ids the store
 * gave them.
 *
 * ## Commands
 *
 * `['databases']` → `[[name, version], ...]`
 *
 * `['schema', name]` → the database's `Schema`, or null when there is none.
 *
 * `['drop', realm, name]` → the version it had, or 0 when there was none.
 * Other realms with a connection hear of it through `wait`.
 *
 * `['tx', realm, txn, begin, ops]` → `[header, ...results]`, one result per
 * op. `txn` is an id unique to the realm; `begin` is null on every message
 * after a transaction's first. On the first it is one of:
 *
 * - `['r' | 'w', name, version, incarnation]`: a readonly or readwrite
 *   transaction on a connection that opened the database at this version
 *   and incarnation. The header is `'ok'`, or `'stale'` when the database
 *   has since been upgraded or deleted, in which case the transaction has
 *   not begun and every result is null.
 * - `['v', name, version]`: an upgrade to `version`. The header is the
 *   `Schema` as it was when the upgrade began — the version in it is the old
 *   version, 0 for a database that did not exist. The store creates the
 *   database if it has to and sets the new version. If the database is
 *   already at `version` or later, the transaction has not begun, the header
 *   is `['skip', schema]`, and every result is null.
 *
 * A readwrite or upgrade transaction holds the database's one writer from
 * `begin` until it ends; a readonly one reads a snapshot taken at `begin`.
 * Ops run in order. A transaction ends with op `commit` or `abort`, or when
 * its realm goes away (abort).
 *
 * `['wait', realm]` → `[[name, version, incarnation], ...]`, answered when
 * another realm has upgraded or deleted a database: its current version (0
 * when deleted) and incarnation. The engine keeps one outstanding.
 *
 * `['bye', realm]`: the realm is going away; abort its transactions.
 *
 * ## Ops
 *
 * An op that fails answers `['!', name, message]` with a DOMException name,
 * and leaves no trace of itself; the transaction carries on. A transaction
 * the store itself cannot continue answers every later op with
 * `['!', 'UnknownError', …]`.
 *
 * Schema, upgrade transactions only. The engine chooses ids — it holds the
 * only writer and knows the schema — so a store can be used in the same
 * message that creates it. Ids are unique across a database's stores and
 * indexes, and are free for reuse once their store or index is deleted.
 * - `['cs', id, name, keyPath, autoIncrement]` → 0
 * - `['ds', store]`, `['rs', store, name]`
 * - `['ci', id, store, name, keyPath, unique, multiEntry]` → 0
 * - `['di', index]`, `['ri', index, name]`
 *
 * Records:
 * - `['put', store, key, value, overwrite, entries, template]`, where entries
 *   is `[[index, [key, ...]], ...]` → 0, or ConstraintError when `overwrite`
 *   is 0 and the key exists or when an entry breaks a unique index. A null
 *   key asks the store's key generator for one, and the answer is then the
 *   key; a generator past 2^53 is a ConstraintError. Every occurrence of
 *   `template`, when it is not null, in the entries' keys is the generated
 *   key, and is replaced with it.
 *
 *   The generator lives in the store and moves only when a put succeeds —
 *   past the key it generated, or, in a store with a generator, past an
 *   explicit number key at or beyond it (capped at 2^53, after which it is
 *   spent). An abort rolls it back like anything else.
 * - `['ia', index, [[primaryKey, [key, ...]], ...]]` fills a new index →
 *   0 or ConstraintError
 * - `['del', store, range]`, `['clr', store]` → 0
 *
 * Reads, with `source` `'s'` for a store and `'i'` for an index:
 * - `['get', source, id, range, limit, direction, what]` → a list, or a
 *   number for `what` = `'c'`. `limit` 0 is no limit; `direction` is as for
 *   `iter`; `what` is `'v'` values, `'k'` primary keys, `'r'` records as
 *   `[key, primaryKey, value]`, `'c'` a count.
 * - `['iter', source, id, range, direction, keysOnly, position, limit]` →
 *   records as `[key, primaryKey, value | null]`, in cursor order. Direction
 *   is `'n'`, `'nu'`, `'p'` or `'pu'`; the unique ones take, of each run of
 *   equal keys, the record with the lowest primary key. `position` is null
 *   to start at the edge of the range, or `[key, primaryKey | null,
 *   inclusive]`: the records at or past `key` in the direction of travel,
 *   and when a primary key is given, past `[key, primaryKey]` as a pair.
 *
 * A range is null (everything) or `[lower | null, upper | null, lowerOpen,
 * upperOpen]`.
 */

import type { Wire } from './wire';

/** `[version, incarnation, stores]` */
export type Schema = [number, string, SchemaStore[]];

/** `[id, name, keyPath, autoIncrement, indexes]` */
export type SchemaStore = [number, string, string | null, number, SchemaIndex[]];

/** `[id, name, keyPath, unique, multiEntry]` */
export type SchemaIndex = [number, string, string, number, number];

/** `[lower, upper, lowerOpen, upperOpen]`, or null for everything. */
export type WireRange = [string | null, string | null, number, number] | null;

/** An op's failure. */
export type WireError = ['!', string, string];

export function isWireError(value: Wire): value is WireError {
  return Array.isArray(value) && value[0] === '!';
}

/** Sends one message and resolves with the answer. */
export type Transport = (message: string) => Promise<string>;
