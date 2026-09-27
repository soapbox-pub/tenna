/**
 * IndexedDB keys, held as strings whose code-unit order is key order.
 *
 * A key never exists inside the engine as the value a site handed over. It is
 * converted once, by the spec's "convert a value to a key", into an encoded
 * string; comparing two keys is then comparing two strings, which JavaScript
 * does by code unit and SQLite does by `memcmp` once the units are written
 * big-endian. That one property is what lets the native store range-scan with
 * plain blob comparisons and no knowledge of keys at all.
 *
 * Every key starts with a type unit, ordered as the spec orders types —
 * number < date < string < binary < array — and zero terminates the variable
 * length ones, so a key that is a prefix of another sorts first:
 *
 * - number, date: the type, then the IEEE-754 bits in four units, the sign bit
 *   flipped for positives and every bit flipped for negatives
 * - string: the type, the code units with 0 and 1 escaped as `1,1` and `1,2`,
 *   then 0
 * - binary: the type, each byte plus one, then 0
 * - array: the type, each member's own encoding, then 0
 */

const NUMBER = 1;
const DATE = 2;
const STRING = 3;
const BINARY = 4;
const ARRAY = 5;

/** The type of an encoded key, as `IDBFactory.cmp` never needs but cursors do. */
export type KeyType = 'number' | 'date' | 'string' | 'binary' | 'array';

const scratch = new DataView(new ArrayBuffer(8));

function encodeDouble(n: number): string {
  scratch.setFloat64(0, n === 0 ? 0 : n);
  let a = scratch.getUint16(0);
  let b = scratch.getUint16(2);
  let c = scratch.getUint16(4);
  let d = scratch.getUint16(6);
  if (a & 0x8000) {
    a = ~a & 0xffff;
    b = ~b & 0xffff;
    c = ~c & 0xffff;
    d = ~d & 0xffff;
  } else {
    a |= 0x8000;
  }
  return String.fromCharCode(a, b, c, d);
}

function decodeDouble(s: string, at: number): number {
  let a = s.charCodeAt(at);
  let b = s.charCodeAt(at + 1);
  let c = s.charCodeAt(at + 2);
  let d = s.charCodeAt(at + 3);
  if (a & 0x8000) {
    a &= 0x7fff;
  } else {
    a = ~a & 0xffff;
    b = ~b & 0xffff;
    c = ~c & 0xffff;
    d = ~d & 0xffff;
  }
  scratch.setUint16(0, a);
  scratch.setUint16(2, b);
  scratch.setUint16(4, c);
  scratch.setUint16(6, d);
  return scratch.getFloat64(0);
}

function encodeString(s: string): string {
  // The common case has nothing to escape, and one scan is cheaper than a
  // rebuild.
  let clean = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 1) {
      clean = false;
      break;
    }
  }
  if (clean) return String.fromCharCode(STRING) + s + '\u0000';
  let out = String.fromCharCode(STRING);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c <= 1 ? String.fromCharCode(1, c + 1) : s[i];
  }
  return out + '\u0000';
}

function encodeBytes(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length + 2);
  units[0] = BINARY;
  for (let i = 0; i < bytes.length; i++) units[i + 1] = bytes[i] + 1;
  return unitsToString(units);
}

/** A `Uint16Array` as a string, in chunks small enough for `apply`. */
export function unitsToString(units: Uint16Array): string {
  const CHUNK = 0x2000;
  if (units.length <= CHUNK) return String.fromCharCode.apply(null, units as unknown as number[]);
  let out = '';
  for (let i = 0; i < units.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, units.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;
const sharedByteLength = typeof SharedArrayBuffer === 'function'
  ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
  : undefined;
const dateValue = Date.prototype.valueOf;

/** True for an `ArrayBuffer` of this or any other realm. */
export function isArrayBuffer(value: object): value is ArrayBuffer {
  try {
    bufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

/** True for a `SharedArrayBuffer` of this or any other realm. */
export function isSharedArrayBuffer(value: object): boolean {
  if (!sharedByteLength) return false;
  try {
    sharedByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

/** True for a `Date` of this or any other realm. */
export function isDate(value: object): value is Date {
  try {
    dateValue.call(value);
    return true;
  } catch {
    return false;
  }
}

function isDetached(buffer: ArrayBuffer): boolean {
  if (bufferDetached) return bufferDetached.call(buffer) as boolean;
  // Engines without `detached` report a detached buffer as zero-length, and a
  // zero-length view over it throws on construction.
  try {
    new Uint8Array(buffer);
    return false;
  } catch {
    return true;
  }
}

/** The bytes of a buffer source, or null when detached. */
function bufferSourceBytes(value: object): Uint8Array | null | undefined {
  if (ArrayBuffer.isView(value)) {
    const buffer = value.buffer;
    if (isArrayBuffer(buffer) && isDetached(buffer)) return null;
    return new Uint8Array(buffer, value.byteOffset, value.byteLength);
  }
  if (isArrayBuffer(value)) {
    if (isDetached(value)) return null;
    return new Uint8Array(value);
  }
  if (isSharedArrayBuffer(value)) {
    return new Uint8Array(value as SharedArrayBuffer);
  }
  return undefined;
}

/**
 * The spec's "convert a value to a key": the encoded key, or null when the
 * value is not a valid key. Throws only what the value's own getters throw.
 */
export function toKey(input: unknown, seen?: Set<object>): string | null {
  switch (typeof input) {
    case 'number':
      return Number.isNaN(input) ? null : String.fromCharCode(NUMBER) + encodeDouble(input);
    case 'string':
      return encodeString(input);
    case 'object': {
      if (input === null) return null;
      if (isDate(input)) {
        const t = dateValue.call(input);
        return Number.isNaN(t) ? null : String.fromCharCode(DATE) + encodeDouble(t);
      }
      const bytes = bufferSourceBytes(input);
      if (bytes === null) return null;
      if (bytes) return encodeBytes(bytes);
      if (Array.isArray(input)) {
        if (seen?.has(input)) return null;
        const inner = seen ?? new Set<object>();
        inner.add(input);
        const length = input.length;
        let out = String.fromCharCode(ARRAY);
        for (let i = 0; i < length; i++) {
          if (!Object.prototype.hasOwnProperty.call(input, i)) return null;
          const member = toKey(input[i], inner);
          if (member === null) return null;
          out += member;
        }
        inner.delete(input);
        return out + '\u0000';
      }
      return null;
    }
    default:
      return null;
  }
}

/** Where a key that starts at `at` ends. */
function skip(s: string, at: number): number {
  switch (s.charCodeAt(at)) {
    case NUMBER:
    case DATE:
      return at + 5;
    case STRING:
    case BINARY: {
      let i = at + 1;
      for (;;) {
        const c = s.charCodeAt(i);
        if (c === 0) return i + 1;
        i += c === 1 && s.charCodeAt(at) === STRING ? 2 : 1;
      }
    }
    case ARRAY: {
      let i = at + 1;
      while (s.charCodeAt(i) !== 0) i = skip(s, i);
      return i + 1;
    }
    default:
      throw new Error('Corrupt key');
  }
}

function decodeAt(s: string, at: number): [unknown, number] {
  switch (s.charCodeAt(at)) {
    case NUMBER:
      return [decodeDouble(s, at + 1), at + 5];
    case DATE:
      return [new Date(decodeDouble(s, at + 1)), at + 5];
    case STRING: {
      let i = at + 1;
      let start = i;
      let out = '';
      for (;;) {
        const c = s.charCodeAt(i);
        if (c === 0) return [out + s.slice(start, i), i + 1];
        if (c === 1) {
          out += s.slice(start, i) + String.fromCharCode(s.charCodeAt(i + 1) - 1);
          i += 2;
          start = i;
        } else {
          i++;
        }
      }
    }
    case BINARY: {
      const end = s.indexOf('\u0000', at + 1);
      const bytes = new Uint8Array(end - at - 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = s.charCodeAt(at + 1 + i) - 1;
      return [bytes.buffer, end + 1];
    }
    case ARRAY: {
      // Defined rather than pushed: a setter a site put on Array.prototype
      // must not see its keys go by.
      const out: unknown[] = [];
      let i = at + 1;
      let n = 0;
      while (s.charCodeAt(i) !== 0) {
        const [member, next] = decodeAt(s, i);
        Object.defineProperty(out, n++, { value: member, writable: true, enumerable: true, configurable: true });
        i = next;
      }
      return [out, i + 1];
    }
    default:
      throw new Error('Corrupt key');
  }
}

/** The spec's "convert a key to a value": a fresh ECMAScript value each call. */
export function keyToValue(key: string): unknown {
  return decodeAt(key, 0)[0];
}

/** The type of an encoded key. */
export function keyType(key: string): KeyType {
  switch (key.charCodeAt(0)) {
    case NUMBER: return 'number';
    case DATE: return 'date';
    case STRING: return 'string';
    case BINARY: return 'binary';
    default: return 'array';
  }
}

/** The number an encoded number key holds, or undefined for any other type. */
export function keyNumber(key: string): number | undefined {
  return key.charCodeAt(0) === NUMBER ? decodeDouble(key, 1) : undefined;
}

/** The encoded key for a number, as the key generator makes. */
export function numberKey(n: number): string {
  return String.fromCharCode(NUMBER) + encodeDouble(n);
}

/** -1, 0 or 1, as `IDBFactory.cmp` answers. */
export function compareKeys(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The members of an encoded array key, each still encoded. For a key that is
 * not an array, the key itself.
 */
export function arrayMembers(key: string): string[] {
  if (key.charCodeAt(0) !== ARRAY) return [key];
  const out: string[] = [];
  let i = 1;
  while (key.charCodeAt(i) !== 0) {
    const next = skip(key, i);
    out.push(key.slice(i, next));
    i = next;
  }
  return out;
}

/** An encoded array key made of encoded members. */
export function arrayKey(members: string[]): string {
  return String.fromCharCode(ARRAY) + members.join('') + '\u0000';
}
