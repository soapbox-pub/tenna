import { NsiteIframe } from '@/components/nsite/NsiteIframe';
import type { NsiteFrameProps } from '@/components/nsite/types';

export type { NsiteFrameProps };

/**
 * Renders an nsite, using whichever sandbox the current platform can offer.
 *
 * There is one meaningful difference between the options, and it is what the
 * seam exists for: an iframe is a nested browsing context, and a nested
 * browsing context never receives the device's safe-area insets — not
 * cross-origin, not same-origin, not even fullscreen — while no API exists to
 * define an environment variable from inside a document. So the iframe
 * implementation has to substitute the insets into every stylesheet it serves,
 * and shrink sites that don't opt into drawing under the system bars. See
 * `@/lib/safeArea`.
 *
 * A platform that can give a site its own top-level browsing context needs
 * none of that, and plugs in here.
 */
export function Nsite(props: NsiteFrameProps) {
  return <NsiteIframe {...props} />;
}
