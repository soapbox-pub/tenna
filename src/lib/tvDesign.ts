/**
 * Every nsite gets its own television, assembled from a body style, an antenna
 * style, and a color palette. The assembly is a pure function of the site's
 * identity: the same site produces the same set on every load, fully formed
 * before any network request resolves.
 *
 * The palette comes from the identity rather than from the site's own declared
 * brand color, even though the brand color would be a nicer likeness. That
 * color has to be fetched out of the site's document, which lands well after
 * the set is on screen — and a television that repaints itself once you're
 * already looking at it reads as a glitch, not as a flourish.
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

/**
 * FNV-1a with a murmur3 finalizer, to turn a site's identity into a seed.
 *
 * The finalizer earns its keep here. Sites under one publisher share a long
 * common identity prefix and differ only in a short suffix, which plain FNV-1a
 * maps to a tight cluster of seeds — and a tight cluster of near-identical
 * televisions. Avalanching the result scatters them.
 */
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

/** mulberry32 — small, fast, and good enough to pick television parts. */
function mulberry32(seed: number): () => number {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Discard the first outputs, which stay correlated between nearby seeds.
  next();
  next();
  return next;
}

/** Draw one option, respecting relative weights. */
function pick<T>(rng: () => number, options: ReadonlyArray<readonly [T, number]>): T {
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let n = rng() * total;
  for (const [value, weight] of options) {
    n -= weight;
    if (n < 0) return value;
  }
  return options[options.length - 1][0];
}

/**
 * Assemble the television for a site.
 *
 * `identity` should be something stable and unique per site — its NIP-5A
 * subdomain. Everything the set needs is in that string, so a tile can draw its
 * final television the moment the channel lineup arrives.
 */
export function getTvDesign(identity: string): TvDesign {
  const rng = mulberry32(hashString(identity));

  const body = pick(rng, [
    ['classic', 3],
    ['console', 2],
    ['portable', 2],
    ['slab', 2],
  ] as const);

  const antenna = pick(rng, [
    ['pair', 4],
    ['single', 4],
    ['none', 3],
  ] as const);

  const antennaFlipped = rng() < 0.5;

  // Ball tips are loud, and a matched pair of them is louder still — the set
  // stops being furniture and starts being the thing you look at. Keep them
  // scarce, and scarcer on two rods than on one.
  const antennaBalls = rng() < (antenna === 'pair' ? 0.07 : 0.18);

  const shell = pick(rng, PRESET_SHELLS);

  const first = ACCENTS[Math.floor(rng() * ACCENTS.length)];
  const rest = ACCENTS.filter((color) => color !== first);
  const second = rest[Math.floor(rng() * rest.length)];

  const scanlineGap = 2 + Math.floor(rng() * 4);
  const roll = rng() < 0.4;
  const rollDuration = 6 + rng() * 5;
  const rollDelay = -(rng() * 6);

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
