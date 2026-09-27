/*
 * What jsdom lacks and the conformance tests use, for the tests only.
 *
 * Run in each test window ahead of the IndexedDB bundle. The geometry types
 * and ImageData stand in for WebKit's [Serializable] ones — accessors on the
 * prototype, a mutable subclass of each read-only type — so the serializer's
 * handling of them is exercised; blob: URLs for fetch are here because two
 * tests read a stored Blob back that way.
 */
(function () {
  'use strict';

  // Every instance a shim makes, so its getters can refuse anything else as
  // WebKit's brand checks do.
  const made = new WeakSet();

  function accessors(cls, names, mutable) {
    const proto = cls.prototype;
    for (const name of names) {
      const desc = {
        get() {
          if (!made.has(this) || !(this instanceof cls)) throw new TypeError('Illegal invocation');
          return this['_' + name];
        },
        enumerable: true,
        configurable: true,
      };
      if (mutable) desc.set = function (v) { this['_' + name] = Number(v); };
      Object.defineProperty(proto, name, desc);
    }
  }

  function tag(cls, name) {
    Object.defineProperty(cls.prototype, Symbol.toStringTag, { value: name, configurable: true });
  }

  // jsdom has some of these and not others; all of them are replaced, so
  // they are one consistent set.
  {
    class DOMPointReadOnly {
      constructor(x = 0, y = 0, z = 0, w = 1) {
        Object.assign(this, { _x: +x, _y: +y, _z: +z, _w: +w });
        made.add(this);
      }
    }
    accessors(DOMPointReadOnly, ['x', 'y', 'z', 'w'], false);
    tag(DOMPointReadOnly, 'DOMPointReadOnly');
    class DOMPoint extends DOMPointReadOnly {}
    accessors(DOMPoint, ['x', 'y', 'z', 'w'], true);
    tag(DOMPoint, 'DOMPoint');
    Object.assign(self, { DOMPointReadOnly, DOMPoint });
  }

  {
    class DOMRectReadOnly {
      constructor(x = 0, y = 0, width = 0, height = 0) {
        Object.assign(this, { _x: +x, _y: +y, _width: +width, _height: +height });
        made.add(this);
      }
    }
    accessors(DOMRectReadOnly, ['x', 'y', 'width', 'height'], false);
    tag(DOMRectReadOnly, 'DOMRectReadOnly');
    class DOMRect extends DOMRectReadOnly {}
    accessors(DOMRect, ['x', 'y', 'width', 'height'], true);
    tag(DOMRect, 'DOMRect');
    Object.assign(self, { DOMRectReadOnly, DOMRect });
  }

  {
    class DOMQuad {
      constructor(p1, p2, p3, p4) {
        const P = self.DOMPoint;
        Object.assign(this, { _p1: new P(p1?.x, p1?.y, p1?.z, p1?.w), _p2: new P(p2?.x, p2?.y, p2?.z, p2?.w), _p3: new P(p3?.x, p3?.y, p3?.z, p3?.w), _p4: new P(p4?.x, p4?.y, p4?.z, p4?.w) });
        made.add(this);
      }
    }
    accessors(DOMQuad, ['p1', 'p2', 'p3', 'p4'], false);
    tag(DOMQuad, 'DOMQuad');
    self.DOMQuad = DOMQuad;
  }

  {
    const names2d = ['a', 'b', 'c', 'd', 'e', 'f'];
    const names3d = ['m11', 'm12', 'm13', 'm14', 'm21', 'm22', 'm23', 'm24', 'm31', 'm32', 'm33', 'm34', 'm41', 'm42', 'm43', 'm44'];
    class DOMMatrixReadOnly {
      constructor(init) {
        const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        let is2D = true;
        if (Array.isArray(init) && init.length === 6) {
          [m[0], m[1], m[4], m[5], m[12], m[13]] = init;
        } else if (Array.isArray(init) && init.length === 16) {
          init.forEach((v, i) => { m[i] = v; });
          is2D = false;
        }
        this._m = m;
        this._is2D = is2D;
        made.add(this);
      }
      static fromFloat64Array(array) {
        return new this(Array.from(array));
      }
      get is2D() {
        if (!made.has(this) || !(this instanceof DOMMatrixReadOnly)) throw new TypeError('Illegal invocation');
        return this._is2D;
      }
      get isIdentity() { return this._m.every((v, i) => v === (i % 5 === 0 ? 1 : 0)); }
    }
    tag(DOMMatrixReadOnly, 'DOMMatrixReadOnly');
    const index3d = (i) => i;
    const index2d = [0, 1, 4, 5, 12, 13];
    names2d.forEach((name, i) => Object.defineProperty(DOMMatrixReadOnly.prototype, name, { get() { return this._m[index2d[i]]; }, enumerable: true, configurable: true }));
    names3d.forEach((name, i) => Object.defineProperty(DOMMatrixReadOnly.prototype, name, { get() { return this._m[index3d(i)]; }, enumerable: true, configurable: true }));
    Object.defineProperty(DOMMatrixReadOnly.prototype, 'is2D', { enumerable: true });
    Object.defineProperty(DOMMatrixReadOnly.prototype, 'isIdentity', { enumerable: true });
    class DOMMatrix extends DOMMatrixReadOnly {}
    tag(DOMMatrix, 'DOMMatrix');
    Object.assign(self, { DOMMatrixReadOnly, DOMMatrix });
  }

  if (typeof self.ImageData !== 'function') {
    class ImageData {
      constructor(a, b, c) {
        if (typeof a === 'number') {
          Object.assign(this, { _width: a, _height: b, _data: new Uint8ClampedArray(a * b * 4) });
        } else {
          Object.assign(this, { _width: b, _height: c ?? a.length / 4 / b, _data: a });
        }
        this._colorSpace = 'srgb';
        made.add(this);
      }
    }
    accessors(ImageData, ['width', 'height', 'data', 'colorSpace'], false);
    tag(ImageData, 'ImageData');
    self.ImageData = ImageData;
  }

  if (typeof URL.createObjectURL !== 'function') {
    const blobs = new Map();
    let next = 0;
    URL.createObjectURL = (blob) => {
      const url = 'blob:https://wpt.test/' + next++;
      blobs.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = (url) => blobs.delete(url);
    const fetchBefore = self.fetch;
    self.fetch = async (url, init) => {
      const blob = blobs.get(String(url));
      if (!blob) return fetchBefore(url, init);
      return {
        ok: true,
        status: 200,
        blob: async () => blob,
        text: () => blob.text(),
        arrayBuffer: () => blob.arrayBuffer(),
      };
    };
  }
})();
