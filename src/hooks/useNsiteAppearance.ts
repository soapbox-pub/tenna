import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery } from '@tanstack/react-query';

import { buildManifest, fetchFromBlossom, resolveServers } from '@/lib/nsiteFiles';
import { getMimeType } from '@/lib/sandbox';

export interface NsiteAppearance {
  /** A displayable URL for the site's og:image, if it declares one. */
  cover: string | null;
  /**
   * The site's declared brand color, exactly as written in its document.
   * Untrusted and unvalidated — `getTvDesign` is the one place that parses it.
   */
  themeColor: string | null;
}

/** Extract a pathname from any URL shape (absolute, relative, protocol-relative). */
function toPathname(url: string): string | null {
  try {
    return new URL(url, 'https://nsite.invalid').pathname;
  } catch {
    return null;
  }
}

/** Read `theme_color` out of a parsed webmanifest, if it's there. */
function readManifestThemeColor(json: string): string | null {
  try {
    const data: unknown = JSON.parse(json);
    if (data && typeof data === 'object' && 'theme_color' in data) {
      const value = (data as { theme_color: unknown }).theme_color;
      if (typeof value === 'string') return value;
    }
  } catch {
    // Malformed webmanifest — the set keeps its house colors.
  }
  return null;
}

/**
 * Read an nsite's `/index.html` and pull out what the channel wall needs to
 * draw it: the picture on the screen and the color of the cabinet.
 *
 * The og:image is usually an absolute URL, but the file itself typically ships
 * with the site: when its pathname appears in the manifest, the blob is served
 * from Blossom by hash and the rest of the URL is ignored. Otherwise the URL is
 * hotlinked as-is, https-only since it comes from untrusted event data.
 *
 * The brand color comes from the document's `theme-color` meta tag, falling
 * back to the `theme_color` in its webmanifest — which costs an extra fetch, so
 * it's only tried when the meta tag is missing.
 */
export function useNsiteAppearance(event: NostrEvent) {
  return useQuery({
    queryKey: ['nsite-appearance', event.id],
    queryFn: async (): Promise<NsiteAppearance> => {
      const empty: NsiteAppearance = { cover: null, themeColor: null };

      const manifest = buildManifest(event);
      const indexSha = manifest.get('/index.html');
      if (!indexSha) return empty;

      const servers = resolveServers(event);
      const indexRes = await fetchFromBlossom(indexSha, servers);
      const doc = new DOMParser().parseFromString(await indexRes.text(), 'text/html');

      /** Serve a file from the site's own manifest, by path. */
      const fromSite = async (pathname: string) => {
        const sha256 = manifest.get(pathname);
        if (!sha256) return null;
        return fetchFromBlossom(sha256, servers);
      };

      let cover: string | null = null;
      const ogUrl = (
        doc.querySelector('meta[property="og:image"]') ??
        doc.querySelector('meta[name="og:image"]')
      )?.getAttribute('content')?.trim();

      if (ogUrl) {
        const pathname = toPathname(ogUrl);
        const res = pathname ? await fromSite(pathname) : null;

        if (res && pathname) {
          const buffer = await res.arrayBuffer();
          cover = URL.createObjectURL(new Blob([buffer], { type: getMimeType(pathname) }));
        } else {
          try {
            const url = new URL(ogUrl);
            if (url.protocol === 'https:') cover = url.href;
          } catch {
            // Relative URL not present in the manifest — nothing to show.
          }
        }
      }

      let themeColor =
        (
          doc.querySelector('meta[name="theme-color"]:not([media])') ??
          doc.querySelector('meta[name="theme-color"]')
        )?.getAttribute('content')?.trim() ?? null;

      if (!themeColor) {
        const href = doc.querySelector('link[rel="manifest"]')?.getAttribute('href')?.trim();
        const pathname = href ? toPathname(href) : null;
        const res = pathname ? await fromSite(pathname) : null;
        if (res) themeColor = readManifestThemeColor(await res.text());
      }

      return { cover, themeColor };
    },
    staleTime: Infinity,
    retry: 1,
  });
}
