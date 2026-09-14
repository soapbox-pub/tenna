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

/** MK Fain (mk@ditto.pub) — publisher of Polaroids. */
export const MK_FAIN_PUBKEY =
  '932614571afcbad4d17a191ee281e39eebbb41b93fac8fd87829622aeb112f4d';

/** Chadwick (chad@chadwick.site) — publisher of Espy. */
export const CHADWICK_PUBKEY =
  '86184109eae937d8d6f980b4a0b46da4ef0d983eade403ee1b4c0b6bde238b47';

/** Jared Logan (jaredlogan@happytavern.co) — publisher of Tombstone. */
export const JARED_LOGAN_PUBKEY =
  '291c75d937a45f66a1209f8ea6611df7448c59b3526520c66ca2cdcd37f1bfbe';

/**
 * Whose nsites the "Add app" dialog offers whoever is looking — the two
 * publishers that package clients for it, and everyone whose site Tenna ships
 * on the wall, so a default taken off can be found again by name rather than
 * only by pasting its address back. A logged-in user's follows are added to
 * these; see `useNsiteCatalog`.
 */
export const NSITE_CATALOG_PUBKEYS = [
  TEAM_SOAPBOX_PUBKEY,
  NSITE_PACKAGERS_PUBKEY,
  MK_FAIN_PUBKEY,
  CHADWICK_PUBKEY,
  JARED_LOGAN_PUBKEY,
];

/** A site Tenna ships on the wall: whose it is, and its `d` tag. */
export interface DefaultNsite {
  pubkey: string;
  identifier: string;
}

/**
 * The apps on the wall of a device nobody has touched yet, in the order they
 * sit there.
 *
 * A wall with something on it, and then the plus. What is here is a starting
 * set rather than a lineup — enough that the first screen shows what a site on
 * a wall looks like and is worth opening, with the empty slot after it saying
 * the rest is theirs. Every one of these can be moved or taken off, and
 * nothing puts them back.
 */
export const DEFAULT_NSITES: DefaultNsite[] = [
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'ditto' },
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'shakespeare' },
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'armada' },
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'birdstar' },
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'nostrhub' },
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'agora' },
  { pubkey: TEAM_SOAPBOX_PUBKEY, identifier: 'yourspace' },
  { pubkey: MK_FAIN_PUBKEY, identifier: 'polaroids' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'espy' },
  { pubkey: JARED_LOGAN_PUBKEY, identifier: 'tombstone' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'follow-party' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'lufu' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'mi' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'nostrdamus' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'realms' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'sol' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'surveil' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'treasures' },
  { pubkey: CHADWICK_PUBKEY, identifier: 'wordsoul' },
];

/** Relay where the catalog's nsite manifests live. */
export const NSITE_RELAY = 'wss://relay.ditto.pub/';
