/**
 * What an nsite has been allowed to do with the user's key.
 *
 * Permissions are scoped to (userPubkey, siteId) and are granular:
 * - `signEvent` permissions are stored per event kind
 * - Encryption/decryption permissions are stored per operation type
 *
 * `getPublicKey` is always allowed (clicking "Run" implies consent) and is
 * not tracked in this system.
 *
 * ## Where the records live
 *
 * On Android, natively, in the same store that holds the grants given to apps
 * on the phone and to remote clients — see `SignerApps.java`. It used to be
 * the web layer's `localStorage` on every platform, on the reasoning that a
 * site always has a WebView in front of it. A **service worker does not**: a
 * site woken by a push has no window, no bridge and no `localStorage` of
 * Tenna's to read, and it can still ask to sign and decrypt. So on Android the
 * native store is the original and this module is a window onto it, which is
 * what keeps one decision meaning the same thing in a site's window and in its
 * worker.
 *
 * Elsewhere — the web build, and iOS, where a worker runs inside a
 * notification extension that could not raise a prompt anyway — there is no
 * native store, and `localStorage` remains the original.
 *
 * Every function here is therefore asynchronous, including the reads.
 */
import {
  getSignerApp,
  listSignerApps,
  SignerApps,
  supportsSignerApps,
} from '@/lib/signerAppsPlugin';

import { getKindLabel } from '@/lib/kindLabels';

// Re-export so existing consumers of `getKindLabel` from this module keep working.
export { getKindLabel } from '@/lib/kindLabels';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Operations that require permission. `getPublicKey` is always allowed.
 *
 * Every one of them is a question about the user's key, which is what makes
 * this store the right place for them and what decides how they are keyed.
 *
 * The strings are shared with `SignerTypes.java`, deliberately: an app asking
 * to decrypt and a site asking to decrypt are the same question about the same
 * key, and since Android now files both in one store they have to spell it the
 * same way.
 *
 * `push` was once on this list and is not any more. See
 * {@link LEGACY_PUSH_TYPE}.
 */
export type NsitePermissionType =
  | 'signEvent'
  | 'nip04.encrypt'
  | 'nip04.decrypt'
  | 'nip44.encrypt'
  | 'nip44.decrypt';

/** A single remembered permission decision. */
export interface NsitePermission {
  /** Operation type. */
  type: NsitePermissionType;
  /** Event kind — only meaningful for `signEvent`, null otherwise. */
  kind: number | null;
  /** Whether this operation is allowed. */
  allowed: boolean;
}

/** All remembered permissions for one (user, site) pair. */
export interface NsiteAllowance {
  /** Canonical nsite subdomain identifier (from `getNsiteSubdomain`). */
  siteId: string;
  /** Human-readable site name. */
  siteName: string;
  /** Hex pubkey of the user who granted the permissions. */
  userPubkey: string;
  /** Individual permission decisions. */
  permissions: NsitePermission[];
  /** Unix timestamp (ms) when this allowance was first created. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// localStorage — the original off Android, and the thing migrated on it
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'nostr:nsite-permissions';

/** Read all allowances from localStorage. */
function readAllowances(): NsiteAllowance[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write all allowances to localStorage and notify same-tab subscribers. */
function writeAllowances(allowances: NsiteAllowance[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(allowances));
  announce();
}

/**
 * Say that something changed, for anything drawing a list of it.
 *
 * The `storage` event only fires across tabs, and the native store fires
 * nothing at all, so both writes end here — see `useNsiteAllowance`.
 */
function announce(): void {
  window.dispatchEvent(new Event('nsite-permissions-changed'));
}

/** Find the allowance for a specific (siteId, userPubkey) pair. */
function findAllowance(
  allowances: NsiteAllowance[],
  siteId: string,
  userPubkey: string,
): NsiteAllowance | undefined {
  return allowances.find(
    (a) => a.siteId === siteId && a.userPubkey === userPubkey,
  );
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Hand whatever localStorage still holds to the native store, once.
 *
 * Runs before the first native read of this session and not again. A grant the
 * user made in a version that kept them up here is a grant they made, and
 * asking for it a second time because the store moved underneath them is the
 * sort of thing that teaches people to press Allow without reading.
 *
 * The local copy is cleared only once every record has been written, so an
 * interrupted migration repeats rather than losing anything: `grant` replaces
 * the answer to a question it already holds, so writing one twice is a no-op.
 */
let migration: Promise<void> | undefined;

function migrate(): Promise<void> {
  migration ??= (async () => {
    const allowances = readAllowances();
    if (allowances.length === 0) return;

    for (const allowance of allowances) {
      for (const permission of allowance.permissions) {
        try {
          await SignerApps.grant({
            account: allowance.userPubkey,
            requesterId: allowance.siteId,
            appKind: 'nsite',
            name: allowance.siteName || allowance.siteId,
            type: permission.type,
            ...(permission.kind === null ? {} : { kind: permission.kind }),
            allowed: permission.allowed,
          });
        } catch {
          // A record that would not cross is one the user is asked about
          // again. Leave the rest of the migration to finish; stopping here
          // would strand every grant behind it too.
        }
      }
    }

    localStorage.removeItem(STORAGE_KEY);
  })();

  return migration;
}

/**
 * The type notifications used to be filed under, here, per account.
 *
 * They are now a per-site decision about the device, kept in
 * `nsiteBrowserPermissions` — see the note at the top of that file. Nothing
 * writes this type any more; what is left is whatever users granted before
 * the move, and {@link takeLegacyPushGrants} is how it gets out.
 */
const LEGACY_PUSH_TYPE: string = 'push';

/** One grant found under the old type, on its way to the new store. */
export interface LegacyPushGrant {
  siteId: string;
  siteName: string;
  allowed: boolean;
}

/**
 * Read out every `push` grant this account made, and revoke them here.
 *
 * Revoked as they are read, and returned rather than moved, because the store
 * they are going to is not this module's to write. The caller writes them; a
 * caller that fails to leaves the user with one prompt they have seen before,
 * which is the mild end of the two ways this can go wrong. The other — leaving
 * them behind — is worse than a prompt: nothing reads the type any more, so
 * the row would sit in the permissions list forever with no label and no way
 * to act on it.
 */
export async function takeLegacyPushGrants(userPubkey: string): Promise<LegacyPushGrant[]> {
  const found: LegacyPushGrant[] = [];

  if (native()) {
    await migrate();
    for (const app of await listSignerApps(userPubkey)) {
      if (app.kind !== 'nsite') continue;
      for (const permission of app.permissions) {
        if (permission.type !== LEGACY_PUSH_TYPE) continue;
        found.push({
          siteId: app.requesterId,
          siteName: app.name || app.requesterId,
          allowed: permission.allowed,
        });
      }
    }

    for (const grant of found) {
      try {
        await SignerApps.revoke({
          account: userPubkey,
          requesterId: grant.siteId,
          type: LEGACY_PUSH_TYPE,
        });
      } catch {
        // Still returned, so the new store gets it. A row that would not go
        // away is a row the user can clear by hand.
      }
    }

    if (found.length > 0) announce();
    return found;
  }

  const allowances = readAllowances();
  let changed = false;

  for (const allowance of allowances) {
    if (allowance.userPubkey !== userPubkey) continue;

    const keep = allowance.permissions.filter((p) => p.type !== LEGACY_PUSH_TYPE);
    if (keep.length === allowance.permissions.length) continue;

    for (const permission of allowance.permissions) {
      if (permission.type !== LEGACY_PUSH_TYPE) continue;
      found.push({
        siteId: allowance.siteId,
        siteName: allowance.siteName || allowance.siteId,
        allowed: permission.allowed,
      });
    }

    allowance.permissions = keep;
    changed = true;
  }

  if (changed) {
    writeAllowances(allowances.filter((a) => a.permissions.length > 0));
  }

  return found;
}

/** Whether the grants for sites live natively on this platform. */
function native(): boolean {
  return supportsSignerApps();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a stored permission decision.
 *
 * @returns `'allow'` or `'deny'` if remembered, `'ask'` if no decision stored.
 */
export async function getNsitePermission(
  siteId: string,
  userPubkey: string,
  type: NsitePermissionType,
  kind: number | null = null,
): Promise<'allow' | 'deny' | 'ask'> {
  if (native()) {
    await migrate();
    try {
      const { decision } = await SignerApps.decide({
        account: userPubkey,
        requesterId: siteId,
        type,
        ...(kind === null ? {} : { kind }),
      });
      return decision;
    } catch {
      // A store that could not be read has granted nothing. Asking is the
      // safe direction: the worst of it is a prompt the user has seen before.
      return 'ask';
    }
  }

  const allowance = findAllowance(readAllowances(), siteId, userPubkey);
  if (!allowance) return 'ask';

  const match = allowance.permissions.find((p) => {
    if (p.type !== type) return false;
    // For signEvent, match on kind; for others kind is always null.
    if (type === 'signEvent') return p.kind === kind;
    return true;
  });

  if (!match) return 'ask';
  return match.allowed ? 'allow' : 'deny';
}

/**
 * Store a permission decision. Creates the allowance if it doesn't exist.
 * Updates an existing permission entry if one matches.
 */
export async function setNsitePermission(
  siteId: string,
  userPubkey: string,
  siteName: string,
  type: NsitePermissionType,
  kind: number | null,
  allowed: boolean,
): Promise<void> {
  if (native()) {
    await migrate();
    try {
      await SignerApps.grant({
        account: userPubkey,
        requesterId: siteId,
        appKind: 'nsite',
        name: siteName || siteId,
        type,
        ...(kind === null ? {} : { kind }),
        allowed,
      });
    } catch {
      // A decision that could not be written is one the user is asked for
      // again. Annoying, and better than a silent one.
    }
    announce();
    return;
  }

  const allowances = readAllowances();
  let allowance = findAllowance(allowances, siteId, userPubkey);

  if (!allowance) {
    allowance = {
      siteId,
      siteName,
      userPubkey,
      permissions: [],
      createdAt: Date.now(),
    };
    allowances.push(allowance);
  }

  // Find existing entry for this (type, kind) pair.
  const idx = allowance.permissions.findIndex((p) => {
    if (p.type !== type) return false;
    if (type === 'signEvent') return p.kind === kind;
    return true;
  });

  const entry: NsitePermission = { type, kind, allowed };

  if (idx >= 0) {
    allowance.permissions[idx] = entry;
  } else {
    allowance.permissions.push(entry);
  }

  writeAllowances(allowances);
}

/**
 * Remove a single permission entry from a site's allowance.
 */
export async function removeNsitePermission(
  siteId: string,
  userPubkey: string,
  type: NsitePermissionType,
  kind: number | null,
): Promise<void> {
  if (native()) {
    await migrate();
    try {
      await SignerApps.revoke({
        account: userPubkey,
        requesterId: siteId,
        type,
        ...(kind === null ? {} : { kind }),
      });
    } catch {
      // Nothing was taken back. The row stays, which is at least honest.
    }
    announce();
    return;
  }

  const allowances = readAllowances();
  const allowance = findAllowance(allowances, siteId, userPubkey);
  if (!allowance) return;

  allowance.permissions = allowance.permissions.filter((p) => {
    if (p.type !== type) return true;
    if (type === 'signEvent') return p.kind !== kind;
    return false;
  });

  // Remove the allowance entirely if no permissions remain.
  if (allowance.permissions.length === 0) {
    const idx = allowances.indexOf(allowance);
    if (idx >= 0) allowances.splice(idx, 1);
  }

  writeAllowances(allowances);
}

/**
 * Clear all stored permissions for a site.
 */
export async function clearNsitePermissions(
  siteId: string,
  userPubkey: string,
): Promise<void> {
  if (native()) {
    await migrate();
    try {
      await SignerApps.forget({ account: userPubkey, requesterId: siteId });
    } catch {
      // As above.
    }
    announce();
    return;
  }

  const allowances = readAllowances();
  const filtered = allowances.filter(
    (a) => !(a.siteId === siteId && a.userPubkey === userPubkey),
  );
  writeAllowances(filtered);
}

/** Turn one native record into the shape this module speaks. */
function toAllowance(
  userPubkey: string,
  app: { requesterId: string; name: string; createdAt: number; permissions: Array<{ type: string; kind?: number; allowed: boolean }> },
): NsiteAllowance {
  return {
    siteId: app.requesterId,
    siteName: app.name || app.requesterId,
    userPubkey,
    permissions: app.permissions.map((permission) => ({
      type: permission.type as NsitePermissionType,
      kind: permission.kind ?? null,
      allowed: permission.allowed,
    })),
    createdAt: app.createdAt,
  };
}

/**
 * Every site this user has answered for, newest first.
 *
 * For the settings screen, which lists sites alongside the apps on the phone
 * and the connections to apps elsewhere — three different things that all
 * amount to somebody having been given the same key.
 */
export async function listNsiteAllowances(userPubkey: string): Promise<NsiteAllowance[]> {
  if (native()) {
    await migrate();
    return (await listSignerApps(userPubkey))
      .filter((app) => app.kind === 'nsite')
      .map((app) => toAllowance(userPubkey, app));
  }

  return readAllowances()
    .filter((allowance) => allowance.userPubkey === userPubkey)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Get the full allowance record for a site, or undefined if none exists.
 */
export async function getNsiteAllowance(
  siteId: string,
  userPubkey: string,
): Promise<NsiteAllowance | undefined> {
  if (native()) {
    await migrate();
    const app = await getSignerApp(userPubkey, siteId);
    return app ? toAllowance(userPubkey, app) : undefined;
  }

  return findAllowance(readAllowances(), siteId, userPubkey);
}

// ---------------------------------------------------------------------------
// Human-readable labels
// ---------------------------------------------------------------------------

/** Get a human-readable label for a permission type and optional kind. */
export function getPermissionLabel(
  type: NsitePermissionType,
  kind: number | null,
): string {
  switch (type) {
    case 'signEvent': {
      if (kind === null) return 'Sign event';
      return `Sign: ${getKindLabel(kind)}`;
    }
    case 'nip04.encrypt':
      return 'Encrypt (NIP-04)';
    case 'nip04.decrypt':
      return 'Decrypt (NIP-04)';
    case 'nip44.encrypt':
      return 'Encrypt (NIP-44)';
    case 'nip44.decrypt':
      return 'Decrypt (NIP-44)';
  }
}
