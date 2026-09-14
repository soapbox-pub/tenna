/**
 * What a site may do with the device, as opposed to with your identity.
 *
 * Kept apart from `nsitePermissions` on purpose, and keyed differently. A
 * signer permission is a decision about a *key*: "may this app sign a note as
 * me", which is meaningless without a me, and is rightly forgotten when a
 * different account is loaded. A camera permission is a decision about an
 * *origin* — the thing every browser has keyed it on since the day
 * `getUserMedia` shipped. Logging out of a site does not un-see what its
 * camera saw, and logging into it as somebody else does not make the question
 * new.
 *
 * So these are stored per site, they survive a logout, and they are asked and
 * revoked whether or not anyone is signed in.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A capability of the device a site can ask for. */
export type NsiteBrowserPermissionType = 'camera' | 'microphone' | 'location';

/** A single remembered decision. */
export interface NsiteBrowserPermission {
  type: NsiteBrowserPermissionType;
  allowed: boolean;
}

/** Everything one site has been granted or refused. */
export interface NsiteBrowserAllowance {
  /** Canonical nsite subdomain identifier (from `getNsiteSubdomain`). */
  siteId: string;
  /** Human-readable site name, for anywhere these are listed. */
  siteName: string;
  permissions: NsiteBrowserPermission[];
  /** Unix timestamp (ms) when this allowance was first created. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export const NSITE_BROWSER_PERMISSIONS_KEY = 'nostr:nsite-browser-permissions';

function read(): NsiteBrowserAllowance[] {
  try {
    const raw = localStorage.getItem(NSITE_BROWSER_PERMISSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(allowances: NsiteBrowserAllowance[]): void {
  localStorage.setItem(NSITE_BROWSER_PERMISSIONS_KEY, JSON.stringify(allowances));
  // `storage` only fires in other tabs, so same-tab subscribers get their own
  // event. See `useNsiteBrowserAllowance`.
  window.dispatchEvent(new Event('nsite-browser-permissions-changed'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Look up a stored decision. `'ask'` when there isn't one. */
export function getNsiteBrowserPermission(
  siteId: string,
  type: NsiteBrowserPermissionType,
): 'allow' | 'deny' | 'ask' {
  const allowance = read().find((a) => a.siteId === siteId);
  const match = allowance?.permissions.find((p) => p.type === type);
  if (!match) return 'ask';
  return match.allowed ? 'allow' : 'deny';
}

/** Remember a decision, replacing any earlier one for the same capability. */
export function setNsiteBrowserPermission(
  siteId: string,
  siteName: string,
  type: NsiteBrowserPermissionType,
  allowed: boolean,
): void {
  const allowances = read();
  let allowance = allowances.find((a) => a.siteId === siteId);

  if (!allowance) {
    allowance = { siteId, siteName, permissions: [], createdAt: Date.now() };
    allowances.push(allowance);
  }

  const idx = allowance.permissions.findIndex((p) => p.type === type);
  const entry: NsiteBrowserPermission = { type, allowed };

  if (idx >= 0) allowance.permissions[idx] = entry;
  else allowance.permissions.push(entry);

  write(allowances);
}

/** Forget one capability, so the site is asked again next time. */
export function removeNsiteBrowserPermission(
  siteId: string,
  type: NsiteBrowserPermissionType,
): void {
  const allowances = read();
  const allowance = allowances.find((a) => a.siteId === siteId);
  if (!allowance) return;

  allowance.permissions = allowance.permissions.filter((p) => p.type !== type);
  if (allowance.permissions.length === 0) {
    allowances.splice(allowances.indexOf(allowance), 1);
  }

  write(allowances);
}

/** Forget everything this site was granted or refused. */
export function clearNsiteBrowserPermissions(siteId: string): void {
  write(read().filter((a) => a.siteId !== siteId));
}

/** Everything one site has been granted or refused, if anything. */
export function getNsiteBrowserAllowance(
  siteId: string,
): NsiteBrowserAllowance | undefined {
  return read().find((a) => a.siteId === siteId);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function getBrowserPermissionLabel(
  type: NsiteBrowserPermissionType,
): string {
  switch (type) {
    case 'camera':
      return 'Use the camera';
    case 'microphone':
      return 'Use the microphone';
    case 'location':
      return 'Use your location';
  }
}
