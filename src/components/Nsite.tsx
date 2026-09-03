import { NsiteIframe } from '@/components/nsite/NsiteIframe';
import { NsiteNative } from '@/components/nsite/NsiteNative';
import type { NsiteFrameProps } from '@/components/nsite/types';
import { supportsNativeNsite } from '@/lib/nsiteNativePlugin';

export type { NsiteFrameProps };

/**
 * Renders an nsite, using whichever sandbox the current platform can offer.
 *
 * There is one meaningful difference between them, and it drives the split:
 * an iframe is a nested browsing context, and a nested browsing context never
 * receives the device's safe-area insets — not cross-origin, not same-origin,
 * not even fullscreen — while no API exists to define an environment variable
 * from inside a document. So the iframe implementation has to substitute the
 * insets into every stylesheet it serves, and shrink sites that don't opt into
 * drawing under the system bars. See `@/lib/safeArea`.
 *
 * A native WebView holds the site as its own top-level document, so
 * `viewport-fit=cover` and `env(safe-area-inset-*)` simply work, and none of
 * that applies. It also serves the site's files without routing them through
 * the Capacitor bridge, and caches them by sha256 between visits.
 *
 * The iframe remains the implementation for the web, where no other option
 * exists, and for iOS until it grows the same plugin.
 */
export function Nsite(props: NsiteFrameProps) {
  if (supportsNativeNsite()) {
    return <NsiteNative {...props} />;
  }
  return <NsiteIframe {...props} />;
}
