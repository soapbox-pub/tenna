/**
 * Structured serialization for storage, into a string.
 *
 * The HTML spec's StructuredSerializeForStorage and its inverse, written out
 * because a value has to leave the page as something the native store can
 * keep: the bridge carries strings and nothing else, and carries them exactly
 * — lone surrogates and NULs included — so strings in a value are copied into
 * the output as they are, with no escaping to undo.
 *
 * The format is a prefix code, one character naming each token:
 *
 * | token | value |
 * |---|---|
 * | `u` `n` `t` `f` `z` | undefined, null, true, false, -0 |
 * | `d<number>;` | any other number |
 * | `g<digits>;` | bigint |
 * | `s<length>:<units>` | string |
 * | `T` `F` `N<d>` `Q<g>` `W<s>` | Boolean, Number, BigInt and String objects |
 * | `D<number>;` | Date |
 * | `R<s><s>` | RegExp: source, flags |
 * | `A<bytes>;<units>` | ArrayBuffer, bytes packed two to a unit |
 * | `Y<max>;<bytes>;<units>` | resizable ArrayBuffer |
 * | `V<type><offset>;<length>;<buffer>` | typed array or DataView |
 * | `a<length>;<count>;(<s><value>)*` | array with holes or extra properties |
 * | `l<length>;<value>*` | dense array |
 * | `o<count>;(<s><value>)*` | object |
 * | `M<count>;(<key><value>)*` | Map |
 * | `S<count>;<value>*` | Set |
 * | `E<s>` then `m<s>` or `x` | Error: name, then message or none |
 * | `b<index>;` | Blob, from the blob table |
 * | `L<index>;<s><number>;` | File: the blob, name, lastModified |
 * | `I<width>;<height>;<s><value>` | ImageData: size, colour space, pixels |
 * | `P<m>` + 4 `<d>` | DOMPoint (`m` 1) or DOMPointReadOnly (0): x, y, z, w |
 * | `G<m>` + 4 `<d>` | DOMRect or DOMRectReadOnly: x, y, width, height |
 * | `X<m><n>;` + n `<d>` | DOMMatrix or DOMMatrixReadOnly: 6 values if 2D, else 16 |
 * | `U` + 4 `P` | DOMQuad |
 * | `O<s><s>` | DOMException: name, message |
 * | `H<count>;<value>*` | FileList, its Files |
 * | `Z<index>;` | CryptoKey, from the key table |
 * | `r<id>;` | an object already written, by the order it was first seen |
 *
 * A stored value is `<count>;`, then that many blobs as `<s type><bytes>;
 * <units>`, then the value. Blob bytes can only be read asynchronously, so a
 * value is first serialized with its blobs by reference — synchronously, as
 * `put()` must — and completed once their bytes arrive.
 *
 * A value holding CryptoKeys starts with a key table before all that:
 * `z<count>;`, then each key's sealed copy as `<bytes>;<units>`. A key is only
 * ever stored sealed, and read back by having the vault open it — before the
 * value is deserialized, which is synchronous. See `cryptoKeys.ts`.
 */

import { open, seal, storable } from './cryptoKeys';
import { isArrayBuffer, isDate, isSharedArrayBuffer, unitsToString } from './keys';

/** A value serialized, its blobs and keys still by reference. */
export interface Serialized {
  text: string;
  blobs: Blob[];
  keys: CryptoKey[];
}

/**
 * A stored value whose keys the vault has opened: the value as stored, and a
 * key for each entry of its table — or why they could not be had.
 */
export interface Prepared {
  text: string;
  keys: CryptoKey[];
  error?: DOMException;
}

interface Realm {
  Blob?: typeof Blob;
  File?: typeof File;
  ImageData?: typeof ImageData;
  DOMException: typeof DOMException;
  DOMPoint?: typeof DOMPoint;
  DOMPointReadOnly?: typeof DOMPointReadOnly;
  DOMRect?: typeof DOMRect;
  DOMRectReadOnly?: typeof DOMRectReadOnly;
  DOMMatrix?: typeof DOMMatrix;
  DOMMatrixReadOnly?: typeof DOMMatrixReadOnly;
  DOMQuad?: typeof DOMQuad;
  FileList?: typeof FileList;
  DataTransfer?: typeof DataTransfer;
  CryptoKey?: typeof CryptoKey;
}

let realm: Realm = globalThis as unknown as Realm;

let blobSize: ((this: Blob) => number) | undefined;
let fileName: ((this: File) => string) | undefined;
let fileModified: ((this: File) => number) | undefined;
let imageWidth: ((this: ImageData) => number) | undefined;
let pointX: ((this: never) => unknown) | undefined;
let rectWidth: ((this: never) => unknown) | undefined;
let matrixIs2D: ((this: never) => unknown) | undefined;
let quadP1: ((this: never) => unknown) | undefined;
let exceptionCode: ((this: never) => unknown) | undefined;
let fileListLength: ((this: never) => unknown) | undefined;
let keyExtractable: ((this: never) => unknown) | undefined;

function getter<T>(ctor: { prototype: object } | undefined, name: string): T | undefined {
  if (!ctor) return undefined;
  return Object.getOwnPropertyDescriptor(ctor.prototype, name)?.get as T | undefined;
}

/** Bind serialization to a realm's constructors. */
export function bindCloneRealm(target: Realm): void {
  realm = target;
  blobSize = getter(target.Blob, 'size');
  fileName = getter(target.File, 'name');
  fileModified = getter(target.File, 'lastModified');
  imageWidth = getter(target.ImageData, 'width');
  pointX = getter(target.DOMPointReadOnly, 'x');
  rectWidth = getter(target.DOMRectReadOnly, 'width');
  matrixIs2D = getter(target.DOMMatrixReadOnly, 'is2D');
  quadP1 = getter(target.DOMQuad, 'p1');
  exceptionCode = getter(target.DOMException, 'code');
  keyExtractable = getter(target.CryptoKey, 'extractable');
  fileListLength = getter(target.FileList, 'length');
}

const MATRIX_2D = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const MATRIX_3D = [
  'm11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24',
  'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44',
] as const;

bindCloneRealm(globalThis as unknown as Realm);

function brand(fn: ((this: never) => unknown) | undefined, value: object): boolean {
  if (!fn) return false;
  try {
    (fn as (this: object) => unknown).call(value);
    return true;
  } catch {
    return false;
  }
}

function dataCloneError(what: string): DOMException {
  return new realm.DOMException(`${what} could not be cloned.`, 'DataCloneError');
}

const booleanValue = Boolean.prototype.valueOf;
const numberValue = Number.prototype.valueOf;
const stringValue = String.prototype.valueOf;
const bigintValue = typeof BigInt === 'function' ? BigInt.prototype.valueOf : undefined;
const symbolValue = Symbol.prototype.valueOf;
const dateValue = Date.prototype.valueOf;
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')!.get!;
const regexpFlags = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')!.get!;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size')!.get!;
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const weakRefDeref = typeof WeakRef === 'function' ? WeakRef.prototype.deref : undefined;
const bufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
const bufferMax = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'maxByteLength')?.get;
const bufferDetached = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached')?.get;
const TypedArray = Object.getPrototypeOf(Uint8Array) as { prototype: object };
const typedTag = Object.getOwnPropertyDescriptor(TypedArray.prototype, Symbol.toStringTag)!.get!;
const VIEW_TYPES: Record<string, string> = {
  Int8Array: 'b',
  Uint8Array: 'B',
  Uint8ClampedArray: 'C',
  Int16Array: 'w',
  Uint16Array: 'W',
  Int32Array: 'd',
  Uint32Array: 'D',
  Float16Array: 'h',
  Float32Array: 'f',
  Float64Array: 'F',
  BigInt64Array: 'q',
  BigUint64Array: 'Q',
};

const VIEW_CTORS: Record<string, string> = Object.fromEntries(
  Object.entries(VIEW_TYPES).map(([name, code]) => [code, name]),
);

const ERROR_NAMES = new Set(['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError']);

/** Ordinary objects whose built-in tag is not "Object" but which clone as objects. */
const ORDINARY = new Set<unknown>([Math, JSON, Reflect, typeof Atomics === 'object' ? Atomics : undefined, typeof Intl === 'object' ? Intl : undefined]);

const objectToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;

function tryCall(fn: ((this: never, ...args: never[]) => unknown) | undefined, value: object, ...args: unknown[]): boolean {
  if (!fn) return false;
  try {
    (fn as (this: object, ...args: unknown[]) => unknown).call(value, ...args);
    return true;
  } catch {
    return false;
  }
}

function isDetached(buffer: ArrayBuffer): boolean {
  if (bufferDetached) return bufferDetached.call(buffer) as boolean;
  try {
    new Uint8Array(buffer);
    return false;
  } catch {
    return true;
  }
}

/** Bytes as a string of units, two bytes to a unit, little-end first. */
export function bytesToUnits(bytes: Uint8Array): string {
  const even = bytes.length & ~1;
  let units: Uint16Array;
  if ((bytes.byteOffset & 1) === 0) {
    units = new Uint16Array(bytes.buffer, bytes.byteOffset, even >> 1);
    if (!littleEndian) units = swap(units);
  } else {
    units = new Uint16Array(even >> 1);
    for (let i = 0, j = 0; i < even; i += 2, j++) units[j] = bytes[i] | (bytes[i + 1] << 8);
  }
  let out = unitsToString(units);
  if (bytes.length & 1) out += String.fromCharCode(bytes[bytes.length - 1]);
  return out;
}

/** The inverse of `bytesToUnits`, into a fresh buffer. */
export function unitsToBytes(text: string, at: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const pairs = length >> 1;
  for (let i = 0; i < pairs; i++) {
    const unit = text.charCodeAt(at + i);
    bytes[i * 2] = unit & 0xff;
    bytes[i * 2 + 1] = unit >> 8;
  }
  if (length & 1) bytes[length - 1] = text.charCodeAt(at + pairs);
  return bytes;
}

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function swap(units: Uint16Array): Uint16Array {
  const out = new Uint16Array(units.length);
  for (let i = 0; i < units.length; i++) out[i] = ((units[i] & 0xff) << 8) | (units[i] >> 8);
  return out;
}

function str(s: string): string {
  return 's' + s.length + ':' + s;
}

function num(n: number): string {
  return Object.is(n, -0) ? 'z' : 'd' + n + ';';
}

/**
 * Serialize a value for storage. Throws a DataCloneError for anything the
 * spec refuses, and whatever the value's own getters throw.
 */
export function serialize(value: unknown): Serialized {
  const memory = new Map<object, number>();
  const blobs: Blob[] = [];
  const keys: CryptoKey[] = [];
  let out = '';

  const write = (v: unknown): void => {
    switch (typeof v) {
      case 'undefined': out += 'u'; return;
      case 'boolean': out += v ? 't' : 'f'; return;
      case 'number': out += num(v); return;
      case 'string': out += 's' + v.length + ':' + v; return;
      case 'bigint': out += 'g' + v + ';'; return;
      case 'symbol': throw dataCloneError('A symbol');
      case 'function': throw dataCloneError('A function');
    }
    if (v === null) {
      out += 'n';
      return;
    }
    const object = v as object;
    const seen = memory.get(object);
    if (seen !== undefined) {
      out += 'r' + seen + ';';
      return;
    }
    memory.set(object, memory.size);

    if (Array.isArray(object)) {
      const length = object.length;
      const keys = Object.keys(object);
      if (keys.length === length && (length === 0 || keys[length - 1] === String(length - 1))) {
        out += 'l' + length + ';';
        for (let i = 0; i < length; i++) write(object[i]);
      } else {
        writeProperties('a' + length + ';', object, keys);
      }
      return;
    }

    const tag = objectToString.call(object);
    if (tag === '[object Object]' || ORDINARY.has(object)) {
      writeProperties('o', object, Object.keys(object));
      return;
    }

    if (isDate(object)) {
      out += 'D' + dateValue.call(object) + ';';
      return;
    }
    if (tryCall(regexpSource, object) && object !== RegExp.prototype) {
      out += 'R' + str(regexpSource.call(object) as string) + str(regexpFlags.call(object) as string);
      return;
    }
    if (tryCall(booleanValue, object)) {
      out += booleanValue.call(object) ? 'T' : 'F';
      return;
    }
    if (tryCall(numberValue, object)) {
      out += 'N' + num(numberValue.call(object));
      return;
    }
    if (tryCall(stringValue, object)) {
      out += 'W' + str(stringValue.call(object));
      return;
    }
    if (bigintValue && tryCall(bigintValue, object)) {
      out += 'Qg' + bigintValue.call(object) + ';';
      return;
    }
    if (tryCall(symbolValue, object)) throw dataCloneError('A symbol');
    if (isArrayBuffer(object)) {
      writeBuffer(object);
      return;
    }
    if (isSharedArrayBuffer(object)) throw dataCloneError('A SharedArrayBuffer');
    if (ArrayBuffer.isView(object)) {
      const buffer = object.buffer;
      if (isSharedArrayBuffer(buffer)) throw dataCloneError('A view on a SharedArrayBuffer');
      if (isDetached(buffer as ArrayBuffer)) throw dataCloneError('A detached buffer');
      const name = typedTag.call(object) as string | undefined;
      if (name === undefined) {
        out += 'VV' + object.byteOffset + ';' + object.byteLength + ';';
      } else {
        const code = VIEW_TYPES[name];
        if (!code) throw dataCloneError(`A ${name}`);
        out += 'V' + code + object.byteOffset + ';' + (object as Uint8Array).length + ';';
      }
      write(buffer);
      return;
    }
    if (tryCall(mapSize, object)) {
      const entries = [...mapEntries.call(object as Map<unknown, unknown>)];
      out += 'M' + entries.length + ';';
      for (const [k, val] of entries) {
        write(k);
        write(val);
      }
      return;
    }
    if (tryCall(setSize, object)) {
      const members = [...setValues.call(object as Set<unknown>)];
      out += 'S' + members.length + ';';
      for (const member of members) write(member);
      return;
    }
    if (isError(object, tag)) {
      const name = (object as Error).name;
      const message = Object.getOwnPropertyDescriptor(object, 'message');
      out += 'E' + str(ERROR_NAMES.has(String(name)) ? String(name) : 'Error');
      out += message && 'value' in message ? 'm' + str(String(message.value)) : 'x';
      return;
    }
    if (brand(keyExtractable, object)) {
      const extractable = Reflect.apply(keyExtractable!, object, []) as boolean;
      if (!storable(object as CryptoKey, extractable)) {
        throw dataCloneError('A non-extractable CryptoKey made where Tenna could not see it');
      }
      out += 'Z' + keys.length + ';';
      keys.push(object as CryptoKey);
      return;
    }
    if (brand(blobSize, object)) {
      const index = blobs.length;
      blobs.push(object as Blob);
      if (brand(fileName, object)) {
        const file = object as File;
        out += 'L' + index + ';' + str(fileName!.call(file)) + num(fileModified!.call(file));
      } else {
        out += 'b' + index + ';';
      }
      return;
    }
    if (brand(pointX, object)) {
      const p = object as DOMPointReadOnly;
      const mutable = realm.DOMPoint && object instanceof realm.DOMPoint ? 1 : 0;
      out += 'P' + mutable + num(p.x) + num(p.y) + num(p.z) + num(p.w);
      return;
    }
    if (brand(rectWidth, object)) {
      const r = object as DOMRectReadOnly;
      const mutable = realm.DOMRect && object instanceof realm.DOMRect ? 1 : 0;
      out += 'G' + mutable + num(r.x) + num(r.y) + num(r.width) + num(r.height);
      return;
    }
    if (brand(matrixIs2D, object)) {
      const m = object as DOMMatrixReadOnly;
      const mutable = realm.DOMMatrix && object instanceof realm.DOMMatrix ? 1 : 0;
      const names = m.is2D ? MATRIX_2D : MATRIX_3D;
      out += 'X' + mutable + names.length + ';';
      for (const name of names) out += num(m[name]);
      return;
    }
    if (brand(quadP1, object)) {
      const q = object as DOMQuad;
      out += 'U';
      for (const p of [q.p1, q.p2, q.p3, q.p4]) out += 'P0' + num(p.x) + num(p.y) + num(p.z) + num(p.w);
      return;
    }
    if (brand(exceptionCode, object)) {
      const e = object as DOMException;
      out += 'O' + str(e.name) + str(e.message);
      return;
    }
    if (brand(fileListLength, object)) {
      const files = [...(object as FileList)];
      out += 'H' + files.length + ';';
      for (const file of files) write(file);
      return;
    }
    if (brand(imageWidth, object)) {
      const image = object as ImageData;
      out += 'I' + image.width + ';' + image.height + ';' + str(image.colorSpace ?? 'srgb');
      write(image.data);
      return;
    }
    if (tryCall(weakMapHas, object, {}) || tryCall(weakSetHas, object, {}) || tryCall(weakRefDeref, object)) {
      throw dataCloneError('A weak collection');
    }
    if (tag === '[object Arguments]') {
      writeProperties('o', object, Object.keys(object));
      return;
    }
    throw dataCloneError(`An object of type ${tag.slice(8, -1)}`);
  };

  // The count goes before the properties but is only known after them: a
  // getter can delete a property that comes later, which is then skipped.
  const writeProperties = (prefix: string, object: object, keys: string[]): void => {
    const before = out;
    out = '';
    let count = 0;
    for (const key of keys) {
      if (!hasOwn.call(object, key)) continue;
      count++;
      out += 's' + key.length + ':' + key;
      write((object as Record<string, unknown>)[key]);
    }
    out = before + prefix + count + ';' + out;
  };

  const writeBuffer = (buffer: ArrayBuffer): void => {
    if (isDetached(buffer)) throw dataCloneError('A detached ArrayBuffer');
    const length = bufferByteLength.call(buffer) as number;
    const units = bytesToUnits(new Uint8Array(buffer, 0, length));
    if (bufferResizable && bufferResizable.call(buffer)) {
      out += 'Y' + (bufferMax!.call(buffer) as number) + ';' + length + ';' + units;
    } else {
      out += 'A' + length + ';' + units;
    }
  };

  write(value);
  return { text: out, blobs, keys };
}

function isError(object: object, tag: string): boolean {
  const isErrorFn = (Error as unknown as { isError?: (v: unknown) => boolean }).isError;
  if (isErrorFn) return isErrorFn(object);
  return tag === '[object Error]';
}

function keyTable(sealed: ArrayBuffer[]): string {
  if (!sealed.length) return '';
  let out = 'z' + sealed.length + ';';
  for (const copy of sealed) out += copy.byteLength + ';' + bytesToUnits(new Uint8Array(copy));
  return out;
}

/**
 * A serialized value made whole: its keys sealed and its blobs' bytes read,
 * and both put in front.
 */
export async function complete(serialized: Serialized): Promise<string> {
  const sealed = await Promise.all(serialized.keys.map(seal));
  if (serialized.blobs.length === 0) return keyTable(sealed) + '0;' + serialized.text;
  const parts = await Promise.all(serialized.blobs.map(async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return str(blob.type) + bytes.length + ';' + bytesToUnits(bytes);
  }));
  return keyTable(sealed) + serialized.blobs.length + ';' + parts.join('') + serialized.text;
}

/** A serialized value made whole, when it has nothing to wait for. */
export function completeNow(serialized: Serialized): string | undefined {
  return serialized.blobs.length === 0 && serialized.keys.length === 0 ? '0;' + serialized.text : undefined;
}

/** Whether a stored value, as the store gives it back, has keys to open. */
export function hasKeys(stored: string, from = 0): boolean {
  return stored.charCodeAt(from) === 0x7a;
}

/**
 * Open a stored value's keys, all of them, each a new key. Resolves to the
 * value ready to deserialize; one whose keys do not open deserializes to the
 * error that says so.
 */
export async function prepare(stored: string, from = 0): Promise<Prepared> {
  const reader = new Reader(stored, []);
  reader.at = from + 1;
  const count = reader.int();
  const sealed: ArrayBuffer[] = [];
  for (let i = 0; i < count; i++) sealed.push(reader.bytes(reader.int()).buffer as ArrayBuffer);
  try {
    return { text: stored, keys: await Promise.all(sealed.map(open)) };
  } catch (error) {
    return { text: stored, keys: [], error: error as DOMException };
  }
}

class Reader {
  at = 0;
  readonly memory: unknown[] = [];

  /**
   * With `fresh`, a blob is a new Blob over the same bytes rather than the
   * one given: the clone a key path is evaluated against must not carry the
   * original's expando properties.
   */
  constructor(readonly text: string, readonly blobs: Blob[], readonly fresh = false, readonly keys: CryptoKey[] = []) {}

  blob(index: number): Blob {
    const blob = this.blobs[index];
    return this.fresh ? new realm.Blob!([blob], { type: blob.type }) : blob;
  }

  int(): number {
    const end = this.text.indexOf(';', this.at);
    const n = +this.text.slice(this.at, end);
    this.at = end + 1;
    return n;
  }

  number(): number {
    const tag = this.text[this.at++];
    if (tag === 'z') return -0;
    return this.int();
  }

  string(): string {
    // 's' already consumed by the caller when reading a value; here it is not.
    this.at++;
    return this.rawString();
  }

  rawString(): string {
    const colon = this.text.indexOf(':', this.at);
    const length = +this.text.slice(this.at, colon);
    const start = colon + 1;
    this.at = start + length;
    return this.text.slice(start, this.at);
  }

  bytes(length: number): Uint8Array {
    const bytes = unitsToBytes(this.text, this.at, length);
    this.at += (length + 1) >> 1;
    return bytes;
  }

  value(): unknown {
    const tag = this.text[this.at++];
    switch (tag) {
      case 'u': return undefined;
      case 'n': return null;
      case 't': return true;
      case 'f': return false;
      case 'z': return -0;
      case 'd': return this.int();
      case 'g': {
        const end = this.text.indexOf(';', this.at);
        const n = BigInt(this.text.slice(this.at, end));
        this.at = end + 1;
        return n;
      }
      case 's': return this.rawString();
      case 'r': return this.memory[this.int()];
      case 'l': {
        const length = this.int();
        const array = new Array(length);
        this.memory.push(array);
        for (let i = 0; i < length; i++) define(array, String(i), this.value());
        return array;
      }
      case 'a': {
        const length = this.int();
        const count = this.int();
        const array = new Array(length);
        this.memory.push(array);
        for (let i = 0; i < count; i++) {
          const key = this.string();
          define(array, key, this.value());
        }
        return array;
      }
      case 'o': {
        const count = this.int();
        const object: Record<string, unknown> = {};
        this.memory.push(object);
        for (let i = 0; i < count; i++) {
          const key = this.string();
          define(object, key, this.value());
        }
        return object;
      }
      case 'T': return this.remember(Object(true));
      case 'F': return this.remember(Object(false));
      case 'N': return this.remember(Object(this.number()));
      case 'Q': {
        const slot = this.reserve();
        this.at++;
        const end = this.text.indexOf(';', this.at);
        const value = Object(BigInt(this.text.slice(this.at, end)));
        this.at = end + 1;
        this.memory[slot] = value;
        return value;
      }
      case 'W': return this.remember(Object(this.string()));
      case 'D': return this.remember(new Date(this.int()));
      case 'R': {
        const slot = this.reserve();
        const source = this.string();
        const flags = this.string();
        const regexp = new RegExp(source, flags);
        this.memory[slot] = regexp;
        return regexp;
      }
      case 'A': {
        const length = this.int();
        const slot = this.reserve();
        const buffer = this.bytes(length).buffer;
        this.memory[slot] = buffer;
        return buffer;
      }
      case 'Y': {
        const max = this.int();
        const length = this.int();
        const slot = this.reserve();
        const Resizable = ArrayBuffer as unknown as new (n: number, o: { maxByteLength: number }) => ArrayBuffer;
        const buffer = new Resizable(length, { maxByteLength: max });
        new Uint8Array(buffer).set(this.bytes(length));
        this.memory[slot] = buffer;
        return buffer;
      }
      case 'V': {
        const code = this.text[this.at++];
        const offset = this.int();
        const length = this.int();
        const slot = this.reserve();
        const buffer = this.value() as ArrayBuffer;
        let view: ArrayBufferView;
        if (code === 'V') {
          view = new DataView(buffer, offset, length);
        } else {
          const name = VIEW_CTORS[code];
          const Ctor = (globalThis as unknown as Record<string, new (b: ArrayBuffer, o: number, l?: number) => ArrayBufferView>)[name];
          if (!Ctor) throw dataCloneError(`A ${name}`);
          view = new Ctor(buffer, offset, length);
        }
        this.memory[slot] = view;
        return view;
      }
      case 'M': {
        const count = this.int();
        const map = new Map();
        this.memory.push(map);
        for (let i = 0; i < count; i++) {
          const k = this.value();
          map.set(k, this.value());
        }
        return map;
      }
      case 'S': {
        const count = this.int();
        const set = new Set();
        this.memory.push(set);
        for (let i = 0; i < count; i++) set.add(this.value());
        return set;
      }
      case 'E': {
        const slot = this.reserve();
        const name = this.string();
        const Ctor = (globalThis as unknown as Record<string, ErrorConstructor>)[ERROR_NAMES.has(name) ? name : 'Error'];
        const error = Object.create(Ctor.prototype) as Error;
        if (this.text[this.at++] === 'm') {
          Object.defineProperty(error, 'message', { value: this.string(), writable: true, configurable: true, enumerable: false });
        }
        this.memory[slot] = error;
        return error;
      }
      case 'b': return this.remember(this.blob(this.int()));
      case 'Z': {
        const key = this.keys[this.int()];
        if (!key) throw new realm.DOMException('A stored key is missing.', 'DataError');
        return this.remember(key);
      }
      case 'L': {
        const slot = this.reserve();
        const blob = this.blobs[this.int()];
        const name = this.string();
        // Always a new File: the stored blob table holds plain Blobs.
        const lastModified = this.number();
        const file = new realm.File!([blob], name, { type: blob.type, lastModified });
        this.memory[slot] = file;
        return file;
      }
      case 'I': {
        const slot = this.reserve();
        const width = this.int();
        const height = this.int();
        const colorSpace = this.string() as PredefinedColorSpace;
        const data = this.value() as Uint8ClampedArray;
        const image = new realm.ImageData!(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height, { colorSpace });
        this.memory[slot] = image;
        return image;
      }
      case 'P': {
        const slot = this.reserve();
        const point = this.point(this.text[this.at++] === '1');
        this.memory[slot] = point;
        return point;
      }
      case 'G': {
        const slot = this.reserve();
        const mutable = this.text[this.at++] === '1';
        const [x, y, width, height] = [this.number(), this.number(), this.number(), this.number()];
        const Ctor = mutable ? realm.DOMRect : realm.DOMRectReadOnly;
        if (!Ctor) throw dataCloneError('A DOMRect');
        const rect = new Ctor(x, y, width, height);
        this.memory[slot] = rect;
        return rect;
      }
      case 'X': {
        const slot = this.reserve();
        const mutable = this.text[this.at++] === '1';
        const count = this.int();
        const values = new Float64Array(count);
        for (let i = 0; i < count; i++) values[i] = this.number();
        const Ctor = mutable ? realm.DOMMatrix : realm.DOMMatrixReadOnly;
        if (!Ctor) throw dataCloneError('A DOMMatrix');
        const matrix = Ctor.fromFloat64Array(values);
        this.memory[slot] = matrix;
        return matrix;
      }
      case 'U': {
        const slot = this.reserve();
        const points: DOMPointReadOnly[] = [];
        for (let i = 0; i < 4; i++) {
          this.at++;
          points.push(this.point(this.text[this.at++] === '1'));
        }
        if (!realm.DOMQuad) throw dataCloneError('A DOMQuad');
        const quad = new realm.DOMQuad(points[0], points[1], points[2], points[3]);
        this.memory[slot] = quad;
        return quad;
      }
      case 'O': {
        const slot = this.reserve();
        const name = this.string();
        const message = this.string();
        const exception = new realm.DOMException(message, name);
        this.memory[slot] = exception;
        return exception;
      }
      case 'H': {
        const slot = this.reserve();
        const count = this.int();
        const files: File[] = [];
        for (let i = 0; i < count; i++) files.push(this.value() as File);
        // A FileList cannot be constructed, only had from a DataTransfer.
        if (!realm.DataTransfer) throw dataCloneError('A FileList');
        const transfer = new realm.DataTransfer();
        for (const file of files) transfer.items.add(file);
        this.memory[slot] = transfer.files;
        return transfer.files;
      }
      default:
        throw new Error(`Corrupt value at ${this.at - 1}`);
    }
  }

  point(mutable: boolean): DOMPointReadOnly {
    const [x, y, z, w] = [this.number(), this.number(), this.number(), this.number()];
    const Ctor = mutable ? realm.DOMPoint : realm.DOMPointReadOnly;
    if (!Ctor) throw dataCloneError('A DOMPoint');
    return new Ctor(x, y, z, w);
  }

  remember<T>(value: T): T {
    this.memory.push(value);
    return value;
  }

  reserve(): number {
    this.memory.push(undefined);
    return this.memory.length - 1;
  }
}

function define(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Deserialize a value serialized by `serialize`, its blobs still by
 * reference — the clone a key path is evaluated against before storing.
 */
export function deserializePending(serialized: Serialized): unknown {
  return new Reader(serialized.text, serialized.blobs, true, serialized.keys).value();
}

/**
 * Deserialize a stored value: the key table, the blob table, then the value.
 * One with keys must have been through `prepare` first.
 */
export function deserialize(stored: string | Prepared, from = 0): unknown {
  const prepared = typeof stored === 'string' ? null : stored;
  if (prepared?.error) throw prepared.error;
  const text = prepared ? prepared.text : (stored as string);
  const reader = new Reader(text, [], false, prepared?.keys ?? []);
  reader.at = from;
  if (hasKeys(text, from)) {
    if (!prepared) throw new realm.DOMException('A stored key was not opened.', 'DataError');
    reader.at++;
    const keys = reader.int();
    for (let i = 0; i < keys; i++) {
      const length = reader.int();
      reader.at += (length + 1) >> 1;
    }
  }
  const count = reader.int();
  for (let i = 0; i < count; i++) {
    const type = reader.string();
    const length = reader.int();
    const bytes = reader.bytes(length);
    reader.blobs.push(new realm.Blob!([bytes as Uint8Array<ArrayBuffer>], { type }));
  }
  return reader.value();
}
