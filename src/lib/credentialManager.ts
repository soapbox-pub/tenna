import { Capacitor } from '@capacitor/core';
import { SavePassword } from '@capgo/capacitor-autofill-save-password';

import { downloadTextFile } from '@/lib/downloadFile';

/**
 * The user's key, handed to whatever the device keeps passwords in.
 *
 * This is a *backup*, and on Android it is only ever a backup: the key the app
 * signs with is already sealed under the Keystore by the time anything here is
 * called, and it is not readable again afterwards — see `nativeKeySigner.ts`.
 * What this puts in the password manager is the copy the user can take to
 * another client, or back to this one after a reinstall. Nothing reads it to
 * log in; `getNsecCredential` exists so the login screen can offer to fill the
 * field, which is a convenience rather than a mechanism.
 *
 * - **Android**: `@capgo/capacitor-autofill-save-password` calls AndroidX
 *   Credential Manager, which is provider-agnostic — Google's manager on a
 *   stock device, Bitwarden or 1Password or KeePass where one of those is
 *   registered instead. A de-Googled phone with nothing registered has no
 *   provider at all and the call rejects; see {@link saveNsec} for what
 *   happens then.
 * - **iOS**: the same plugin calls `SecAddSharedWebCredential`, which needs the
 *   `webcredentials:` Associated Domains entitlement and a matching
 *   `apple-app-site-association` at {@link CREDENTIAL_DOMAIN}. Tenna has no
 *   generated iOS project yet, so this path is written and unreachable.
 * - **Chromium** (and the Android WebView off Capacitor): `PasswordCredential`
 *   raises the browser's own "Save password?" prompt.
 * - **Everything else** (Safari, Firefox): every function here answers `false`
 *   or `undefined` without throwing.
 */

/**
 * The domain the credential is filed under on iOS.
 *
 * Unused on Android, where a credential belongs to the app's package. It is
 * here for the iOS build that does not exist yet, and the entitlement and AASA
 * file have to name the same thing when it does.
 */
const CREDENTIAL_DOMAIN = 'tenna.pub';

/** Whether this browser has `PasswordCredential` at all. Chromium only. */
export function supportsPasswordCredential(): boolean {
  return typeof window !== 'undefined' && 'PasswordCredential' in window;
}

/**
 * Put a key in the platform's password manager.
 *
 * Raises the system sheet on native and the browser's prompt on Chromium. A
 * silent no-op everywhere else.
 *
 * @param npub The account, which is what the credential is filed under.
 * @param nsec The key, which is what the credential holds.
 * @param name What to call it in the manager's list. Web and iOS 26.2+ only.
 * @returns Whether it was stored. False covers both "unsupported" and
 *   "refused" — {@link saveNsec} is where that distinction is drawn.
 */
export async function storeNsecCredential(
  npub: string,
  nsec: string,
  name?: string,
): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      await SavePassword.promptDialog({
        username: npub,
        password: nsec,
        url: CREDENTIAL_DOMAIN,
        title: name ?? 'Tenna',
      });
      return true;
    } catch {
      // No credential provider on the device, or the user dismissed the sheet.
      return false;
    }
  }

  if (!supportsPasswordCredential()) return false;

  try {
    await navigator.credentials.store(
      new PasswordCredential({ id: npub, password: nsec, name: name ?? npub }),
    );
    return true;
  } catch {
    // Dismissed, or blocked — the API is same-origin, https, top-frame only.
    return false;
  }
}

/**
 * Ask the platform's password manager for a key it was given earlier.
 *
 * Shows the system credential picker on native and the browser's chooser on
 * Chromium. Answers `undefined` rather than throwing when there is nothing to
 * show, when the user dismisses, or when the platform has no such thing —
 * callers treat all three the same way, which is to carry on.
 */
export async function getNsecCredential(): Promise<
  { npub: string; nsec: string } | undefined
> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { username, password } = await SavePassword.readPassword();
      if (username && password) return { npub: username, nsec: password };
      return undefined;
    } catch {
      return undefined;
    }
  }

  if (!supportsPasswordCredential()) return undefined;

  try {
    const credential = await navigator.credentials.get({
      password: true,
      mediation: 'optional',
    });

    if (credential && 'password' in credential) {
      const pc = credential as PasswordCredential;
      if (pc.id && pc.password) return { npub: pc.id, nsec: pc.password };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/** What became of the key. See {@link saveNsec}. */
export type SaveNsecResult = 'saved' | 'saved-to-file' | 'dismissed';

/** The name the fallback file is written under. */
function nsecFilename(npub: string): string {
  // `location.hostname` is `localhost` under Capacitor, which would make every
  // file on every device identical and meaningless. The app's own name and
  // four characters of the npub is enough to tell two of these apart.
  return `tenna-${npub.slice(5, 9)}.nsec.txt`;
}

/**
 * Save a key by whatever means this device has, and say which was used.
 *
 * Three answers rather than two, because "the user said no" and "there was
 * nowhere to put it" want different things from the caller. A refusal is a
 * decision and should be met with silence; a fallback is worth a word, because
 * the file it wrote is somewhere the user would not otherwise think to look.
 *
 * - **Android**: Credential Manager, and where there is no provider to answer
 *   — a de-Googled device with nothing registered — the key is written to the
 *   app's Documents folder instead, so that there is always *some* copy. That
 *   folder is private to Tenna and goes nowhere: `allowBackup` is off, so it
 *   is not in anyone's Drive either.
 * - **iOS**: the Keychain sheet, and nothing if it is dismissed. Deliberately
 *   no file fallback — iOS Documents is readable without authentication, and
 *   writing a plaintext key there after the user declined to save one would
 *   be doing the opposite of what they just asked for.
 * - **Web**: the file, always, because that is the only thing a browser can be
 *   relied on to do. `PasswordCredential` is attempted alongside it and its
 *   outcome ignored.
 *
 * Throws only for a real failure — a filesystem write that did not work. A
 * dismissed prompt is not one.
 */
export async function saveNsec(
  npub: string,
  nsec: string,
  name?: string,
): Promise<SaveNsecResult> {
  if (Capacitor.isNativePlatform()) {
    if (await storeNsecCredential(npub, nsec, name)) return 'saved';

    if (Capacitor.getPlatform() === 'android') {
      await downloadTextFile(nsecFilename(npub), nsec);
      return 'saved-to-file';
    }

    return 'dismissed';
  }

  await downloadTextFile(nsecFilename(npub), nsec);

  // A bonus, not a step: fire it off and never wait on it or report it.
  storeNsecCredential(npub, nsec, name).catch(() => {});

  return 'saved';
}
