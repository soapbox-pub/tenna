/**
 * The tile a site's icon sits on.
 *
 * Two jobs: a backdrop for glyph icons that are mostly transparent, and a
 * stand-in for sites that ship no icon at all, where the tile is all there is
 * and carries the site's initial. Either way the color comes from the site's
 * name, so a site keeps the same tile everywhere it appears, and neighbors on
 * the grid look nothing alike.
 */

/** FNV-1a with a murmur3 finalizer. The finalizer supplies the avalanche. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A CSS gradient for a name, in the app's palette.
 *
 * Hues are picked off a fixed wheel rather than anywhere in 360°, because a
 * free hue lands on olive and mustard often enough to spoil a grid. The second
 * stop is a short step around the wheel, which reads as a lit surface rather
 * than two colors meeting.
 */
export function getTileGradient(name: string): string {
  const hues = [352, 336, 16, 44, 152, 190, 214, 268, 292];
  const h = hues[hashString(`${name}#hue`) % hues.length];
  const step = 18 + (hashString(`${name}#step`) % 16);

  return `linear-gradient(150deg, hsl(${h} 72% 58%), hsl(${(h + step) % 360} 64% 42%))`;
}

/**
 * The letter to stamp on a tile with no icon: the first one the name actually
 * starts with, past any leading punctuation, and past the `www.` that a name
 * taken from a domain tends to carry.
 */
export function getTileInitial(name: string): string {
  const letter = name.replace(/^www\./i, '').match(/\p{L}|\p{N}/u);
  return (letter?.[0] ?? '?').toUpperCase();
}
