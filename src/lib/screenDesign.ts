/**
 * The screens on the channel wall. Every screen is the same size and the same
 * shape; what varies is how each tube behaves — scanline pitch, whether it
 * carries a rolling hum bar, and how its brightness wanders.
 *
 * A screen's behavior belongs to its slot on the wall, not to the site playing
 * on it. The wall is furniture: the same tube sits in slot 3 whether or not the
 * lineup has loaded, so a slot can be drawn before anything is known about the
 * channel, and nothing about the screen changes when the channel tunes in.
 * Tying it to the site instead meant every screen on the wall changed the
 * moment the lineup arrived, which is the one thing furniture must not do.
 *
 * Sites still bring their own picture — that's the part that belongs to them.
 */

export interface ScreenDesign {
  /** Scanline pitch in px. */
  scanlineGap: number;
  /** Whether this screen has a rolling hum bar. */
  roll: boolean;
  /** Hum-bar sweep period in seconds. */
  rollDuration: number;
  /** Hum-bar phase offset in seconds — negative desyncs the wall. */
  rollDelay: number;
  /** Brightness-flicker period in seconds. */
  flickerDuration: number;
  /** Flicker phase offset in seconds — negative desyncs the wall. */
  flickerDelay: number;
}

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
 * A uniform value in [0, 1) for one attribute of one screen.
 *
 * Every attribute is hashed independently rather than drawn in sequence from a
 * single seeded generator. Slot names are short and nearly identical, and
 * successive draws from one stream stay visibly correlated across seeds that
 * close together — which showed up as runs of matching sets down the wall.
 * Salting the hash per attribute costs nothing and decorrelates them.
 */
function unit(identity: string, attribute: string): number {
  return hashString(`${identity}#${attribute}`) / 4294967296;
}

/**
 * Build the screen sitting in a given slot on the wall.
 *
 * Slot 0 is the spare set, used for placeholders and the no-signal card.
 */
export function getScreenDesign(slot: number): ScreenDesign {
  const id = `slot-${slot}`;

  const scanlineGap = 2 + Math.floor(unit(id, 'scanline-gap') * 4);
  const roll = unit(id, 'roll') < 0.4;
  const rollDuration = 6 + unit(id, 'roll-duration') * 5;
  const rollDelay = -(unit(id, 'roll-delay') * 6);

  const flickerDuration = 3 + unit(id, 'flicker-duration') * 3;
  const flickerDelay = -(unit(id, 'flicker-delay') * 6);

  return {
    scanlineGap,
    roll,
    rollDuration,
    rollDelay,
    flickerDuration,
    flickerDelay,
  };
}
