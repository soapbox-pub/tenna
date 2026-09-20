import { useNostrLogin } from '@nostrify/react/login';
import { useEffect } from 'react';

import { migrateNotificationGrants } from '@/lib/nsiteBrowserPermissions';

/**
 * Carries forward the grants users made when notifications were a `push`
 * permission, once per install.
 *
 * Mounted globally rather than asked for where the grant is read, because the
 * old records are keyed by account and the new ones are not: the sweep needs
 * the whole login list, and the place that reads a grant only ever knows about
 * one site. See `migrateNotificationGrants`.
 *
 * `logins` rather than `useLoggedInAccounts`, because the pubkeys are all this
 * needs and they are already on disk — there is no reason to wait on a relay
 * for a profile to move a permission.
 */
export function NsiteGrants() {
  const { logins } = useNostrLogin();

  useEffect(() => {
    if (logins.length === 0) return;

    void migrateNotificationGrants(logins.map((login) => login.pubkey)).catch(() => {
      // Left where they were. The flag is unset, so the next launch tries
      // again; until one succeeds the sites concerned ask once more.
    });
  }, [logins]);

  return null;
}
