/**
 * The televisions on the channel wall, each assembled from a body style, an
 * antenna style, and a color palette.
 *
 * A set belongs to its slot on the wall, not to the site playing on it. The
 * wall is furniture: the same television stands in slot 3 whether or not the
 * lineup has loaded, so a slot can be drawn before anything is known about the
 * channel, and nothing about the set changes when the channel tunes in. Tying
 * the set to the site instead meant every television on the wall changed shape
 * the moment the lineup arrived, which is the one thing furniture must not do.
 *
 * Sites still bring their own picture — that's the part that belongs to them.
 */

/** Cabinet shapes. */
export type TvBodyStyle = 'classic' | 'console' | 'portable' | 'slab';

/** Rod count on top of the set. */
export type TvAntennaStyle = 'none' | 'single' | 'pair';

export interface TvPalette {
  /** Top of the shell gradient. */
  shellLight: string;
  /** Middle of the shell gradient — also the antenna ball tips. */
  shellMid: string;
  /** Bottom of the shell gradient. */
  shellDark: string;
  /** Hardware: antenna rods, feet, legs, plinths. */
  trim: string;
  /** Two accent colors for knobs and indicator lamps. */
  knobs: [string, string];
}

export interface TvDesign {
  body: TvBodyStyle;
  antenna: TvAntennaStyle;
  /** Mirror the antenna left-to-right. */
  antennaFlipped: boolean;
  /** Ball tips on the rods — uncommon. */
  antennaBalls: boolean;
  palette: TvPalette;
  /** Scanline pitch in px. */
  scanlineGap: number;
  /** Whether this set has a rolling hum bar. */
  roll: boolean;
  /** Hum-bar sweep period in seconds. */
  rollDuration: number;
  /** Hum-bar phase offset in seconds — negative desyncs the wall. */
  rollDelay: number;
}

/** Shell colors without the accents, as stored in the house presets. */
type ShellColors = Omit<TvPalette, 'knobs'>;

const PRESET_SHELLS: ReadonlyArray<readonly [ShellColors, number]> = [
  // Lilac, the house shell — weighted so the wall still reads as Tenna's.
  [{ shellLight: '#E3CCFB', shellMid: '#A193ED', shellDark: '#5D5FA4', trim: '#2D2D33' }, 3],
  [{ shellLight: '#FFF3C4', shellMid: '#E8C55F', shellDark: '#8A6A22', trim: '#33291D' }, 2],
  [{ shellLight: '#FFD9E4', shellMid: '#F96C91', shellDark: '#8E2340', trim: '#33202A' }, 2],
  [{ shellLight: '#DFF1F6', shellMid: '#ACD2DE', shellDark: '#4A6E7C', trim: '#1E2A2F' }, 2],
  [{ shellLight: '#D8F5E1', shellMid: '#8FD9A8', shellDark: '#2F7D53', trim: '#1D2B23' }, 2],
  [{ shellLight: '#E6E2EA', shellMid: '#A9A2B4', shellDark: '#4B4756', trim: '#2A2830' }, 2],
] as const;

/** Knob and lamp accents. */
const ACCENTS = ['#FEF960', '#DA1F52', '#7CFC9B', '#ACD2DE', '#F96C91'] as const;

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
 * A uniform value in [0, 1) for one attribute of one set.
 *
 * Every attribute is hashed independently rather than drawn in sequence from a
 * single seeded generator. Slot names are short and nearly identical, and
 * successive draws from one stream stay visibly correlated across seeds that
 * close together — which showed up as runs of matching bodies and clusters of
 * ball tips down the wall. Salting the hash per attribute costs nothing and
 * decorrelates them completely.
 */
function unit(identity: string, attribute: string): number {
  return hashString(`${identity}#${attribute}`) / 4294967296;
}

/** Deterministic Fisher–Yates. */
function shuffle<T>(items: T[], salt: string): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(unit(salt, `shuffle-${i}`) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Cabinets are dealt from a reshuffling deck rather than drawn independently,
 * so every run of five slots shows all four of them. Independent draws are
 * correct on average and clumpy in the small — six slabs in the first twelve
 * slots, on the seed this shipped with — and a dozen tiles is the whole wall,
 * not a sample of it. Classic appears twice; it's the everyday set.
 */
const BODY_DECK = ['classic', 'classic', 'console', 'portable', 'slab'] as const;

function dealBody(slot: number): TvBodyStyle {
  const round = Math.floor(slot / BODY_DECK.length);
  return shuffle([...BODY_DECK], `body-deck-${round}`)[slot % BODY_DECK.length];
}

/** Draw one option, respecting relative weights. */
function pick<T>(n: number, options: ReadonlyArray<readonly [T, number]>): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let remaining = n * total;
  for (const [value, weight] of options) {
    remaining -= weight;
    if (remaining < 0) return value;
  }
  return options[options.length - 1][0];
}

/**
 * Build the television standing in a given slot on the wall.
 *
 * Slot 0 is the spare set, used for placeholders and the no-signal card.
 */
export function getTvDesign(slot: number): TvDesign {
  const id = `slot-${slot}`;

  const body = dealBody(slot);

  const antenna = pick(unit(id, 'antenna'), [
    ['pair', 4],
    ['single', 4],
    ['none', 3],
  ] as const);

  const antennaFlipped = unit(id, 'antenna-flip') < 0.5;

  // Ball tips are loud, and a matched pair of them is louder still — the set
  // stops being furniture and starts being the thing you look at. Keep them
  // scarce, and scarcer on two rods than on one.
  const antennaBalls = unit(id, 'antenna-balls') < (antenna === 'pair' ? 0.07 : 0.18);

  const shell = pick(unit(id, 'shell'), PRESET_SHELLS);

  const first = ACCENTS[Math.floor(unit(id, 'knob-a') * ACCENTS.length)];
  const rest = ACCENTS.filter((color) => color !== first);
  const second = rest[Math.floor(unit(id, 'knob-b') * rest.length)];

  const scanlineGap = 2 + Math.floor(unit(id, 'scanline-gap') * 4);
  const roll = unit(id, 'roll') < 0.4;
  const rollDuration = 6 + unit(id, 'roll-duration') * 5;
  const rollDelay = -(unit(id, 'roll-delay') * 6);

  return {
    body,
    antenna,
    antennaFlipped,
    antennaBalls,
    palette: { ...shell, knobs: [first, second] },
    scanlineGap,
    roll,
    rollDuration,
    rollDelay,
  };
}
