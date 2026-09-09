import type { NostrEvent } from '@nostrify/nostrify';

import type { NsiteBrowserPermissionType } from '@/lib/nsiteBrowserPermissions';
import type { NsiteShareDelivery } from '@/lib/nsiteShareTarget';

/** Whose site the bar over it says this is. */
export interface NsiteTopBarContent {
  /** What to call the site: the name it gives itself, or the nsite's own. */
  title: string;
}

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
  /**
   * Decide whether the site may reach the camera or the microphone.
   *
   * Unlike {@link onRpc} this is not withheld from a logged-out reader: what
   * it answers for is the device, not an identity. An implementation that has
   * no say in the matter ignores it — in an iframe the browser asks on its own
   * behalf, and only a frame that owns its WebView is ever consulted.
   */
  onMedia?: (kinds: NsiteBrowserPermissionType[]) => Promise<boolean>;
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
  /**
   * The navigation bar above the site, or omitted when there is none.
   *
   * What follows from a bar being there is the safe area: the bar covers the
   * status bar, so the frame beneath it is already clear of it. Its top inset
   * is zero whatever the device's is, and applying the device's would push the
   * site down by that strip twice.
   *
   * A site in a window of its own has no bar — there is nothing above it to go
   * back to — so it gets the whole screen, insets and all.
   */
  topBar?: NsiteTopBarContent;
  /**
   * Open the site on a share from the OS rather than on its front page.
   *
   * Only ever set on Android, and only for a window the share sheet opened.
   * An implementation that cannot deliver a share ignores this — the site
   * comes up as normal, which is what happens on every other platform anyway.
   */
  share?: NsiteShareDelivery;
  /**
   * Open the site at this path rather than on its front page.
   *
   * Site-absolute, and only ever set on Android: it is where a notification
   * the user tapped said to go. A path arriving after the site is loaded is a
   * navigation, not a reload — the window never closed, and taking it down to
   * land on a different URL of the same site would throw away everything it
   * had. Takes second place to {@link NsiteFrameProps.share}, since a window
   * opened to receive a share was opened for that.
   */
  openPath?: string;
  /** Applied to the frame's outermost element. */
  className?: string;
}
