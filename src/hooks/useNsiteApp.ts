import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery } from '@tanstack/react-query';

import { buildManifest, fetchFromBlossom, resolveServers } from '@/lib/nsiteFiles';
import { parseShareTarget, type NsiteShareTarget } from '@/lib/nsiteShareTarget';
import { getMimeType } from '@/lib/sandbox';

/** How the artwork wants to sit in its tile. */
export type IconFit = 'cover' | 'contain';

export interface NsiteApp {
  /** What the site calls itself on a home screen, if it says. */
  label: string | null;
  /** Blob URL for an icon shipped with the site, or an https URL it points at. */
  iconUrl: string | null;
  fit: IconFit;
  /** Tile color the site declares for itself, if any. Hex only. */
  background: string | null;
  /** What the site will take from the OS share sheet, if it says. */
  shareTarget: NsiteShareTarget | null;
}

const NOTHING: NsiteApp = {
  label: null,
  iconUrl: null,
  fit: 'cover',
  background: null,
  shareTarget: null,
};

/**
 * Where an icon came from, ranked. A site can declare the same picture several
 * ways, and the declarations differ in what they promise: an apple-touch-icon
 * is drawn to be a home screen icon and fills its tile edge to edge, a web app
 * manifest icon is the same thing by another name, and a favicon is a glyph
 * meant to be read at 16px in a tab. Higher wins.
 */
const RANK = { appleTouch: 300, manifest: 200, favicon: 100 } as const;

interface Candidate {
  /** URL as the site wrote it — absolute, root-relative or relative. */
  href: string;
  /** Path the href is relative to. */
  base: string;
  score: number;
  fit: IconFit;
}

/** Largest edge named in a `sizes` attribute; vector art sorts above any raster. */
function parseSizes(sizes: string | null | undefined, href: string): number {
  if (/\.svg($|[?#])/i.test(href) || sizes?.trim().toLowerCase() === 'any') return 1024;
  if (!sizes) return 0;
  let best = 0;
  for (const token of sizes.trim().split(/\s+/)) {
    const [w, h] = token.toLowerCase().split('x').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) best = Math.max(best, w, h);
  }
  return best;
}

/**
 * Rank within a class by declared size, without ever outranking the class
 * above: a 1024px favicon is still a favicon.
 */
function score(rank: number, size: number): number {
  return rank + Math.min(size, 1024) / 1025;
}

/** Only hex colors are let through — this ends up in a `style` attribute. */
function safeColor(value: string | null | undefined): string | null {
  const color = value?.trim() ?? '';
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : null;
}

/**
 * The color a site names for its own chrome.
 *
 * Sites commonly declare two, one per color scheme. The tiles sit on a dark
 * wallpaper, so the dark one is the one that belongs behind an icon; a light
 * scheme's near-white would read as a blank tile with a logo dropped on it.
 */
function pickThemeColor(doc: Document): string | null {
  const metas = [...doc.querySelectorAll('meta[name="theme-color"][content]')];
  const dark = metas.find((meta) =>
    /prefers-color-scheme:\s*dark/i.test(meta.getAttribute('media') ?? ''),
  );
  const unconditional = metas.find((meta) => !meta.getAttribute('media')?.trim());
  return safeColor((dark ?? unconditional ?? metas[0])?.getAttribute('content'));
}

/** Resolve an href against a base path, keeping only the pathname. */
function toPathname(href: string, base: string): string | null {
  try {
    return new URL(href, `https://nsite.invalid${base}`).pathname;
  } catch {
    return null;
  }
}

/**
 * Turn a declared href into something an `<img>` can load.
 *
 * Icons normally ship with the site, so when the href resolves to a path in
 * the manifest the blob is served from Blossom by hash and the rest of the URL
 * is ignored. Otherwise it's hotlinked as-is, https-only, since it comes from
 * untrusted event data.
 */
async function resolveAsset(
  candidate: Candidate,
  files: Map<string, string>,
  servers: string[],
): Promise<string | null> {
  const pathname = toPathname(candidate.href, candidate.base);
  const sha256 = pathname ? files.get(pathname) : undefined;

  if (pathname && sha256) {
    const res = await fetchFromBlossom(sha256, servers);
    const buffer = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([buffer], { type: getMimeType(pathname) }));
  }

  try {
    const url = new URL(candidate.href);
    if (url.protocol === 'https:') return url.href;
  } catch {
    // Relative URL that isn't in the manifest — the file doesn't exist.
  }
  return null;
}

/** Every icon the document declares, best first. */
function collectFromDocument(doc: Document): Candidate[] {
  const candidates: Candidate[] = [];

  for (const link of doc.querySelectorAll('link[rel][href]')) {
    const href = link.getAttribute('href')?.trim();
    if (!href) continue;

    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const sizes = parseSizes(link.getAttribute('sizes'), href);

    if (rels.some((rel) => rel.startsWith('apple-touch-icon'))) {
      candidates.push({ href, base: '/', score: score(RANK.appleTouch, sizes), fit: 'cover' });
    } else if (rels.includes('icon')) {
      candidates.push({ href, base: '/', score: score(RANK.favicon, sizes), fit: 'contain' });
    }
  }

  return candidates;
}

/** Icons named by a web app manifest, resolved relative to the manifest itself. */
function collectFromWebManifest(json: unknown, base: string): Candidate[] {
  if (typeof json !== 'object' || json === null) return [];
  const { icons } = json as { icons?: unknown };
  if (!Array.isArray(icons)) return [];

  const candidates: Candidate[] = [];

  for (const icon of icons) {
    if (typeof icon !== 'object' || icon === null) continue;
    const { src, sizes, purpose } = icon as Record<string, unknown>;
    if (typeof src !== 'string' || !src.trim()) continue;

    // Monochrome icons are a stencil for the launcher to tint, not a picture.
    const purposes = typeof purpose === 'string' ? purpose.toLowerCase().split(/\s+/) : [];
    if (purposes.length > 0 && purposes.every((p) => p === 'monochrome')) continue;

    candidates.push({
      href: src.trim(),
      base,
      score: score(RANK.manifest, parseSizes(typeof sizes === 'string' ? sizes : null, src)),
      fit: 'cover',
    });
  }

  return candidates;
}

/**
 * Files at the conventional names, for sites that ship an icon without ever
 * linking to it. Browsers probe `/favicon.ico` the same way.
 */
const CONVENTIONAL: Array<[path: string, score: number, fit: IconFit]> = [
  ['/apple-touch-icon.png', RANK.appleTouch, 'cover'],
  ['/icon.svg', RANK.favicon + 0.9, 'contain'],
  ['/icon.png', RANK.favicon + 0.8, 'contain'],
  ['/favicon.svg', RANK.favicon + 0.7, 'contain'],
  ['/favicon.png', RANK.favicon + 0.6, 'contain'],
  ['/favicon.ico', RANK.favicon + 0.5, 'contain'],
];

/** Collapse whitespace and refuse anything too long to sit under an icon. */
function tidyLabel(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= limit ? text : null;
}

/**
 * What the site calls itself on a home screen, asked for in the order a phone
 * asks.
 *
 * `short_name` is the field that exists for precisely this: the name a PWA
 * wants under its icon, where there is room for a word or two and no more.
 * iOS lets `apple-mobile-web-app-title` override it, so that goes first.
 *
 * The document title is deliberately not a fallback. It is written for a tab
 * strip and a search result — "Ditto — Your content. Your vibe. Your rules." —
 * and cutting it at the first separator to recover a name goes wrong exactly
 * where it matters: a docs site is titled after the thing it documents, so it
 * would take that thing's name and sit on the grid as a second tile with the
 * same label. A site that never declared itself an app keeps the nsite's own
 * name, which is short by nature and already distinct.
 */
function pickLabel(doc: Document, webManifest: unknown): string | null {
  const manifest = (
    typeof webManifest === 'object' && webManifest !== null ? webManifest : {}
  ) as Record<string, unknown>;

  return (
    tidyLabel(
      doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute('content'),
      48,
    ) ??
    tidyLabel(manifest.short_name, 48) ??
    tidyLabel(manifest.name, 48)
  );
}

/**
 * Whether the artwork is a glyph floating in empty space rather than a picture
 * that fills its frame.
 *
 * Sites are careless about which is which — plenty declare a padded, mostly
 * transparent favicon as their apple-touch-icon — and getting it wrong is
 * conspicuous: a glyph stretched edge to edge is grotesque, and a full-bleed
 * picture inset on a tile looks like a sticker. So the pixels get the last
 * word: if the border ring is almost entirely transparent, it's a glyph.
 *
 * Returns null when the image can't be read — an undecodable file, or a
 * hotlinked one from a server that sends no CORS headers, which taints the
 * canvas. The caller falls back to what the declaration promised.
 */
async function looksLikeGlyph(url: string): Promise<boolean | null> {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();

    const size = 32;
    const edge = 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);

    const { data } = ctx.getImageData(0, 0, size, size);
    let ring = 0;
    let clear = 0;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (x >= edge && y >= edge && x < size - edge && y < size - edge) continue;
        ring++;
        if (data[(y * size + x) * 4 + 3] < 16) clear++;
      }
    }

    return ring > 0 && clear / ring > 0.9;
  } catch {
    return null;
  }
}

/**
 * How an nsite presents itself as an app: the icon to put on its tile, the
 * color behind it, and what to call it.
 *
 * All three come out of the same pass over `/index.html` and the web app
 * manifest it links, and all three prefer the declarations meant for a home
 * screen over the ones meant for a browser tab.
 *
 * `enabled` is there for the callers with somewhere else to be: a pinned site
 * shows no tile and no bar, and fetching a document to decorate neither of
 * them would only be a Blossom round trip in the way of the site itself.
 */
export function useNsiteApp(event: NostrEvent, options?: { enabled?: boolean }) {
  return useQuery({
    enabled: options?.enabled ?? true,
    queryKey: ['nsite-app', event.id],
    queryFn: async (): Promise<NsiteApp> => {
      const files = buildManifest(event);
      const indexSha = files.get('/index.html');
      if (!indexSha) return NOTHING;

      const servers = resolveServers(event);
      const indexRes = await fetchFromBlossom(indexSha, servers);
      const doc = new DOMParser().parseFromString(await indexRes.text(), 'text/html');

      const candidates = collectFromDocument(doc);
      const themeColor = pickThemeColor(doc);
      let background = themeColor;
      let webManifest: unknown = null;
      let shareTarget: NsiteShareTarget | null = null;

      const manifestHref = doc
        .querySelector('link[rel~="manifest"][href]')
        ?.getAttribute('href')
        ?.trim();
      const manifestPath = manifestHref ? toPathname(manifestHref, '/') : null;
      const manifestSha = manifestPath ? files.get(manifestPath) : undefined;

      if (manifestPath && manifestSha) {
        try {
          const res = await fetchFromBlossom(manifestSha, servers);
          webManifest = await res.json();
          const base = manifestPath.replace(/[^/]*$/, '');
          candidates.push(...collectFromWebManifest(webManifest, base));
          // Resolved against the manifest rather than the document, which is
          // what the spec says of every URL a manifest contains.
          shareTarget = parseShareTarget(webManifest, base);
          // Only if the document named no color of its own: a manifest's
          // background_color is the color of a splash screen, which on plenty
          // of sites is plain white.
          if (!themeColor && typeof webManifest === 'object' && webManifest !== null) {
            const { background_color } = webManifest as { background_color?: unknown };
            background = safeColor(
              typeof background_color === 'string' ? background_color : null,
            );
          }
        } catch {
          // Unreadable manifest — the linked icons are the loss, not the tile.
        }
      }

      const label = pickLabel(doc, webManifest);

      for (const [path, rank, fit] of CONVENTIONAL) {
        if (files.has(path)) candidates.push({ href: path, base: '/', score: rank, fit });
      }

      candidates.sort((a, b) => b.score - a.score);

      for (const candidate of candidates) {
        const url = await resolveAsset(candidate, files, servers).catch(() => null);
        if (!url) continue;

        const glyph = await looksLikeGlyph(url);
        const fit: IconFit = glyph === null ? candidate.fit : glyph ? 'contain' : 'cover';
        return { label, iconUrl: url, fit, background, shareTarget };
      }

      return { label, iconUrl: null, fit: 'cover', background, shareTarget };
    },
    staleTime: Infinity,
    retry: 1,
  });
}
