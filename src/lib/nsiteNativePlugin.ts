import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** A JSON-RPC call raised by the site's `window.nostr`. */
export interface NsiteRpcEvent {
  id: number;
  method: string;
  /** JSON text — see the note on the native side about object coercion. */
  params: string;
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
    files: Record<string, string>;
    servers: string[];
    /** The NIP-07 provider to install, or omitted to withhold `window.nostr`. */
    providerScript?: string;
  }): Promise<void>;

  /** Play the shutoff animation and tear the WebView down. */
  close(): Promise<void>;

  /** Step back through the site's history. `moved` is false if it had nowhere to go. */
  goBack(): Promise<{ moved: boolean }>;

  /** Hide the site's pixels without unloading it. */
  setConcealed(options: { concealed: boolean }): Promise<void>;

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

  /**
   * The native set-top controls were pressed.
   *
   * They exist natively only because the site's WebView is layered over the
   * Capacitor one, which buries React's copy. Pressing one changes nothing on
   * its own — React still decides what a press means and draws every panel.
   */
  addListener(
    event: 'nsitePower' | 'nsitePermissions',
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
