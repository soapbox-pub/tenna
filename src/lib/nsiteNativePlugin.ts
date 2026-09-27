import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import type { NsiteBrowserPermissionType } from '@/lib/nsiteBrowserPermissions';
import type { NsiteShareDelivery } from '@/lib/nsiteShareTarget';

/** A JSON-RPC call raised by the site's `window.nostr`. */
export interface NsiteRpcEvent {
  id: number;
  method: string;
  /** JSON text — see the note on the native side about object coercion. */
  params: string;
}

/**
 * The site reached for something of the device's and the WebView wants an
 * answer.
 *
 * One event for every such question, however the site asked it — Chromium
 * routes `getUserMedia` and `navigator.geolocation` through quite different
 * callbacks, but what is being decided is the same thing, and it is decided
 * in the same sheet and written down in the same place.
 */
export interface NsiteCapabilityEvent {
  id: number;
  /** What it asked for: `camera`, `microphone`, `location`, or several. */
  kinds: NsiteBrowserPermissionType[];
}

/**
 * Where the site's view goes, in CSS pixels from the top left of the window.
 *
 * iOS only, and only because the site is not a window there. On Android a site
 * opened from the wall is launched into a task of its own and the WebView is
 * the whole screen, so there is nothing to say; on iOS it is layered over the
 * app with `NsiteTopBar` above it, and a view filling the window would bury
 * the bar. CSS pixels and iOS points are the same unit in a WebView at
 * standard zoom, so the rect crosses unconverted.
 */
export interface NsiteFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NsiteWebViewPlugin {
  /**
   * Create the site's WebView and start loading it.
   *
   * `files` is the whole path→sha256 manifest. It crosses the bridge once, at
   * open time, and the native side resolves every request against it from
   * there on — no file bytes are ever marshalled through Capacitor.
   */
  open(options: {
    siteId: string;
    /** Where to put the view. Ignored on Android, where it is the window. */
    frame?: NsiteFrameRect;
    /**
     * What to call the site in anything shown in its name.
     *
     * The origin can't stand in for it — it's a hash under `nsite.localhost`,
     * which says nothing about whose window this is — so a dialog the site
     * opens with `alert`, `confirm` or `prompt` is titled with this.
     */
    name?: string;
    files: Record<string, string>;
    servers: string[];
    /** The NIP-07 provider to install, or omitted to withhold `window.nostr`. */
    providerScript?: string;
    /**
     * A share to open the site on, instead of its front page.
     *
     * A `get` delivery is loaded as-is: the site's own action with the params
     * in the query, no page of Tenna's in between. A `post` one loads the
     * bootstrap page, which is the only way to make a real multipart form
     * navigation from the site's origin.
     */
    share?: NsiteShareDelivery;
  }): Promise<void>;

  /**
   * Point an open site at a share, without taking it down and starting over.
   *
   * For a share that arrives at a window that never closed — sharing into an
   * app you already have open is the ordinary case, and reopening it would
   * throw away everything it had loaded to end up in the same place.
   */
  navigate(options: { siteId: string; share: NsiteShareDelivery }): Promise<void>;

  /**
   * Move the site's view, when the box it stands in changes.
   *
   * iOS only, for the same reason as `frame` on `open` — rotation, the
   * keyboard, anything that reflows the page under it. A no-op where the view
   * is the window.
   */
  updateFrame(options: { frame: NsiteFrameRect }): Promise<void>;

  /** Play the shutoff animation and tear the WebView down. */
  close(): Promise<void>;

  /** Step back through the site's history. `moved` is false if it had nowhere to go. */
  goBack(): Promise<{ moved: boolean }>;

  /**
   * Hide the site's pixels without unloading it.
   *
   * Pass `still` to be handed a picture of the last frame on the way out, as a
   * `data:` URL. React draws that where the site was, so a prompt over the
   * site still looks like a prompt over the site — while what is behind it is
   * an image, incapable of reacting to anything.
   *
   * Absent from the result if there was nothing to draw, or if the device
   * couldn't. Neither is worth failing a permission prompt over.
   */
  setConcealed(options: { concealed: boolean; still?: boolean }): Promise<{ still?: string }>;

  /**
   * Answer a request previously raised as `nsiteCapability`.
   *
   * `granted` says only what the *site* was allowed. Whether Tenna itself may
   * reach the camera is Android's question, asked afterwards and natively —
   * there is no point putting the OS prompt in front of someone who has not
   * yet said the site can have it.
   */
  respondCapability(options: { id: number; granted: boolean }): Promise<void>;

  /**
   * Keep the site's icon where its notifications can find it. iOS only.
   *
   * A push is shown by an extension with no wall and no WebView, long after
   * the manifest the icon was picked out of was read — so the tile is drawn
   * here, while there is one, and written down. Android's counterpart is
   * `NsiteShortcuts.refreshIcon`.
   */
  setIcon(options: {
    siteId: string;
    /** Base64 PNG of the wall's tile, without a data URL prefix. */
    icon: string;
  }): Promise<void>;

  /** Answer a call previously raised as `nsiteRpc`. */
  respond(options: {
    id: number;
    /** JSON text of the result. */
    result?: string;
    /** Message for a JSON-RPC error response. Takes precedence over `result`. */
    error?: string;
  }): Promise<void>;

  addListener(
    event: 'nsiteLoad',
    handler: () => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    event: 'nsiteRpc',
    handler: (event: NsiteRpcEvent) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    event: 'nsiteCapability',
    handler: (event: NsiteCapabilityEvent) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * The native shield over the site was pressed.
   *
   * It exists natively only because the site's WebView is layered over the
   * Capacitor one, which buries React's copy. Pressing it changes nothing on
   * its own — React still decides what the press means and draws the panel.
   */
  addListener(
    event: 'nsitePermissions',
    handler: () => void,
  ): Promise<PluginListenerHandle>;

  /**
   * The site followed a link to another site.
   *
   * A link out of a site's window is normally handed to the device, because
   * the window is one site's and not a browser. An `nsite://` link is the
   * exception: the thing it names is a site, and Tenna is what opens sites —
   * so rather than go out to the OS and come back in through Tenna's own
   * intent filter, with a task switch through the wall on the way, it is
   * raised here and the window opens the sibling site itself.
   *
   * The URL is a string a stranger's page wrote. It is resolved through
   * exactly the path a pasted address takes and is worth exactly as much.
   */
  addListener(
    event: 'nsiteLink',
    handler: (event: { url: string }) => void,
  ): Promise<PluginListenerHandle>;

  /**
   * Forget everything kept for a site: its IndexedDB, its cookies, local
   * storage and cache, and its record, with its subscriptions and periodic
   * syncs. iOS only; Android forgets a site when the wall it is mirrored
   * with no longer has it (`NsiteShortcuts.setWall`).
   */
  forget(options: { siteId: string }): Promise<void>;
}

export const NsiteWebView = registerPlugin<NsiteWebViewPlugin>('NsiteWebView');

/**
 * Whether this platform can hand an nsite its own top-level browsing context.
 *
 * Android and iOS, by different means to the same end: a WebView of the site's
 * own, serving its files natively out of the manifest. On the web there is no
 * such thing to hand out, and the iframe implementation stands in.
 *
 * The two are not quite the same offer. A site on Android may register a
 * service worker; one on iOS may not, because WebKit withholds them from any
 * document whose scheme is not literally http or https and a WebView cannot
 * serve either. See `NsiteOrigins.swift`.
 */
export function supportsNativeNsite(): boolean {
  const platform = Capacitor.getPlatform();
  return (platform === 'android' || platform === 'ios')
    && Capacitor.isPluginAvailable('NsiteWebView');
}

/**
 * Whether removing a site from the wall should forget what is kept for it
 * with `NsiteWebView.forget`. iOS: Android does the same through the wall it
 * is told about.
 */
export function forgetsRemovedSites(): boolean {
  return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('NsiteWebView');
}

/**
 * Whether this platform can make a site's HTTP request for it, without CORS.
 *
 * Android only, like the rest of `window.napp`. The request is staged over
 * the WebView's message channel and the response comes back through
 * `shouldInterceptRequest` — see `NappFetch` — and iOS has neither of those
 * in a shape that could carry it: `WKURLSchemeHandler` cannot intercept
 * `https`, and it is not handed a request body either.
 *
 * Checked rather than assumed from `supportsNativeNsite`, because a site on
 * iOS gets a native WebView too and would otherwise be told a lie it could
 * only discover by hanging.
 */
export function supportsNappFetch(): boolean {
  return Capacitor.getPlatform() === 'android'
    && Capacitor.isPluginAvailable('NsiteWebView');
}
