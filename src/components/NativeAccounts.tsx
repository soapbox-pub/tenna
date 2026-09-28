import { useNostrLogin } from '@nostrify/react/login';
import { useEffect, useMemo } from 'react';

import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { supportsNativeSigner, TennaSigner } from '@/lib/tennaSignerPlugin';

/**
 * Tells the app process who is signed in, and keeps telling it.
 *
 * Renders nothing, and does nothing at all outside the Android and iOS
 * apps. On iOS the mirror is accepted and let go: nothing there runs
 * without a WebView to read it.
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
 * logins and nothing else. This one also wants names, which means a relay
 * query and a cache, and that is not something to put anywhere near the sweep.
 */
export function NativeAccounts() {
  const { logins } = useNostrLogin();
  const { authors } = useLoggedInAccounts();

  // The logins are the list, and the profiles are decoration on it.
  //
  // Not the other way round, which is the mistake worth naming: `authors`
  // comes out of a query and is empty until it resolves, so building the
  // mirror from it writes "nobody is signed in" on the first render of every
  // launch — and leaves it that way for good on a device that cannot reach a
  // relay. An application asking to sign would be told there was no account
  // here, which is a lie the user has no way to see.
  const serialized = useMemo(
    () =>
      JSON.stringify(
        logins.map((login) => {
          const author = authors.find((candidate) => candidate.pubkey === login.pubkey);
          // The login's type, and the one thing that identifies what is behind
          // it. That is what lets the app process sign for an account whose
          // key it does not hold: it knows which door to knock on.
          //
          // No secrets. A signer app's package name is public, and anything
          // that is actually a key goes to `TennaKeys` to be sealed instead.
          const { packageName } = (login.data ?? {}) as { packageName?: string };
          return {
            pubkey: login.pubkey,
            name: author?.metadata.name ?? author?.metadata.display_name ?? '',
            picture: author?.metadata.picture ?? '',
            type: login.type,
            packageName: packageName ?? '',
          };
        }),
      ),
    [logins, authors],
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
  }, [serialized]);

  return null;
}
