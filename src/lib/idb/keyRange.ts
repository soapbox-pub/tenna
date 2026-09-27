/**
 * `IDBKeyRange`, and the conversions every query argument goes through.
 */

import { isArrayBuffer, isDate, keyToValue, toKey } from './keys';
import type { WireRange } from './protocol';

export const INTERNAL = Symbol('internal');

function dataError(message: string): DOMException {
  return new DOMException(message, 'DataError');
}

let rangeState: (range: IDBKeyRange) => [string | null, string | null, boolean, boolean];

export class IDBKeyRange {
  #lower: string | null;
  #upper: string | null;
  #lowerOpen: boolean;
  #upperOpen: boolean;
  #lowerValue: unknown;
  #upperValue: unknown;

  static {
    rangeState = (range) => [range.#lower, range.#upper, range.#lowerOpen, range.#upperOpen];
  }

  constructor(token: symbol, lower: string | null, upper: string | null, lowerOpen: boolean, upperOpen: boolean) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#lower = lower;
    this.#upper = upper;
    this.#lowerOpen = lowerOpen;
    this.#upperOpen = upperOpen;
    this.#lowerValue = lower === null ? undefined : keyToValue(lower);
    this.#upperValue = upper === null ? undefined : keyToValue(upper);
  }

  get lower(): unknown {
    return this.#lowerValue;
  }

  get upper(): unknown {
    return this.#upperValue;
  }

  get lowerOpen(): boolean {
    return this.#lowerOpen;
  }

  get upperOpen(): boolean {
    return this.#upperOpen;
  }

  includes(key: unknown): boolean {
    const range = rangeState(this);
    if (arguments.length < 1) throw new TypeError('includes needs a key');
    const k = toKey(key);
    if (k === null) throw dataError('The key is not valid.');
    return rangeIncludes(range, k);
  }

  static only(value: unknown): IDBKeyRange {
    if (arguments.length < 1) throw new TypeError('only needs a key');
    const k = toKey(value);
    if (k === null) throw dataError('The key is not valid.');
    return new IDBKeyRange(INTERNAL, k, k, false, false);
  }

  static lowerBound(lower: unknown, open = false): IDBKeyRange {
    if (arguments.length < 1) throw new TypeError('lowerBound needs a key');
    const k = toKey(lower);
    if (k === null) throw dataError('The key is not valid.');
    return new IDBKeyRange(INTERNAL, k, null, !!open, true);
  }

  static upperBound(upper: unknown, open = false): IDBKeyRange {
    if (arguments.length < 1) throw new TypeError('upperBound needs a key');
    const k = toKey(upper);
    if (k === null) throw dataError('The key is not valid.');
    return new IDBKeyRange(INTERNAL, null, k, true, !!open);
  }

  static bound(lower: unknown, upper: unknown, lowerOpen = false, upperOpen = false): IDBKeyRange {
    if (arguments.length < 2) throw new TypeError('bound needs two keys');
    const l = toKey(lower);
    if (l === null) throw dataError('The lower key is not valid.');
    const u = toKey(upper);
    if (u === null) throw dataError('The upper key is not valid.');
    if (l > u) throw dataError('The lower key is greater than the upper key.');
    if (l === u && (lowerOpen || upperOpen)) throw dataError('The range is empty.');
    return new IDBKeyRange(INTERNAL, l, u, !!lowerOpen, !!upperOpen);
  }
}

export function isKeyRange(value: unknown): value is IDBKeyRange {
  try {
    rangeState(value as IDBKeyRange);
    return true;
  } catch {
    return false;
  }
}

function rangeIncludes([lower, upper, lowerOpen, upperOpen]: [string | null, string | null, boolean, boolean], key: string): boolean {
  if (lower !== null && (lowerOpen ? key <= lower : key < lower)) return false;
  if (upper !== null && (upperOpen ? key >= upper : key > upper)) return false;
  return true;
}

/** A range as it goes to the store. */
export function wireRange(range: IDBKeyRange): WireRange {
  const [lower, upper, lowerOpen, upperOpen] = rangeState(range);
  if (lower === null && upper === null) return null;
  return [lower, upper, lowerOpen ? 1 : 0, upperOpen ? 1 : 0];
}

/** A single key as a range. */
export function keyWireRange(key: string): WireRange {
  return [key, key, 0, 0];
}

/**
 * The spec's "convert a value to a key range". With `nullDisallowed`,
 * undefined and null are a DataError rather than "everything".
 */
export function toRange(value: unknown, nullDisallowed = false): WireRange {
  if (isKeyRange(value)) return wireRange(value);
  if (value === undefined || value === null) {
    if (nullDisallowed) throw dataError('No key or key range was given.');
    return null;
  }
  const k = toKey(value);
  if (k === null) throw dataError('The key is not valid.');
  return keyWireRange(k);
}

/**
 * The spec's "is a potentially valid key range": a key range, or something
 * of a type a key could be. Anything else passed where a query or an options
 * dictionary may go is the dictionary.
 */
export function isPotentiallyValidKeyRange(value: unknown): boolean {
  if (isKeyRange(value)) return true;
  if (typeof value === 'number' || typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null) return false;
  return isDate(value) || Array.isArray(value) || ArrayBuffer.isView(value) || isArrayBuffer(value);
}
