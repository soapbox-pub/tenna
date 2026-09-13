import { useCallback } from 'react';
import { generateSecretKey, nip19 } from 'nostr-tools';

import { useLoginActions } from '@/hooks/useLoginActions';
import { generateNativeKey } from '@/lib/nativeKeySigner';
import { supportsNativeSigner } from '@/lib/tennaSignerPlugin';

/**
 * Making an account, and signing in with a key, in the one place that decides
 * where the key is allowed to live.
 *
 * Two screens ask for this — the auth dialog and the introduction — and they
 * must not answer it differently. The rule is the same in both directions: if
 * the device can hold the key, the device holds it, and this process only ever
 * sees the nsec long enough to show it to the user. See `nativeKeySigner.ts`.
 */
export function useSignup() {
  const login = useLoginActions();

  /**
   * Make a key and return it as an `nsec1…`.
   *
   * Where the device can hold one, it makes it: the key exists in the app
   * process first and comes back here only so the screen after can show it,
   * which is the whole reason it is returned at all. It is not readable again
   * afterwards, so a caller that drops it has dropped the user's only copy.
   */
  const generateKey = useCallback(async (): Promise<string> => {
    try {
      if (await supportsNativeSigner()) {
        return (await generateNativeKey()).nsec;
      }
    } catch {
      // The native store refused. A key in this process is worse, but it is an
      // account, which is what the user pressed the button for.
    }
    return nip19.nsecEncode(generateSecretKey());
  }, []);

  /**
   * Sign in with a secret key, keeping it out of this process where the device
   * will hold it instead.
   *
   * The fallback is not a lesser login, it is the login this app has always
   * had: the key in web storage, signed with here. It is what the web build
   * does, and what an Android build whose APK has no native library for this
   * device's ABI does.
   */
  const signInWithKey = useCallback(async (nsec: string): Promise<void> => {
    if (await supportsNativeSigner()) {
      await login.nativeKey(nsec);
      return;
    }
    login.nsec(nsec);
  }, [login]);

  return { generateKey, signInWithKey };
}
