import { resolveIcon, type IconCandidate, type NsiteApp } from '@/hooks/useNsiteApp';
import { getTileColors, getTileInitial, TILE_GRADIENT_ANGLE } from '@/lib/iconTile';

/**
 * Draws the site's icon again, as a bitmap for the launcher.
 *
 * A site put on the home screen should arrive as the thing itself, not as a
 * shortcut to it, so this aims at the tile on the channel wall — the site's own
 * artwork on the colour its HTML names. It is not, however, the same drawing.
 * A tile is 72px of squircle showing very nearly the whole square; an adaptive
 * icon is 432px with a third of it masked away and never seen. The same
 * full-bleed draw that fits the first crops the artwork out of the second.
 *
 * So the wall's icon is not simply reused. The candidates are ranked again for
 * this canvas — see {@link launcherScore} — and framed for the mask rather than
 * for the squircle.
 */

/**
 * 108dp at 4x — the canvas Android hands an adaptive icon.
 *
 * The launcher masks it to its own shape and may parallax it, so the outer
 * ring is not guaranteed to survive.
 */
const SIZE = 432;

/**
 * The fraction of that canvas certain to be visible: 72dp of the 108dp.
 *
 * Everything outside it belongs to the mask and the parallax, and is drawn on
 * the understanding that it may never be seen.
 */
const VIEWPORT = 72 / 108;

/**
 * How much of that visible circle the artwork should fill.
 *
 * Four fifths is about where a launcher icon sits — enough that the site is
 * legible at a glance, with the margin that keeps it from looking like it is
 * pressing against the mask.
 */
const TARGET = 0.8;

/** Resolution the artwork is inspected at. Coarse, and it only has to be. */
const SAMPLE = 64;

/** Width of the border ring read to decide what an icon is sitting on. */
const RING = 4;

/**
 * The site's icon as a base64 PNG, ready for an adaptive icon.
 *
 * Never fails: an icon that can't be fetched, decoded, or read back off the
 * canvas falls through to the lettered tile, which is what the channel wall
 * shows for a site with no artwork anyway.
 */
export function renderAppIconPng(name: string, app?: NsiteApp): Promise<string | null> {
  // Keyed on the tile the wall resolved, which stands in for the site: the
  // query behind it is cached for the session, so the same site asks with the
  // same key and a site that has changed asks with a different one.
  const key = `${name}\u0000${app?.iconUrl ?? ''}`;

  const cached = RENDERED.get(key);
  if (cached) return cached;

  const rendering = render(name, app);
  RENDERED.set(key, rendering);
  return rendering;
}

/**
 * Renders already made, because three callers want the same one.
 *
 * A site is opened, pinned, and reconciled with the share sheet, and each of
 * those asks for its icon — which costs a Blossom round trip for artwork the
 * wall had no reason to fetch, on the tap that opens the site. Doing it once
 * is the difference between that being paid on the first tap and on every one.
 */
const RENDERED = new Map<string, Promise<string | null>>();

async function render(name: string, app?: NsiteApp): Promise<string | null> {
  const picked = app ? await pickLauncherIcon(app) : null;
  const image = picked ? await loadImage(picked.url) : null;

  const framing = image ? frame(image, picked?.candidate) : null;

  const drawn = draw(name, app, image, framing);
  if (drawn) return drawn;

  // Reading back a canvas that a hotlinked, CORS-less icon has been drawn to
  // throws — the image is still fine to *display*, which is why the tile shows
  // it, but it cannot be exported. The tile without it can.
  return image ? draw(name, app, null, null) : null;
}

/**
 * How well an icon suits a 432px canvas that will be masked, which is a
 * different question from how well it suits a tile. Higher wins.
 *
 * A `maskable` icon comes first — not because its padding can be relied on,
 * which it cannot and which is why {@link frame} measures instead, but because
 * declaring one means somebody drew a square with a launcher in mind, and that
 * is the best guess available about which of a site's icons is meant for this.
 * After that, size is what matters at this scale: vector art at any size, then
 * any raster big enough not to be enlarged. Sites offering nothing large enough
 * are left to the wall's judgement, which is as good as any when every
 * candidate is going to be blown up regardless.
 */
function launcherScore(candidate: IconCandidate): number {
  if (candidate.maskable) return 3000 + candidate.size;
  if (candidate.size >= SIZE) return 2000 + Math.min(candidate.size, 1024);
  return candidate.score;
}

/**
 * The best icon this site has for a launcher, fetched.
 *
 * Resolved here rather than on the wall because most sites are never pinned,
 * and a blob nobody asks for is a Blossom round trip spent on nothing. The
 * wall's own icon is the fallback, so a site whose candidates all fail to
 * resolve still gets whatever the tile is already showing.
 */
async function pickLauncherIcon(
  app: NsiteApp,
): Promise<{ url: string; candidate?: IconCandidate } | null> {
  const ranked = [...app.icons].sort((a, b) => launcherScore(b) - launcherScore(a));

  for (const candidate of ranked) {
    const url = await resolveIcon(candidate, app.source).catch(() => null);
    if (url) return { url, candidate };
  }

  return app.iconUrl ? { url: app.iconUrl } : null;
}

interface Framing {
  /** Fraction of the canvas the source square is drawn across. */
  scale: number;
  /** Colour to lay under it, when the icon brings its own. */
  background: string | null;
}

/**
 * How much of the canvas the artwork should cover, and what goes behind it.
 *
 * The declaration is not what settles this, because it is routinely wrong. A
 * `maskable` icon is supposed to keep its content inside the circle the mask
 * guarantees, and plenty of sites label an ordinary icon that way and clip
 * themselves; others ship a well-padded icon and never say so. Both mistakes
 * are visible from the pixels, so the pixels decide.
 *
 * What is measured is how far the artwork reaches from the centre. Scaling
 * that to a fixed share of the visible circle gives every site the same weight
 * on the home screen whatever padding its author baked in, and — since the
 * flat field an icon sits on is extended underneath it — the mask ends up
 * cutting nothing but more of the site's own colour.
 *
 * A picture with no flat field is the one thing left to fill the canvas: there
 * is no colour to extend, and being cropped is what a photograph is for.
 */
function frame(image: HTMLImageElement, candidate?: IconCandidate): Framing {
  const art = measure(image);

  // Unreadable — a tainted canvas, or an image that won't decode. The
  // declaration is all there is to go on.
  if (!art) {
    return candidate?.fit === 'contain'
      ? { scale: VIEWPORT * TARGET, background: null }
      : { scale: VIEWPORT, background: null };
  }

  // Busy right out to the edges. Nothing to extend, so let it bleed.
  if (art.radius === null) return { scale: 1, background: null };

  return {
    // Never past a full bleed: enlarging the source would crop it, which is
    // the thing this exists to avoid.
    scale: Math.min(1, (VIEWPORT * TARGET) / art.radius),
    background: art.background,
  };
}

interface Art {
  /**
   * How far the artwork reaches from the centre, as a fraction of the source's
   * half-width. Null when there is no field to measure it against.
   */
  radius: number | null;
  /** The flat field it sits on, if that field is opaque. */
  background: string | null;
}

/**
 * What an icon is, read off its pixels.
 *
 * The border ring says what the artwork sits on: see-through means a glyph
 * over whatever is behind it, one flat colour means a logo on a field that can
 * be extended, and anything else means a picture. In the first two cases the
 * rest of the image can then be measured against that field to find where the
 * artwork actually stops — which is the number the framing turns on, and the
 * one no site reliably declares.
 *
 * Returns null when the image can't be read: a hotlinked icon from a server
 * that sends no CORS headers taints the canvas.
 */
function measure(image: HTMLImageElement): Art | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    ({ data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE));
  } catch {
    return null;
  }

  const ring: number[] = [];
  for (let y = 0; y < SAMPLE; y++) {
    for (let x = 0; x < SAMPLE; x++) {
      if (x >= RING && y >= RING && x < SAMPLE - RING && y < SAMPLE - RING) continue;
      ring.push((y * SAMPLE + x) * 4);
    }
  }

  const clear = ring.filter((i) => data[i + 3] < 16).length;
  const transparent = clear / ring.length > 0.9;
  const field = transparent ? null : flatColor(data, ring);

  // Opaque and busy at the edges: a photograph, with no field to measure from.
  if (!transparent && !field) return { radius: null, background: null };

  return { radius: reach(data, field), background: field?.css ?? null };
}

/**
 * How far from the centre the artwork gets, as a fraction of the half-width.
 *
 * A pixel counts as artwork if it differs from the field the icon sits on —
 * by being opaque where the field is transparency, or by being another colour
 * where the field is a colour. Measured from the centre rather than as a
 * bounding box because the mask is round: what matters is the furthest the
 * artwork gets from the middle, in any direction.
 */
function reach(data: Uint8ClampedArray, field: FlatColor | null): number {
  const centre = SAMPLE / 2;
  let furthest = 0;

  for (let y = 0; y < SAMPLE; y++) {
    for (let x = 0; x < SAMPLE; x++) {
      const i = (y * SAMPLE + x) * 4;

      if (data[i + 3] < 16) continue;
      if (field && near(data, i, field)) continue;

      // The pixel's far corner, so a shape is measured by its extent rather
      // than by the centres of the pixels along its edge.
      const dx = Math.abs(x + 0.5 - centre) + 0.5;
      const dy = Math.abs(y + 0.5 - centre) + 0.5;
      furthest = Math.max(furthest, Math.sqrt(dx * dx + dy * dy));
    }
  }

  // Nothing but field: an icon that is a single flat colour and no artwork.
  // Treated as reaching everywhere, so it is left to fill its tile.
  return furthest === 0 ? 1 : furthest / centre;
}

interface FlatColor {
  rgb: [number, number, number];
  css: string;
}

/** How far a channel may stray from the mean and still count as the same colour. */
const TOLERANCE = 12;

function near(data: Uint8ClampedArray, i: number, field: FlatColor): boolean {
  return (
    Math.abs(data[i] - field.rgb[0]) <= TOLERANCE &&
    Math.abs(data[i + 1] - field.rgb[1]) <= TOLERANCE &&
    Math.abs(data[i + 2] - field.rgb[2]) <= TOLERANCE
  );
}

/**
 * The one colour a set of pixels is, or null if they are more than one.
 *
 * The tolerance is loose enough to survive PNG dithering and the resampling
 * done to get here, and tight enough that a gradient or a photograph fails it.
 */
function flatColor(data: Uint8ClampedArray, offsets: number[]): FlatColor | null {
  const opaque = offsets.filter((i) => data[i + 3] >= 16);
  if (opaque.length === 0) return null;

  const mean: [number, number, number] = [0, 0, 0];
  for (const i of opaque) {
    for (let c = 0; c < 3; c++) mean[c] += data[i + c];
  }
  for (let c = 0; c < 3; c++) mean[c] = Math.round(mean[c] / opaque.length);

  const field: FlatColor = { rgb: mean, css: `rgb(${mean[0]}, ${mean[1]}, ${mean[2]})` };
  return opaque.every((i) => near(data, i, field)) ? field : null;
}

function draw(
  name: string,
  app: NsiteApp | undefined,
  image: HTMLImageElement | null,
  framing: Framing | null,
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Every icon worth having is smaller than this canvas, so all of them are
  // being enlarged; the default filter makes that look like a mistake.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  fillBackground(ctx, name, framing?.background ?? app?.background ?? null);

  if (image && framing && drawIcon(ctx, image, framing.scale)) return read(canvas);

  drawInitial(ctx, name);
  return read(canvas);
}

function read(canvas: HTMLCanvasElement): string | null {
  try {
    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  } catch {
    return null;
  }
}

/** The site's declared colour, or its gradient, across the whole bleed. */
function fillBackground(ctx: CanvasRenderingContext2D, name: string, background: string | null) {
  if (background) {
    ctx.fillStyle = background;
  } else {
    const [from, to] = getTileColors(name);
    const gradient = ctx.createLinearGradient(...gradientLine(TILE_GRADIENT_ANGLE, SIZE));
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    ctx.fillStyle = gradient;
  }

  ctx.fillRect(0, 0, SIZE, SIZE);
}

/**
 * The endpoints of a CSS gradient line on a square, for the canvas equivalent.
 *
 * CSS measures the angle clockwise from straight up and sizes the line so both
 * stops reach the corners; a canvas gradient is two points. Without the
 * conversion the tile on the home screen would be lit from a different
 * direction than the one on the channel wall.
 */
function gradientLine(degrees: number, size: number): [number, number, number, number] {
  const radians = (degrees * Math.PI) / 180;
  const dx = Math.sin(radians);
  // Screen coordinates run downwards, CSS angles upwards.
  const dy = -Math.cos(radians);

  const half = (size * (Math.abs(dx) + Math.abs(dy))) / 2;
  const centre = size / 2;

  return [centre - dx * half, centre - dy * half, centre + dx * half, centre + dy * half];
}

/**
 * The artwork, centred, sized so its longer edge spans the given fraction of
 * the canvas. False if there was nothing to draw.
 *
 * A source with no intrinsic size is the usual SVG that carries a `viewBox`
 * and no width — there is nothing to scale from, and drawing it anyway lands
 * whatever the browser guessed in the middle of the tile.
 */
function drawIcon(ctx: CanvasRenderingContext2D, image: HTMLImageElement, scale: number): boolean {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return false;

  const box = SIZE * scale;
  const factor = Math.min(box / width, box / height);

  const drawWidth = width * factor;
  const drawHeight = height * factor;

  ctx.drawImage(image, (SIZE - drawWidth) / 2, (SIZE - drawHeight) / 2, drawWidth, drawHeight);
  return true;
}

/** The stand-in for a site that ships no artwork: its initial, centred. */
function drawInitial(ctx: CanvasRenderingContext2D, name: string) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.font = `600 ${Math.round(SIZE * 0.4)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(getTileInitial(name), SIZE / 2, SIZE / 2);
}

/**
 * An icon, decoded.
 *
 * Asked for anonymously first, because an image fetched with CORS can be read
 * back off the canvas afterwards and one fetched without it cannot — and being
 * readable is what tells a glyph from a picture and finds the colour to extend.
 * A server that declines the request outright is then asked again without it,
 * since a picture that can only be drawn is still better than no picture.
 */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  // Blob URLs are same-origin and unaffected either way.
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
