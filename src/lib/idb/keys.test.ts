import { describe, expect, it } from 'vitest';

import { arrayKey, arrayMembers, keyNumber, keyToValue, keyType, numberKey, toKey } from './keys';

/** The spec's "compare two keys", written out directly from the spec's steps. */
function specCompare(a: unknown, b: unknown): number {
  const type = (v: unknown) =>
    typeof v === 'number' ? 0 : v instanceof Date ? 1 : typeof v === 'string' ? 2 : v instanceof ArrayBuffer ? 3 : 4;
  const ta = type(a);
  const tb = type(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  switch (ta) {
    case 0:
    case 1: {
      const x = ta === 0 ? (a as number) : (a as Date).getTime();
      const y = ta === 0 ? (b as number) : (b as Date).getTime();
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 2:
      return a === b ? 0 : (a as string) < (b as string) ? -1 : 1;
    case 3: {
      const x = new Uint8Array(a as ArrayBuffer);
      const y = new Uint8Array(b as ArrayBuffer);
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    }
    default: {
      const x = a as unknown[];
      const y = b as unknown[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = specCompare(x[i], y[i]);
        if (c) return c;
      }
      return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
    }
  }
}

/** A deterministic generator, so a failure reproduces. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomKey(next: () => number, depth = 0): unknown {
  const pick = next();
  if (pick < 0.3) {
    const special = [0, -0, 1, -1, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 0.5, 2 ** 53];
    return next() < 0.3 ? special[Math.floor(next() * special.length)] : (next() - 0.5) * 10 ** Math.floor(next() * 20);
  }
  if (pick < 0.45) return new Date(Math.floor((next() - 0.5) * 1e13));
  if (pick < 0.7) {
    // Units that exercise the escapes and the surrogate range.
    const units = [0, 1, 2, 0x41, 0xd800, 0xdc00, 0xffff, 0xfffe];
    let s = '';
    const n = Math.floor(next() * 5);
    for (let i = 0; i < n; i++) s += String.fromCharCode(next() < 0.5 ? units[Math.floor(next() * units.length)] : Math.floor(next() * 0x10000));
    return s;
  }
  if (pick < 0.85) {
    const bytes = new Uint8Array(Math.floor(next() * 5));
    for (let i = 0; i < bytes.length; i++) bytes[i] = next() < 0.3 ? [0, 1, 255][Math.floor(next() * 3)] : Math.floor(next() * 256);
    return bytes.buffer;
  }
  if (depth > 2) return 'leaf';
  const n = Math.floor(next() * 4);
  return Array.from({ length: n }, () => randomKey(next, depth + 1));
}

function normalize(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { binary: [...new Uint8Array(value)] };
  if (value instanceof Date) return { date: value.getTime() };
  if (Array.isArray(value)) return value.map(normalize);
  if (Object.is(value, -0)) return 0;
  return value;
}

describe('key encoding', () => {
  it('orders keys as the spec compares them', () => {
    const next = random(42);
    for (let i = 0; i < 20000; i++) {
      const a = randomKey(next);
      const b = randomKey(next);
      const ka = toKey(a)!;
      const kb = toKey(b)!;
      const encoded = ka < kb ? -1 : ka > kb ? 1 : 0;
      expect(encoded, `${JSON.stringify(normalize(a))} vs ${JSON.stringify(normalize(b))}`).toBe(specCompare(a, b));
    }
  });

  it('decodes to the value it encoded', () => {
    const next = random(7);
    for (let i = 0; i < 5000; i++) {
      const value = randomKey(next);
      expect(normalize(keyToValue(toKey(value)!))).toEqual(normalize(value));
    }
  });

  it('refuses what is not a key', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    const holey: unknown[] = [];
    holey[1] = 1;
    for (const value of [NaN, new Date(NaN), undefined, null, true, {}, Symbol('s'), [NaN], holey, cyclic, () => 0]) {
      expect(toKey(value)).toBeNull();
    }
  });

  it('reads binary keys from views, respecting their window', () => {
    const buffer = new Uint8Array([9, 1, 2, 3, 9]).buffer;
    expect(toKey(new Uint8Array(buffer, 1, 3))).toBe(toKey(new Uint8Array([1, 2, 3]).buffer));
    expect(toKey(new DataView(buffer, 1, 3))).toBe(toKey(new Uint8Array([1, 2, 3]).buffer));
  });

  it('treats -0 and 0 as one key', () => {
    expect(toKey(-0)).toBe(toKey(0));
  });

  it('splits and joins array keys', () => {
    const key = toKey([1, 'a', [new Uint8Array([0]).buffer]])!;
    const members = arrayMembers(key);
    expect(members).toEqual([toKey(1), toKey('a'), toKey([new Uint8Array([0]).buffer])]);
    expect(arrayKey(members)).toBe(key);
  });

  it('knows a key\'s type and number', () => {
    expect(keyType(toKey(1)!)).toBe('number');
    expect(keyType(toKey(new Date(0))!)).toBe('date');
    expect(keyType(toKey('')!)).toBe('string');
    expect(keyType(toKey(new ArrayBuffer(0))!)).toBe('binary');
    expect(keyType(toKey([])!)).toBe('array');
    expect(keyNumber(numberKey(2 ** 53))).toBe(2 ** 53);
    expect(keyNumber(toKey('1')!)).toBeUndefined();
  });
});
