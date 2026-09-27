import { describe, expect, it } from 'vitest';

import { bytesToUnits, completeNow, complete, deserialize, deserializePending, serialize, unitsToBytes } from './clone';
import { decode, encode } from './wire';

function roundTrip<T>(value: T): T {
  const text = completeNow(serialize(value));
  expect(text).toBeDefined();
  return deserialize(text!) as T;
}

describe('structured serialization', () => {
  it('keeps primitives exactly', () => {
    for (const value of [undefined, null, true, false, 0, -0, NaN, Infinity, -Infinity, 1.5e-300, 2 ** 53 + 2, 10n ** 30n, -5n]) {
      expect(Object.is(roundTrip(value), value)).toBe(true);
    }
  });

  it('keeps strings unit for unit, lone surrogates and NULs included', () => {
    for (const value of ['', 'plain', '\u0000\u0001', '\ud800', 'a\udc00b', 's5:x', '💩', ';:[]']) {
      expect(roundTrip(value)).toBe(value);
    }
  });

  it('keeps wrappers, dates and regexps', () => {
    expect(roundTrip(Object(false))).toEqual(Object(false));
    expect(roundTrip(Object(-0)).valueOf()).toBe(-0);
    expect(roundTrip(Object('s')).valueOf()).toBe('s');
    expect(roundTrip(Object(3n)).valueOf()).toBe(3n);
    expect(roundTrip(new Date(-1e12)).getTime()).toBe(-1e12);
    expect(Number.isNaN(roundTrip(new Date(NaN)).getTime())).toBe(true);
    const r = roundTrip(/a[b]\//giu);
    expect([r.source, r.flags]).toEqual(['a[b]\\/', 'giu']);
  });

  it('keeps shared references and cycles', () => {
    const shared = { n: 1 };
    const value: Record<string, unknown> = { a: shared, b: shared, list: [shared] };
    value.self = value;
    const out = roundTrip(value);
    expect(out.a).toBe(out.b);
    expect((out.list as unknown[])[0]).toBe(out.a);
    expect(out.self).toBe(out);
  });

  it('keeps sparse arrays and their extra properties', () => {
    const value: unknown[] & { extra?: string } = [1];
    value[2] = 3;
    value[10] = 'ten';
    value.extra = 'x';
    const out = roundTrip(value);
    expect(out.length).toBe(11);
    expect(1 in out).toBe(false);
    expect(out[10]).toBe('ten');
    expect(out.extra).toBe('x');
  });

  it('keeps buffers and the views over them, sharing a buffer when they did', () => {
    const buffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 255]).buffer;
    const value = { whole: buffer, u8: new Uint8Array(buffer, 1, 3), f64: new Float64Array(new ArrayBuffer(16)), dv: new DataView(buffer, 2) };
    value.f64[1] = -1.5;
    const out = roundTrip(value);
    expect([...new Uint8Array(out.whole)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 255]);
    expect(out.u8.buffer).toBe(out.whole);
    expect([...out.u8]).toEqual([1, 2, 3]);
    expect(out.f64[1]).toBe(-1.5);
    expect(out.dv.byteOffset).toBe(2);
    expect(out.dv.getUint8(0)).toBe(2);
  });

  it('keeps maps, sets and errors', () => {
    const key = { k: 1 };
    const out = roundTrip({ map: new Map<unknown, unknown>([[key, 'v'], ['s', key]]), set: new Set([key, 2]), error: new RangeError('bad') });
    const [[k0, v0], [k1, v1]] = [...out.map];
    expect(v0).toBe('v');
    expect(k1).toBe('s');
    expect(v1).toBe(k0);
    expect([...out.set][0]).toBe(k0);
    expect(out.error).toBeInstanceOf(RangeError);
    expect(out.error.message).toBe('bad');
  });

  it('carries blobs by reference until completed, then by value', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    const serialized = serialize({ blob });
    expect(completeNow(serialized)).toBeUndefined();
    const pending = deserializePending(serialized) as { blob: Blob };
    expect(pending.blob).not.toBe(blob);
    expect(pending.blob.size).toBe(5);
    const out = deserialize(await complete(serialized)) as { blob: Blob };
    expect(out.blob.type).toBe('text/plain');
    expect(await out.blob.text()).toBe('hello');
  });

  it('refuses what cannot be cloned', () => {
    for (const value of [() => 0, Symbol('s'), new WeakMap(), Promise.resolve(), { fn() {} }]) {
      expect(() => serialize(value)).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    }
  });

  it('counts only the properties it wrote when a getter deletes a later one', () => {
    const value: Record<string, unknown> = {
      get first() {
        delete value.second;
        return 1;
      },
      second: 2,
      third: 3,
    };
    expect(roundTrip(value)).toEqual({ first: 1, third: 3 });
  });

  it('packs bytes two to a unit, odd lengths included', () => {
    for (const length of [0, 1, 2, 3, 1000, 1001]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) & 0xff);
      expect([...unitsToBytes(bytesToUnits(bytes), 0, length)]).toEqual([...bytes]);
      // And from an odd offset, which cannot be viewed as 16-bit units.
      const offset = new Uint8Array(length + 1);
      offset.set(bytes, 1);
      expect([...unitsToBytes(bytesToUnits(offset.subarray(1)), 0, length)]).toEqual([...bytes]);
    }
  });
});

describe('wire encoding', () => {
  it('round-trips nested messages with any string in them', () => {
    const message = ['tx', 'realm', '1', ['w', 'name\u0000\ud800', 1, 'inc'], [['put', 3, 's2:ab', '0;s1:x', 1, [[4, ['[', ']']]], null]], -0.5, 1e21];
    expect(decode(encode(message))).toEqual(message);
  });
});
