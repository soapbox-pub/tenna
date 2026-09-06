import { resolveIcon, type IconCandidate, type NsiteApp } from '@/hooks/useNsiteApp';

/**
 * Draws the site's monochrome icon as the mark its notifications wear.
 *
 * A notification's small icon is a silhouette: the system picks the colour and
 * all the artwork contributes is a shape. The web app manifest has a
 * declaration for exactly that — `purpose: "monochrome"` — and it is the only
 * artwork a site publishes that is drawn to be one, so it is the only artwork
 * used here. A site that declares none keeps Tenna's television, which is
 * honest: better a mark that says "some site" than a full-colour tile
 * flattened into a smudge.
 *
 * What comes back is the shape and its alpha, at a size worth downscaling
 * from. The white is painted on natively, at the density of the screen the
 * notification is actually posted to — see `NappBadges.java`.
 */

/** Comfortably above any status bar's 24dp, whatever the density. */
const SIZE = 192;

/**
 * How much of the canvas the shape fills once its own margins are taken off.
 *
 * A status bar icon is a glyph in a 24dp box with a little air around it.
 * Sites are inconsistent about whether they baked that air in, so it is
 * measured off and put back at one size — the same argument `appIconBitmap`
 * makes for a tile, at a scale where the difference is far more visible.
 */
const TARGET = 0.9;

/** Below this, a margin isn't a margin and redrawing would only resample. */
const WORTH_TRIMMING = 0.98;

/** Renders already made. A site's mark is asked for on open, on pin and on sync. */
const RENDERED = new Map<string, Promise<string | null>>();

/**
 * The site's monochrome mark as a base64 PNG, or null if it declares none.
 *
 * Never throws: an icon that cannot be fetched or decoded is a site without
 * one, which is a case that has to work anyway.
 */
export function renderAppBadgePng(app?: NsiteApp): Promise<string | null> {
  const best = app?.monochrome[0];
  if (!app || !best) return Promise.resolve(null);

  const key = `${best.base}\u0000${best.href}`;
  const cached = RENDERED.get(key);
  if (cached) return cached;

  const rendering = render(app, best);
  RENDERED.set(key, rendering);
  return rendering;
}

async function render(app: NsiteApp, candidate: IconCandidate): Promise<string | null> {
  const url = await resolveIcon(candidate, app.source).catch(() => null);
  if (!url) return null;

  const image = await loadImage(url);
  if (!image) return null;

  // No intrinsic size is the usual SVG with a `viewBox` and no width. There is
  // nothing to scale from, and drawing it anyway lands whatever the browser
  // guessed in the middle of the canvas.
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const first = place(width, height);
  ctx.drawImage(image, first.x, first.y, width * first.factor, height * first.factor);

  const crop = trim(ctx, first, width, height);
  if (crop) {
    const second = place(crop.width, crop.height);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(
      image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      second.x,
      second.y,
      crop.width * second.factor,
      crop.height * second.factor,
    );
  }

  try {
    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  } catch {
    return null;
  }
}

/** Where a source of this shape sits on the canvas, contained and centred. */
function place(width: number, height: number): { factor: number; x: number; y: number } {
  const box = SIZE * TARGET;
  const factor = Math.min(box / width, box / height);
  return { factor, x: (SIZE - width * factor) / 2, y: (SIZE - height * factor) / 2 };
}

/** The part of the source that is actually the shape, in the source's pixels. */
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The margins the site baked into its own artwork, measured off what was just
 * drawn and given back in source pixels.
 *
 * Null when there is nothing to do about them: a canvas that cannot be read —
 * a hotlinked icon from a server that sends no CORS headers taints it — one
 * with nothing on it, and one whose shape already fills what it was given.
 */
function trim(
  ctx: CanvasRenderingContext2D,
  placed: { factor: number; x: number; y: number },
  width: number,
  height: number,
): Crop | null {
  let data: Uint8ClampedArray;
  try {
    ({ data } = ctx.getImageData(0, 0, SIZE, SIZE));
  } catch {
    return null;
  }

  let left = SIZE;
  let top = SIZE;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (data[(y * SIZE + x) * 4 + 3] < 16) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) return null;

  // Back through the placement that drew it, and clamped: antialiasing at the
  // edges can put an opaque pixel a hair outside where the source was laid.
  const crop: Crop = {
    x: clamp((left - placed.x) / placed.factor, 0, width),
    y: clamp((top - placed.y) / placed.factor, 0, height),
    width: 0,
    height: 0,
  };
  crop.width = clamp((right + 1 - placed.x) / placed.factor, 0, width) - crop.x;
  crop.height = clamp((bottom + 1 - placed.y) / placed.factor, 0, height) - crop.y;

  if (crop.width <= 0 || crop.height <= 0) return null;
  if (crop.width > width * WORTH_TRIMMING && crop.height > height * WORTH_TRIMMING) return null;

  return crop;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * An icon, decoded, asked for anonymously first.
 *
 * An image fetched with CORS can be read back off the canvas and one fetched
 * without it cannot, and being readable is what lets the margins be measured.
 * A server that declines is asked again without, since a shape that can only
 * be drawn is still a shape.
 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return decodeImage(src, 'anonymous').then((image) => image ?? decodeImage(src, null));
}

function decodeImage(src: string, crossOrigin: string | null): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = crossOrigin;
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
