/**
 * Key paths: validating them, and evaluating them against a value.
 *
 * Follows the spec's "evaluate a key path on a value", including the handful
 * of properties it reads off platform objects and primitives that are not own
 * properties at all — a string's or array's `length`, a Blob's `size` and
 * `type`, a File's `name` and `lastModified`.
 */

import { arrayKey, toKey } from './keys';

/** A key path as stored: null (out-of-line keys), a string, or a list. */
export type KeyPath = string | string[] | null;

const IDENTIFIER = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

const hasOwn = Object.prototype.hasOwnProperty;

function isValidPathString(path: string): boolean {
  if (path === '') return true;
  return path.split('.').every((part) => IDENTIFIER.test(part));
}

/** The spec's "valid key path". */
export function isValidKeyPath(path: KeyPath): boolean {
  if (path === null) return true;
  if (typeof path === 'string') return isValidPathString(path);
  return path.length > 0 && path.every(isValidPathString);
}

/**
 * The IDL conversion `(DOMString or sequence<DOMString>)` a key path
 * argument goes through: anything iterable is a list, anything else a string.
 */
export function convertKeyPath(value: unknown): string | string[] {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
    if (iterator !== undefined && iterator !== null) {
      if (typeof iterator !== 'function') throw new TypeError('Key path is not iterable');
      return Array.from(value as Iterable<unknown>, (member) => String(member));
    }
  }
  return String(value);
}

let blobSize: ((this: Blob) => number) | undefined;
let blobType: ((this: Blob) => string) | undefined;
let fileName: ((this: File) => string) | undefined;
let fileModified: ((this: File) => number) | undefined;

function getter<T>(ctor: { prototype: object } | undefined, name: string): T | undefined {
  if (!ctor) return undefined;
  return Object.getOwnPropertyDescriptor(ctor.prototype, name)?.get as T | undefined;
}

/** Bind the Blob and File brand checks to a realm's constructors. */
export function bindKeyPathRealm(realm: { Blob?: typeof Blob; File?: typeof File }): void {
  blobSize = getter(realm.Blob, 'size');
  blobType = getter(realm.Blob, 'type');
  fileName = getter(realm.File, 'name');
  fileModified = getter(realm.File, 'lastModified');
}

bindKeyPathRealm(globalThis);

/** A brand-checked read of an accessor, or `miss` when the brand is wrong. */
function branded(fn: ((this: never) => unknown) | undefined, value: object, miss: symbol): unknown {
  if (!fn) return miss;
  try {
    return (fn as (this: object) => unknown).call(value);
  } catch {
    return miss;
  }
}

const FAIL = Symbol('fail');

function evaluateString(value: unknown, path: string): unknown {
  if (path === '') return value;
  const parts = path.split('.');
  for (const part of parts) {
    if (typeof value === 'string' && part === 'length') {
      value = value.length;
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      if (typeof value !== 'function') return FAIL;
    }
    const object = value as object;
    if (Array.isArray(object) && part === 'length') {
      value = object.length;
      continue;
    }
    if (part === 'size' || part === 'type') {
      const read = branded(part === 'size' ? blobSize : blobType, object, FAIL);
      if (read !== FAIL) {
        value = read;
        continue;
      }
    }
    if (part === 'name' || part === 'lastModified') {
      const read = branded(part === 'name' ? fileName : fileModified, object, FAIL);
      if (read !== FAIL) {
        value = read;
        continue;
      }
    }
    if (!hasOwn.call(object, part)) return FAIL;
    value = (object as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * The spec's "extract a key from a value using a key path": the encoded key,
 * null when the path does not lead to a valid key, or undefined when it does
 * not lead anywhere (the "failure" the spec distinguishes from "invalid").
 */
export function extractKey(value: unknown, path: string | string[], multiEntry = false): string | null | undefined {
  if (Array.isArray(path)) {
    const members: string[] = [];
    for (const member of path) {
      const found = evaluateString(value, member);
      if (found === FAIL) return undefined;
      const key = toKey(found);
      if (key === null) return null;
      members.push(key);
    }
    return arrayKey(members);
  }
  const found = evaluateString(value, path);
  if (found === FAIL) return undefined;
  if (!multiEntry || !Array.isArray(found)) return toKey(found);
  return multiEntryKey(found);
}

/**
 * The spec's "convert a value to a multiEntry key": the array's members that
 * are valid keys, deduplicated, as one encoded array key.
 */
function multiEntryKey(input: unknown[]): string {
  const seen = new Set<object>([input]);
  const keys = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    if (!hasOwn.call(input, i)) continue;
    const key = toKey(input[i], seen);
    if (key !== null) keys.add(key);
  }
  return arrayKey([...keys]);
}

/**
 * Whether a key generated for the value could be written at the path — the
 * spec's "check that a key could be injected into a value".
 */
export function canInjectKey(value: unknown, path: string): boolean {
  const parts = path.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof value !== 'object' || value === null) return false;
    if (!hasOwn.call(value, parts[i])) return true;
    value = (value as Record<string, unknown>)[parts[i]];
  }
  return typeof value === 'object' && value !== null;
}

/**
 * Write a generated key into the value at the path, as own data properties
 * that bypass any setter on the prototype chain.
 */
export function injectKey(value: unknown, path: string, key: unknown): void {
  const parts = path.split('.');
  let target = value as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!hasOwn.call(target, part)) {
      Object.defineProperty(target, part, { value: {}, writable: true, enumerable: true, configurable: true });
    }
    target = target[part] as Record<string, unknown>;
  }
  Object.defineProperty(target, parts[parts.length - 1], {
    value: key,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
