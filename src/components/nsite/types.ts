import type { NostrEvent } from '@nostrify/nostrify';

/**
 * The contract every nsite frame implementation satisfies.
 *
 * Deliberately expressed in terms of the *site* — its manifest event and the
 * capabilities it's granted — rather than in terms of any one delivery
 * mechanism. Serving files, isolating the origin, and exposing `window.nostr`
 * are the implementation's business: on the web that means an iframe.diy
 * sandbox frame with a Service Worker fetch proxy, and on Android a native
 * WebView with a `shouldInterceptRequest` handler.
 */
export interface NsiteFrameProps {
  /** The NIP-5A manifest event for the site being rendered. */
  event: NostrEvent;
  /** Human-readable site name, used as the frame's accessible title. */
  name: string;
  /**
   * The logged-in pubkey to expose through `window.nostr`.
   *
   * Omit to withhold the provider entirely — that's how a logged-out viewer
   * denies the site a signer rather than giving it one that fails on every
   * call. Must be supplied together with {@link onRpc}.
   */
  pubkey?: string;
  /** Handle a NIP-07 signer call from the site. */
  onRpc?: (method: string, params: unknown) => Promise<unknown>;
  /** Called once the site's document has been served and is on its way. */
  onLoad?: () => void;
  /**
   * Hide the site's pixels without unloading it.
   *
   * Used while a permission prompt is up, so the site can't paint anything
   * underneath a security decision the user is being asked to make.
   */
  concealed?: boolean;
  /**
   * The viewer has begun shutting off.
   *
   * An implementation that owns its own pixels has to play its part of the
   * shutoff itself, and start it now — the viewer's own animation is running
   * underneath and will have finished by the time this component unmounts.
   */
  closing?: boolean;
  /**
   * Ask the viewer to close.
   *
   * Raised for a back gesture the frame decided not to handle. Only the frame
   * knows whether the site had somewhere to go back to.
   */
  onRequestClose?: () => void;
  /** Applied to the frame's outermost element. */
  className?: string;
}
