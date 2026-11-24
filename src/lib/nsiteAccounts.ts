/**
 * The accounts each site holds.
 *
 * A site's `window.nostr` acts as whoever is signed in to Tenna, as NIP-07
 * always has. A client that keeps several accounts of its own, as Din lets
 * websites do (Din's docs/window-nostr.md), asks for another with
 * `window.nostr.requestPublicKey()` and signs as any of them with
 * `window.nostr.getSigner(pubkey)`, which keeps acting as that account
 * whatever Tenna switches to. This is what makes that safe: a site can only be
 * pinned to an account it was given.
 *
 * A site holds an account once it has been told it: by being opened while
 * that account was Tenna's (the provider is handed the pubkey on the way in),
 * or by the user picking it for `requestPublicKey()`. An account signed out of
 * Tenna is held by nobody, whatever this says.
 *
 * On Android the record is native (`NsiteAccounts.java`), because the site's
 * service worker asks with no WebView anywhere. Elsewhere it is
 * `localStorage`.
 */
import { SignerApps, supportsSignerApps } from '@/lib/signerAppsPlugin';

const STORAGE_KEY = 'nostr:nsite-accounts';

/** More than anyone has, and few enough that a site cannot fill the store. */
const MAX_PER_SITE = 32;

const PUBKEY = /^[0-9a-f]{64}$/;

function readAll(): Record<string, string[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string[]>)
      : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or unavailable: the site is asked again next time.
  }
}

/** Give a site an account. */
export async function holdNsiteAccount(siteId: string, pubkey: string): Promise<void> {
  if (!PUBKEY.test(pubkey)) return;

  if (supportsSignerApps()) {
    await SignerApps.holdAccount({ siteId, pubkey });
    return;
  }

  const all = readAll();
  const held = (all[siteId] ?? []).filter((key) => PUBKEY.test(key));
  if (held.includes(pubkey)) return;
  held.push(pubkey);
  all[siteId] = held.slice(-MAX_PER_SITE);
  writeAll(all);
}

/**
 * The accounts a site holds, of those in `signedIn` — the accounts signed in
 * to Tenna now, which is the other half of holding one.
 */
export async function heldNsiteAccounts(siteId: string, signedIn: readonly string[]): Promise<string[]> {
  let held: string[];
  if (supportsSignerApps()) {
    held = (await SignerApps.heldAccounts({ siteId })).accounts;
  } else {
    held = readAll()[siteId] ?? [];
  }
  return held.filter((pubkey) => signedIn.includes(pubkey));
}

/** Whether a site may act as `pubkey`: it was given it, and it is signed in. */
export async function holdsNsiteAccount(
  siteId: string,
  pubkey: string,
  signedIn: readonly string[],
): Promise<boolean> {
  if (!PUBKEY.test(pubkey) || !signedIn.includes(pubkey)) return false;
  return (await heldNsiteAccounts(siteId, signedIn)).includes(pubkey);
}

/** Take one account back from a site, off Android. Android does this natively on revoke. */
export function releaseNsiteAccount(siteId: string, pubkey: string): void {
  if (supportsSignerApps()) return;
  const all = readAll();
  const held = all[siteId];
  if (!held) return;
  const kept = held.filter((key) => key !== pubkey);
  if (kept.length) all[siteId] = kept;
  else delete all[siteId];
  writeAll(all);
}
