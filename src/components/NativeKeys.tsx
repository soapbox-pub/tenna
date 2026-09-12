import { useEffect } from 'react';
import { NLogin, useNostrLogin } from '@nostrify/react/login';

import { importNativeKey } from '@/lib/nativeKeySigner';
import { TennaSigner, supportsNativeSigner } from '@/lib/tennaSignerPlugin';

/**
 * Keeps the keys the app process holds in step with the accounts signed in.
 *
 * Renders nothing, and does nothing at all off Android. Two jobs:
 *
 * **Moving keys out of here.** An `nsec` login is the key itself, sitting in
 * this process — in web storage, and in the renderer's heap every time it is
 * read. Where the device can hold it instead, it should, so any `nsec` login
 * found here is handed over and replaced by an `x-native-key` login that is
 * just a pubkey. This runs silently and once per account. It is not a choice
 * the user is offered because there is no version of it they would prefer: the
 * same account, signing the same things, with the key somewhere a compromised
 * renderer cannot read it.
 *
 * **Taking keys back off it.** Logging out is `removeLogin`, and it is reached
 * from the account switcher, from the menu, and from a login replacing
 * another. Rather than find every one of those and hope, this says which keys
 * still have a login behind them whenever the list changes, and the native
 * side forgets the rest. A key nothing can name is a key nothing can ask to
 * sign — it should not outlive the account it belonged to, and this is the one
 * place that has to be right for it not to.
 *
 * Order matters between the two: a sweep that ran before a migration finished
 * would see a freshly imported key with no login yet and delete it.
 */
export function NativeKeys() {
  const { logins, addLogin, setLogin, removeLogin } = useNostrLogin();

  // Every write below comes back here as a new `logins` and starts this
  // again. That is wanted, not worked around: the second pass finds nothing
  // left to migrate and re-runs a sweep that is idempotent. What the flag
  // stops is the *first* pass carrying on afterwards with a list that has
  // since changed under it.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!(await supportsNativeSigner())) return;
        if (cancelled) return;

        // The keys that still have an account behind them. Built up as the
        // run goes rather than read at the end, because `logins` in this
        // closure is the list this run started with: a migration below adds a
        // login that the closure will never see, and sweeping against the old
        // list would delete the key that login had just been given.
        const keep = new Set(
          logins.filter((login) => login.type === 'x-native-key').map((login) => login.pubkey),
        );

        for (const login of logins) {
          if (cancelled) return;
          if (login.type !== 'nsec') continue;

          const wasActive = logins[0]?.id === login.id;

          try {
            const pubkey = await importNativeKey(login.data.nsec);
            if (cancelled) return;

            const migrated = new NLogin('x-native-key', pubkey, {});
            keep.add(pubkey);
            addLogin(migrated);
            removeLogin(login.id);
            // `addLogin` appends, so without this the migrated account would
            // drop to the back of the list and somebody else would be signed
            // in — the one visible way this could go wrong.
            if (wasActive) setLogin(migrated.id);

            console.info('Moved a key out of the browser and into the app');
          } catch (error) {
            // The account keeps working exactly as it did; it is simply still
            // a key in this process. Worth saying out loud, not worth
            // interrupting anyone over.
            console.warn('Could not move a key into the app', error);
          }
        }

        if (cancelled) return;

        await TennaSigner.retainKeys({ pubkeys: [...keep] });
      } catch (error) {
        console.warn("Could not reconcile the app's keys with the logins", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [logins, addLogin, setLogin, removeLogin]);

  return null;
}
