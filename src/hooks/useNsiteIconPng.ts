import { useQuery } from '@tanstack/react-query';

import type { NsiteApp } from '@/hooks/useNsiteApp';
import { renderAppIconPng } from '@/lib/appIconBitmap';

/**
 * Edge of the tile drawn for the bar, in pixels.
 *
 * Four times the ~24dp it is shown at, so it survives the densest screen, and
 * small enough that the base64 of it is a few kilobytes rather than a hundred.
 */
const SIZE = 96;

/**
 * The site's tile as a base64 PNG, for chrome that isn't drawn in React.
 *
 * The Android nsite bar is native views over a native WebView, so it cannot be
 * handed the blob URL an `<img>` would take — the picture has to cross the
 * bridge as bytes. Redrawing the tile the channel wall already draws is what
 * keeps the bar and the wall agreeing about what a site looks like.
 *
 * Returns undefined until there is one, and stays undefined for a site whose
 * artwork can't be read back off a canvas. The bar simply goes without.
 */
export function useNsiteIconPng(
  name: string,
  app: NsiteApp | undefined,
  enabled: boolean,
): string | undefined {
  const { data } = useQuery({
    enabled,
    // Keyed on the picture rather than the site: the same artwork on the same
    // colour is the same tile, and nothing else about the site changes it.
    queryKey: ['nsite-icon-png', name, app?.iconUrl ?? null, app?.background ?? null, app?.fit],
    queryFn: () => renderAppIconPng(name, app, SIZE),
    staleTime: Infinity,
  });

  return data ?? undefined;
}
