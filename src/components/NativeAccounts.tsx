import { useEffect } from 'react';

import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { supportsNativeSigner, TennaSigner } from '@/lib/tennaSignerPlugin';

/**
 * Tells the app process who is signed in, and keeps telling it.
 *
 * Renders nothing, and does nothing at all off Android.
 *
 * The login list lives here, in the web layer, which is the right place for it
 * — except that the three paths another application can reach Tenna through
 * all run with no WebView in them. A content resolver query arrives on a
 * binder thread; a remote signing request arrives on a relay socket held by a
 * background service; and the approval sheet has to decide whether there is
 * anything to approve *before* it boots anything, or a remembered grant would
 * cost a WebView to answer. None of those can ask this layer anything.
 *
 * So the list is copied down. It is a mirror and never an original: the whole
 * thing is replaced whenever it changes, so anything that goes wrong is
 * corrected on the next render rather than accumulating.
 *
 * Kept apart from {@link NativeKeys} deliberately. That component's sweep can
 * destroy an account if it acts on a list it should not trust, so it reads the
 * logins and nothing else. This one wants names and faces, which means relay
 * queries and a cache — worth having for the notification that says who a
 * remote app is asking to sign as, and not worth putting anywhere near the
 * sweep.
 */
export function NativeAccounts() {
  const { authors, currentUser } = useLoggedInAccounts();

  // `authors` is in login order, so the active account is already first — but
  // it is also the list that arrives empty on the first render and fills in
  // once the profiles resolve, and `currentUser` is the one that is right
  // immediately. Depending on both means the mirror is correct from the first
  // pass and gets names on the second.
  const serialized = JSON.stringify(
    authors.map(({ pubkey, metadata }) => ({
      pubkey,
      name: metadata.name ?? metadata.display_name ?? '',
      picture: metadata.picture ?? '',
    })),
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!(await supportsNativeSigner())) return;
        if (cancelled) return;

        await TennaSigner.setAccounts({ accounts: serialized });
      } catch (error) {
        // The mirror is stale until the next change. What that costs is a
        // request from another app being answered as the wrong account, or
        // refused for want of one — both recoverable, neither silent.
        console.warn('Could not tell the app who is signed in', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serialized, currentUser?.pubkey]);

  return null;
}
