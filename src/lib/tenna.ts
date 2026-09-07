/** App-wide constants for Tenna. */

/** Namespace for localStorage keys and derived device secrets. */
export const APP_ID = 'tenna';

/** Wildcard domain used for sandboxed nsite iframes. */
export const SANDBOX_DOMAIN = 'iframe.diy';

/** Team Soapbox (_@soapbox.pub) — publisher of Tenna's own apps. */
export const TEAM_SOAPBOX_PUBKEY =
  '781a1527055f74c1f70230f10384609b34548f8ab6a0a6caa74025827f9fdae5';

/** Nsite Packagers — publisher of other people's clients, packaged as nsites. */
export const NSITE_PACKAGERS_PUBKEY =
  'fbb512ea0839e0df4d0d21dc62793a483a877d40870d6032525896e30946ea30';

/** Whose named nsites the "Add app" dialog offers to install. */
export const NSITE_CATALOG_PUBKEYS = [TEAM_SOAPBOX_PUBKEY, NSITE_PACKAGERS_PUBKEY];

/**
 * The apps on the wall of a device nobody has touched yet, by `d` tag under
 * Team Soapbox.
 *
 * Three, and then the plus. A home screen shipped full is a home screen the
 * user reads as furniture rather than as theirs; a few tiles and an obvious
 * empty slot say what the wall is for and leave the rest of it to them. Every
 * one of these can be taken off, and nothing puts them back.
 */
export const DEFAULT_NSITES = ['ditto', 'shakespeare', 'armada'];

/** Relay where the catalog's nsite manifests live. */
export const NSITE_RELAY = 'wss://relay.ditto.pub/';
