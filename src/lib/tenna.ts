/** App-wide constants for Tenna. */

/** Namespace for localStorage keys and derived device secrets. */
export const APP_ID = 'tenna';

/** Wildcard domain used for sandboxed nsite iframes. */
export const SANDBOX_DOMAIN = 'iframe.diy';

/** Team Soapbox (_@soapbox.pub) — the curator whose named nsites fill the channel wall. */
export const CHANNEL_CURATOR_PUBKEY =
  '781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5';

/** Relay where the curator's nsite manifests live. */
export const NSITE_RELAY = 'wss://relay.ditto.pub/';
