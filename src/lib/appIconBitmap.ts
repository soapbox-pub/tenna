import type { NsiteApp } from '@/hooks/useNsiteApp';
import { getTileColors, getTileInitial, TILE_GRADIENT_ANGLE } from '@/lib/iconTile';

/**
 * Draws the tile from the channel wall again, as a bitmap for the launcher.
 *
 * A site put on the home screen should arrive as the thing itself, not as a
 * shortcut to it, and the tile is already what the thing looks like — the
 * site's own artwork on the colour its HTML names, with the glyph-or-picture
 * question already settled by {@code useNsiteApp}. Redrawing it here is what
 * keeps the two home screens agreeing about what a site is.
 */

/**
 * 108dp at 4x — the canvas Android hands an adaptive icon.
 *
 * The launcher masks it to its own shape and may parallax it, so the outer
 * ring is not guaranteed to survive.
 */
const SIZE = 432;

/**
 * The fraction of that canvas certain to be visible.
 *
 * The mask can take anything outside the centre 66%, and a glyph clipped by a
 * circle looks like a mistake in a way a photograph does not.
 */
const SAFE = 0.6;

/**
 * The site's tile as a base64 PNG, ready for an adaptive icon.
 *
 * Never fails: an icon that can't be fetched, decoded, or read back off the
 * canvas falls through to the lettered tile, which is what the channel wall
 * shows for a site with no artwork anyway.
 */
export async function renderAppIconPng(name: string, app?: NsiteApp): Promise<string | null> {
  const image = app?.iconUrl ? await loadImage(app.iconUrl) : null;

  const drawn = draw(name, app, image);
  if (drawn) return drawn;

  // Reading back a canvas that a hotlinked, CORS-less icon has been drawn to
  // throws — the image is still fine to *display*, which is why the tile shows
  // it, but it cannot be exported. The tile without it can.
  return image ? draw(name, app, null) : null;
}

function draw(name: string, app: NsiteApp | undefined, image: HTMLImageElement | null): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  fillBackground(ctx, name, app?.background ?? null);

  if (image) {
    drawIcon(ctx, image, app?.fit ?? 'cover');
  } else {
    drawInitial(ctx, name);
  }

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
 * A picture fills the bleed and lets the mask cut it; a glyph is kept inside
 * the safe zone where nothing can.
 */
function drawIcon(ctx: CanvasRenderingContext2D, image: HTMLImageElement, fit: 'cover' | 'contain') {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) return;

  const box = fit === 'cover' ? SIZE : SIZE * SAFE;
  const scale = fit === 'cover'
    ? Math.max(box / width, box / height)
    : Math.min(box / width, box / height);

  const drawWidth = width * scale;
  const drawHeight = height * scale;

  ctx.drawImage(image, (SIZE - drawWidth) / 2, (SIZE - drawHeight) / 2, drawWidth, drawHeight);
}

/** The stand-in for a site that ships no artwork: its initial, centred. */
function drawInitial(ctx: CanvasRenderingContext2D, name: string) {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.font = `600 ${Math.round(SIZE * 0.4)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(getTileInitial(name), SIZE / 2, SIZE / 2);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    // Blob URLs are same-origin and unaffected; a hotlinked icon needs this to
    // stand any chance of being exportable afterwards.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}
