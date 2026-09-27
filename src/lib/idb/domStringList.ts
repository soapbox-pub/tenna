/**
 * `DOMStringList`, which `objectStoreNames` and `indexNames` return, and the
 * WebIDL touches every class here gets.
 */

import { INTERNAL } from './keyRange';

let listItems: (list: DOMStringList) => string[];

export class DOMStringList {
  #items: string[];

  static {
    listItems = (list) => list.#items;
  }

  constructor(token: symbol, items: string[]) {
    if (token !== INTERNAL) throw new TypeError('Illegal constructor');
    this.#items = items;
    for (let i = 0; i < items.length; i++) {
      Object.defineProperty(this, i, { value: items[i], enumerable: true, configurable: true });
    }
  }

  get length(): number {
    return this.#items.length;
  }

  item(index: number): string | null {
    const items = this.#items;
    if (arguments.length < 1) throw new TypeError('item needs an index');
    const i = Number(index) >>> 0;
    return i < items.length ? items[i] : null;
  }

  contains(string: string): boolean {
    const items = this.#items;
    if (arguments.length < 1) throw new TypeError('contains needs a string');
    return items.includes(`${string}`);
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.#items[Symbol.iterator]();
  }
}

/** A sorted list of names, as the spec orders them: by code unit. */
export function nameList(names: Iterable<string>): DOMStringList {
  return new DOMStringList(INTERNAL, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The names a list holds, for the engine's own reading. */
export function namesOf(list: DOMStringList): string[] {
  return listItems(list);
}

/**
 * Shape a class's prototype the way WebIDL does: attributes and operations
 * enumerable, a `Symbol.toStringTag`, and a constructor that only the
 * engine can call.
 */
export function webidl(cls: { prototype: object; name: string }, name = cls.name, lengths: Record<string, number> = {}, length = 0): void {
  const proto = cls.prototype;
  Object.defineProperty(cls, 'length', { value: length, configurable: true });
  for (const [method, n] of Object.entries(lengths)) {
    const [where, key] = method.startsWith('static ') ? [cls, method.slice(7)] : [proto, method];
    const fn = (where as Record<string, unknown>)[key];
    if (typeof fn === 'function') Object.defineProperty(fn, 'length', { value: n, configurable: true });
  }
  for (const key of Reflect.ownKeys(proto)) {
    if (key === 'constructor' || typeof key === 'symbol') continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key)!;
    Object.defineProperty(proto, key, { ...desc, enumerable: true });
  }
  for (const key of Reflect.ownKeys(cls)) {
    if (key === 'prototype' || key === 'length' || key === 'name' || typeof key === 'symbol') continue;
    const desc = Object.getOwnPropertyDescriptor(cls, key)!;
    if (typeof desc.value === 'function' || desc.get) Object.defineProperty(cls, key, { ...desc, enumerable: true });
  }
  Object.defineProperty(proto, Symbol.toStringTag, { value: name, configurable: true });
}
