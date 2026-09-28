import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * A signer in the app process, holding keys this layer is not allowed to see.
 *
 * Every method names an account by its pubkey and gets back a result. None of
 * them returns a key — except `generate`, once, for the screen that shows a
 * new user what to write down. See `TennaKeys.java` for what that buys and
 * what it doesn't.
 *
 * Events cross as JSON text in both directions rather than as objects, for the
 * reason push subscriptions do: a tag array is arbitrarily shaped and
 * Capacitor's coercion does not keep it intact. Here it is worse than lossy —
 * the event id is a hash of those exact bytes.
 */
export interface TennaSignerPlugin {
  /**
   * Whether this device can hold a key natively.
   *
   * False on Android when libsecp256k1 didn't load, which means an ABI the
   * APK wasn't built for. Always true on iOS, where it is compiled in. Callers fall back to a key in this process rather than
   * refusing to sign anybody in.
   */
  isAvailable(): Promise<{ available: boolean }>;

  /**
   * Make a new account, and return its key the one time it is readable.
   *
   * The key is already stored when this resolves, so a caller that drops the
   * answer has not lost the account — but nothing will give the key back, so
   * a caller that meant to show it to the user has lost their only chance to.
   */
  generate(): Promise<{ pubkey: string; secretKey: string }>;

  /** Take a key from elsewhere: pasted by the user, or found in web storage. */
  importKey(options: { secretKey: string }): Promise<{ pubkey: string }>;

  /** Which accounts this device can sign for. */
  listKeys(): Promise<{ pubkeys: string[] }>;

  /** Keep these and forget every other key on the device. */
  retainKeys(options: { pubkeys: string[] }): Promise<{ forgotten: number }>;

  /**
   * Tell the app process who is signed in.
   *
   * `accounts` is JSON text of `{ pubkey, name, picture }[]`, in order, the
   * active account first. It replaces whatever was there — this is a mirror of
   * the login list for the paths that run with no WebView, and the web layer
   * is the only thing that knows the whole answer.
   *
   * Being in this list is not the same as being signable. It says who is
   * logged in, including people whose key lives in an extension or another
   * app; `listKeys` is what says which of them can actually be answered for.
   */
  setAccounts(options: { accounts: string }): Promise<void>;

  /**
   * Sign an event template as `pubkey`.
   *
   * `event` is JSON text of `{ kind, content, tags, created_at }`. Any `id`,
   * `pubkey` or `sig` in it is ignored, because those are what this computes.
   */
  signEvent(options: { pubkey: string; event: string }): Promise<{ event: string }>;

  nip44Encrypt(options: { pubkey: string; peer: string; plaintext: string }): Promise<{ result: string }>;
  nip44Decrypt(options: { pubkey: string; peer: string; ciphertext: string }): Promise<{ result: string }>;
  nip04Encrypt(options: { pubkey: string; peer: string; plaintext: string }): Promise<{ result: string }>;
  nip04Decrypt(options: { pubkey: string; peer: string; ciphertext: string }): Promise<{ result: string }>;
}

export const TennaSigner = registerPlugin<TennaSignerPlugin>('TennaSigner');

/** Whether the plugin is registered at all. The Android and iOS apps. */
function isPresent(): boolean {
  const platform = Capacitor.getPlatform();
  return (platform === 'android' || platform === 'ios') && Capacitor.isPluginAvailable('TennaSigner');
}

/**
 * Whether a key can be kept out of this process on this device.
 *
 * Asked once and remembered, because it is a question about the build and the
 * hardware and neither changes while the app is running. The answer gates a
 * login path, so it is worth having before the login screen needs it — see
 * `primeNativeSigner`.
 */
let available: boolean | undefined;

export async function supportsNativeSigner(): Promise<boolean> {
  if (available !== undefined) return available;
  if (!isPresent()) {
    available = false;
    return false;
  }

  try {
    available = (await TennaSigner.isAvailable()).available;
  } catch {
    // An older build of the app shell, or a plugin that failed to register.
    available = false;
  }
  return available;
}

/**
 * What {@link supportsNativeSigner} last answered, without asking.
 *
 * `undefined` until the question has been put once. For render paths that
 * cannot await — the answer decides which of two login buttons to draw, and a
 * button that appears a frame late is a button the user is already pressing.
 */
export function nativeSignerReady(): boolean | undefined {
  return available;
}

/** Put the question early, so the answer is there when a screen needs it. */
export function primeNativeSigner(): void {
  void supportsNativeSigner();
}
