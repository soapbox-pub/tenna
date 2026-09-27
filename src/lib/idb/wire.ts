/**
 * The encoding of every message between the engine and its store.
 *
 * A message is a tree of strings, numbers, nulls and lists, written as a
 * prefix code so either side can read it without a JSON parser:
 *
 * | token | value |
 * |---|---|
 * | `s<length>:<units>` | string, its code units verbatim |
 * | `i<number>;` | number, as JavaScript prints it |
 * | `n` | null |
 * | `[ … ]` | list |
 *
 * Strings carry keys, values and names as they are, lone surrogates and NULs
 * included, which JSON between WebKit and Swift would not preserve: the native
 * side reads the message as UTF-16 and never turns a payload into a Swift
 * `String`.
 */

export type Wire = string | number | null | Wire[];

export function encode(value: Wire): string {
  if (typeof value === 'string') return 's' + value.length + ':' + value;
  if (typeof value === 'number') return 'i' + value + ';';
  if (value === null) return 'n';
  let out = '[';
  for (const member of value) out += encode(member);
  return out + ']';
}

export function decode(text: string): Wire {
  let at = 0;
  const read = (): Wire => {
    const tag = text[at++];
    switch (tag) {
      case 's': {
        const colon = text.indexOf(':', at);
        const length = +text.slice(at, colon);
        at = colon + 1 + length;
        return text.slice(colon + 1, at);
      }
      case 'i': {
        const end = text.indexOf(';', at);
        const n = +text.slice(at, end);
        at = end + 1;
        return n;
      }
      case 'n':
        return null;
      case '[': {
        const out: Wire[] = [];
        while (text[at] !== ']') out.push(read());
        at++;
        return out;
      }
      default:
        throw new Error(`Corrupt message at ${at - 1}`);
    }
  };
  return read();
}
