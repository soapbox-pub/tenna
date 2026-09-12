import { useEffect, useRef } from 'react';
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
 *
 * And a list with nothing in it is not taken as an answer at all unless this
 * session has seen a fuller one — see {@link seenLogins}.
 */
export function NativeKeys() {
  const { logins, addLogin, setLogin, removeLogin } = useNostrLogin();

  /**
   * Whether an account has been signed in at any point this session.
   *
   * What this is guarding against is the one way the sweep can destroy an
   * account. An empty login list is supposed to mean nobody is signed in, and
   * it usually does — but `secureStorage` answers a failed read and a missing
   * key with the same `null`, because the plugin under it rejects alike for
   * both, and `NostrLoginProvider` turns that `null` into `[]`. So one
   * transient Keystore fault at boot presents as a user with no accounts, and
   * the sweep below would take that at its word and forget every key on the
   * device. There is no export and no second copy: those accounts would be
   * gone.
   *
   * The two cases are told apart by what came before. A logout of the last
   * account is always preceded by that account being here; a list emptied by
   * a failed read never is. So an empty list is only acted on once a fuller
   * one has been seen.
   *
   * What that gives up is the key of a last account logged out of in some
   * earlier session that never got as far as sweeping — a process killed
   * between the two. It stays sealed on disk, nameable only by a login that
   * no longer exists, until the next time somebody signs in and out. That is
   * a stale blob; the alternative is somebody's identity.
   */
  const seenLogins = useRef(false);

  // Every write below comes back here as a new `logins` and starts this
  // again. That is wanted, not worked around: the second pass finds nothing
  // left to migrate and re-runs a sweep that is idempotent. What the flag
  // stops is the *first* pass carrying on afterwards with a list that has
  // since changed under it.
  useEffect(() => {
    let cancelled = false;

    if (logins.length > 0) seenLogins.current = true;

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

        // Nobody is signed in and nobody ever was, this session. That is what
        // a broken read looks like as much as what an empty device does, and
        // only one of the two is worth acting on. See `seenLogins`.
        if (logins.length === 0 && !seenLogins.current) return;

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
