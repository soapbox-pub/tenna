import { useCallback, useEffect, useState } from 'react';

import type { MarkTile } from '@/components/AppMark';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import {
  clearNsitePermissions,
  listNsiteAllowances,
  removeNsitePermission,
  type NsitePermissionType,
} from '@/lib/nsitePermissions';
import type { PermissionKind } from '@/lib/permissionLabels';
import { readTileSnapshot } from '@/lib/tileSnapshot';
import {
  listSignerApps,
  listSignerConnections,
  SignerApps,
  supportsSignerApps,
  type SignerConnection,
} from '@/lib/signerAppsPlugin';

/** One remembered decision, whoever it was made about. */
export interface AuthorizedPermission {
  type: PermissionKind;
  kind: number | null;
  allowed: boolean;
}

/** Where something that has been given a key is running. */
export type AuthorizedSource = 'site' | 'package' | 'bunker' | 'web';

/** Something that has been given a key, as the settings screen draws it. */
export interface AuthorizedApp {
  /** Stable across reloads; the list's React key and the detail sheet's handle. */
  id: string;
  source: AuthorizedSource;
  name: string;
  /** The line under the name: what this is, in terms nobody chose for it. */
  subtitle: string;
  icon: string | null;
  /** Whether that icon is a full square with a shape still to cut. */
  adaptive: boolean;
  /** Set for a site, whose artwork is a picture that needs a tile under it. */
  tile?: MarkTile;
  permissions: AuthorizedPermission[];
  lastUsed: number;
  /** Set for a site, and the handle its grants are keyed by. */
  siteId?: string;
  /** Set for an app or a remote client. */
  requesterId?: string;
  /** Set for a remote client, which can be revoked as a whole. */
  connection?: SignerConnection;
}

function sourceSubtitle(source: AuthorizedSource, requesterId: string): string {
  switch (source) {
    case 'package':
      // The package name, which is the one thing about an app that nobody can
      // pick for themselves — a label and an icon can be copied from anything
      // on the store.
      return requesterId;
    case 'bunker':
      return 'An app somewhere else';
    case 'web':
      return 'A web page';
    case 'site':
      return 'A site in Tenna';
  }
}

/**
 * Everything that has been given this account's key, from all three stores.
 *
 * Sites keep their grants in the web layer's storage, because a site always
 * has a WebView in front of it and nothing else needs to read them. Apps and
 * remote clients keep theirs natively, because the paths that answer them run
 * with no WebView at all. Three stores, because the question of where a grant
 * has to be readable from has three different answers — and one list, because
 * to the person reading it they are all the same thing.
 *
 * Nothing is migrated between them. This is a read.
 */
export function useAuthorizedApps() {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;

  const [apps, setApps] = useState<AuthorizedApp[] | null>(null);

  /**
   * Read all three stores, and hand back one list.
   *
   * Deliberately returns rather than sets: the two stores that answer take a
   * bridge call to read, and a hook that wrote its own state partway through
   * would flash a list with the native half missing every time this ran.
   */
  const read = useCallback(async (): Promise<AuthorizedApp[]> => {
    if (!pubkey) return [];

    const sites: AuthorizedApp[] = listNsiteAllowances(pubkey).map((allowance) => {
      // The tile the wall drew, off the disk. A site's artwork is a document
      // on Blossom and a blob beside it, which is a round trip per row and a
      // list that fills in raggedly — and it is a round trip for a picture
      // this device has already fetched, drawn, and written down. The same
      // record the sheet over a site reads, for the same reason: see
      // `useNsiteTile`. A site the wall has never drawn keeps its initial.
      const snapshot = readTileSnapshot(allowance.siteId);

      return {
        id: `site:${allowance.siteId}`,
        source: 'site' as const,
        // What the wall calls it, which is what the user has seen it called,
        // over the name recorded when the grant was made.
        name: snapshot?.name || allowance.siteName || allowance.siteId,
        subtitle: sourceSubtitle('site', allowance.siteId),
        icon: snapshot?.icon ?? null,
        adaptive: false,
        tile: { fit: snapshot?.fit ?? 'cover', background: snapshot?.background ?? null },
        permissions: allowance.permissions.map((permission) => ({
          type: permission.type as PermissionKind,
          kind: permission.kind,
          allowed: permission.allowed,
        })),
        lastUsed: allowance.createdAt,
        siteId: allowance.siteId,
      };
    });

    const [native, connections] = await Promise.all([
      listSignerApps(pubkey),
      listSignerConnections(pubkey),
    ]);

    const byClient = new Map(
      connections.filter((c) => c.clientPubkey).map((c) => [c.clientPubkey, c]),
    );

    const others: AuthorizedApp[] = native.map((app) => {
      const source = (app.kind === 'bunker' || app.kind === 'web' ? app.kind : 'package') as
        | 'package'
        | 'bunker'
        | 'web';
      return {
        id: `app:${app.requesterId}`,
        source,
        name: app.name || app.requesterId,
        subtitle: sourceSubtitle(source, app.requesterId),
        icon: app.icon,
        adaptive: app.adaptive,
        permissions: app.permissions.map((permission) => ({
          type: permission.type,
          kind: permission.kind ?? null,
          allowed: permission.allowed,
        })),
        lastUsed: app.lastUsed,
        requesterId: app.requesterId,
        connection: byClient.get(app.requesterId),
      };
    });

    // A connection nobody has used yet has no grants and so no row above — but
    // it is listening on relays right now, which is exactly the thing a person
    // came to this screen to find out.
    const waiting: AuthorizedApp[] = connections
      .filter((connection) => !connection.clientPubkey)
      .map((connection) => ({
        id: `conn:${connection.localPubkey}`,
        source: 'bunker' as const,
        name: connection.name,
        subtitle: 'Waiting for an app to connect',
        icon: null,
        adaptive: false,
        permissions: [],
        lastUsed: connection.lastUsed,
        connection,
      }));

    return [...sites, ...others, ...waiting].sort((a, b) => b.lastUsed - a.lastUsed);
  }, [pubkey]);

  const load = useCallback(async () => {
    setApps(await read());
  }, [read]);

  useEffect(() => {
    let disposed = false;

    void (async () => {
      const next = await read();
      if (!disposed) setApps(next);
    })();

    return () => {
      disposed = true;
    };
  }, [read]);

  // The native store has no change event — nothing else on this device writes
  // to it while this screen is up — but the web layer's does, and a site's
  // grants can be revoked from the shield over the site itself.
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener('nsite-permissions-changed', onChange);
    return () => window.removeEventListener('nsite-permissions-changed', onChange);
  }, [load]);

  /** Take back one thing, from whichever store holds it. */
  const revoke = useCallback(
    async (app: AuthorizedApp, permission: AuthorizedPermission) => {
      if (app.siteId && pubkey) {
        removeNsitePermission(
          app.siteId,
          pubkey,
          permission.type as NsitePermissionType,
          permission.kind,
        );
      } else if (app.requesterId && pubkey && supportsSignerApps()) {
        await SignerApps.revoke({
          account: pubkey,
          requesterId: app.requesterId,
          type: permission.type,
          ...(permission.kind === null ? {} : { kind: permission.kind }),
        });
      }
      await load();
    },
    [pubkey, load],
  );

  /**
   * Take everything back.
   *
   * For a remote client this also throws the connection's key away, which is
   * what makes it final: the address that client is talking to stops existing,
   * and nothing it kept can bring it back.
   */
  const forget = useCallback(
    async (app: AuthorizedApp) => {
      if (app.siteId && pubkey) {
        clearNsitePermissions(app.siteId, pubkey);
      } else if (app.requesterId && pubkey && supportsSignerApps()) {
        await SignerApps.forget({ account: pubkey, requesterId: app.requesterId });
      } else if (app.connection && supportsSignerApps()) {
        await SignerApps.revokeConnection({ localPubkey: app.connection.localPubkey });
      }
      await load();
    },
    [pubkey, load],
  );

  // Nobody signed in is an answer, not a wait — and it is one this hook can
  // give without asking anything, which keeps the loading state honest: `null`
  // means a read is out, and there is no read to make.
  return { apps: pubkey ? apps : [], reload: load, revoke, forget, pubkey };
}
