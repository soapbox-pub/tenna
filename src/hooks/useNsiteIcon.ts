import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery } from '@tanstack/react-query';

import { buildManifest, fetchFromBlossom, resolveServers } from '@/lib/nsiteFiles';
import { getMimeType } from '@/lib/sandbox';

/** Manifest paths checked (in order) for a usable channel icon. */
const ICON_PATHS = [
  '/apple-touch-icon.png',
  '/icon.png',
  '/logo.png',
  '/favicon.png',
  '/favicon.svg',
];

/**
 * Fetch an nsite's icon from Blossom via its manifest, as an object URL.
 * Resolves to null when the site ships no recognizable icon.
 */
export function useNsiteIcon(event: NostrEvent) {
  return useQuery({
    queryKey: ['nsite-icon', event.id],
    queryFn: async (): Promise<string | null> => {
      const manifest = buildManifest(event);
      const iconPath = ICON_PATHS.find((path) => manifest.has(path));
      if (!iconPath) return null;

      const sha256 = manifest.get(iconPath)!;
      const res = await fetchFromBlossom(sha256, resolveServers(event));
      const buffer = await res.arrayBuffer();
      // Blossom servers often return wrong Content-Types; the manifest path
      // is authoritative.
      const blob = new Blob([buffer], { type: getMimeType(iconPath) });
      return URL.createObjectURL(blob);
    },
    staleTime: Infinity,
    retry: 1,
  });
}
