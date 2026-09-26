import { useNostrLogin } from '@nostrify/react/login';
import { useEffect } from 'react';

import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import { getNsitesAllowed, migrateNotificationGrants } from '@/lib/nsiteBrowserPermissions';

/**
 * Carries forward the grants users made when notifications were a `push`
 * permission, once per install — and keeps the native side told who may notify.
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

  // The notification grants, mirrored to where a worker woken with no window
  // can read them. Once at launch, so grants made before the mirror existed
  // reach it, and again whenever one changes. See `NappPush.setNotifyGrants`.
  useEffect(() => {
    if (!supportsNappPush()) return;

    const mirror = () => {
      void NappPush.setNotifyGrants({ siteIds: getNsitesAllowed('notifications') }).catch(() => {
        // The next change, or the next launch, says it again.
      });
    };

    mirror();
    window.addEventListener('nsite-browser-permissions-changed', mirror);
    return () => window.removeEventListener('nsite-browser-permissions-changed', mirror);
  }, []);

  return null;
}
