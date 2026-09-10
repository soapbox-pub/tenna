import { nip19 } from 'nostr-tools';
import { useParams } from 'react-router-dom';

import NotFound from './NotFound';
import { ProfilePage } from './ProfilePage';

/**
 * Whatever a bech32 identifier at the root of the site turns out to name.
 *
 * A pubkey — as an `npub` or as the `nprofile` that wraps one with relay
 * hints — is a publisher, and gets their page. Nothing else is anything here
 * yet: Tenna is a browser for sites rather than a reader for notes, so an
 * identifier naming one is a 404 rather than a screen that apologises.
 *
 * An `nsec` is a private key, and lands in the same place as anything else
 * this doesn't know: nowhere, silently, without being decoded onto a page.
 */
export function NIP19Page() {
  const { nip19: identifier } = useParams<{ nip19: string }>();

  if (!identifier) {
    return <NotFound />;
  }

  let decoded;
  try {
    decoded = nip19.decode(identifier);
  } catch {
    return <NotFound />;
  }

  switch (decoded.type) {
    case 'npub':
      return <ProfilePage pubkey={decoded.data} />;

    case 'nprofile':
      return <ProfilePage pubkey={decoded.data.pubkey} />;

    default:
      return <NotFound />;
  }
}
