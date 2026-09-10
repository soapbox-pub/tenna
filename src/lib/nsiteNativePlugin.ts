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

/** The site called `getUserMedia` and the WebView wants an answer. */
export interface NsiteMediaEvent {
  id: number;
  /** What it asked for: `camera`, `microphone`, or both. */
  kinds: NsiteBrowserPermissionType[];
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
   * Answer a request previously raised as `nsiteMedia`.
   *
   * `granted` says only what the *site* was allowed. Whether Tenna itself may
   * reach the camera is Android's question, asked afterwards and natively —
   * there is no point putting the OS prompt in front of someone who has not
   * yet said the site can have it.
   */
  respondMedia(options: { id: number; granted: boolean }): Promise<void>;

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
    event: 'nsiteMedia',
    handler: (event: NsiteMediaEvent) => void,
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
}

export const NsiteWebView = registerPlugin<NsiteWebViewPlugin>('NsiteWebView');

/**
 * Whether this platform can hand an nsite its own top-level browsing context.
 *
 * Only Android so far. On the web there is no such thing to hand out, and iOS
 * would need the `WKURLSchemeHandler` equivalent of the Android plugin before
 * it could make the same offer.
 */
export function supportsNativeNsite(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NsiteWebView');
}
