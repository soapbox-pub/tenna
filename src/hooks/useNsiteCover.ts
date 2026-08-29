import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery } from '@tanstack/react-query';

import { buildManifest, fetchFromBlossom, resolveServers } from '@/lib/nsiteFiles';
import { getMimeType } from '@/lib/sandbox';

/** Pull the og:image URL out of an HTML document, if declared. */
function extractOgImage(doc: Document): string | null {
  const meta =
    doc.querySelector('meta[property="og:image"]') ??
    doc.querySelector('meta[name="og:image"]');
  return meta?.getAttribute('content')?.trim() || null;
}

/** Extract a pathname from any URL shape (absolute, relative, protocol-relative). */
function toPathname(url: string): string | null {
  try {
    return new URL(url, 'https://nsite.invalid').pathname;
  } catch {
    return null;
  }
}

/**
 * Resolve the picture to run on a channel's screen: the og:image declared by
 * the nsite's `/index.html`.
 *
 * The og:image is usually an absolute URL, but the file itself typically ships
 * with the site: when its pathname appears in the manifest, the blob is served
 * from Blossom by hash and the rest of the URL is ignored. Otherwise the URL is
 * hotlinked as-is, https-only since it comes from untrusted event data.
 */
export function useNsiteCover(event: NostrEvent) {
  return useQuery({
    queryKey: ['nsite-cover', event.id],
    queryFn: async (): Promise<string | null> => {
      const manifest = buildManifest(event);
      const indexSha = manifest.get('/index.html');
      if (!indexSha) return null;

      const servers = resolveServers(event);
      const indexRes = await fetchFromBlossom(indexSha, servers);
      const doc = new DOMParser().parseFromString(await indexRes.text(), 'text/html');

      const ogUrl = extractOgImage(doc);
      if (!ogUrl) return null;

      const pathname = toPathname(ogUrl);
      const sha256 = pathname ? manifest.get(pathname) : undefined;

      if (pathname && sha256) {
        const res = await fetchFromBlossom(sha256, servers);
        const buffer = await res.arrayBuffer();
        return URL.createObjectURL(new Blob([buffer], { type: getMimeType(pathname) }));
      }

      try {
        const url = new URL(ogUrl);
        if (url.protocol === 'https:') return url.href;
      } catch {
        // Relative URL not present in the manifest — nothing to show.
      }
      return null;
    },
    staleTime: Infinity,
    retry: 1,
  });
}
