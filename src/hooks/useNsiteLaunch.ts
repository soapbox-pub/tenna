import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { NsiteShortcuts, supportsNsiteWindows } from '@/lib/nsiteShortcutsPlugin';
import {
  isNsiteKind,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
  NSITE_SNAPSHOT_KIND,
  parseNsiteSubdomain,
} from '@/lib/nsiteSubdomain';
import { NSITE_RELAY } from '@/lib/tenna';

/** The site this window was opened for. */
export interface NsiteLaunch {
  /** Canonical nsite subdomain. */
  siteId: string;
  /** The name the site was opened under. */
  label: string;
  /**
   * The manifest as it stood when the window was made, or null if the record
   * has been lost — cleared app data, or a shortcut older than the store.
   */
  event: NostrEvent | null;
  /** The channel the site sits on, or null when it came off the home screen. */
  channel: number | null;
  /**
   * Whether Tenna's channel wall is behind this window.
   *
   * It decides what leaving looks like. A site opened from the wall collapses
   * back to it; one opened from the launcher closes outright, because the
   * shutoff would be playing over the launcher's own animation.
   */
  fromWall: boolean;
  /**
   * A share staged for this site, waiting to be handed to it.
   *
   * Set when the window was opened out of the OS share sheet. The site opens
   * on the share rather than on its front page — see `useNsiteShareDelivery`.
   */
  shareToken?: string;
  /** The site's `share_target` as JSON text, as of when it was last read. */
  shareTarget?: string;
  /**
   * Where inside the site to open, when a notification named a place.
   *
   * Site-absolute. The site opens there rather than on its front page, the
   * same way it opens on a share — see `NsiteApp`.
   */
  path?: string;
}

/**
 * Asked once per window, and shared.
 *
 * The answer decides whether this is Tenna or a single site, which is the
 * first thing it has to know and never changes afterwards. Holding the promise
 * at module scope means the question survives a remount and is never asked
 * twice — and module scope is per window, since every task boots the web layer
 * into a WebView of its own.
 */
let launchQuery: Promise<NsiteLaunch | null> | null = null;

function askLauncher(): Promise<NsiteLaunch | null> {
  if (!supportsNsiteWindows()) return Promise.resolve(null);

  return NsiteShortcuts.getLaunchSite()
    .then(({ siteId, event, label, channel, fromWall, shareToken, shareTarget, path }) => {
      if (!siteId) return null;
      return {
        siteId,
        label: label ?? siteId,
        event: parseEvent(event),
        channel: channel ?? null,
        fromWall: !!fromWall,
        shareToken,
        shareTarget,
        path,
      };
    })
    .catch(() => null);
}

/** A stored manifest, or null if it is missing or not one. */
function parseEvent(json: string | undefined): NostrEvent | null {
  if (!json) return null;

  try {
    const event = JSON.parse(json) as unknown;
    if (typeof event !== 'object' || event === null) return null;

    const { id, pubkey, kind, tags } = event as Partial<NostrEvent>;
    if (typeof id !== 'string' || typeof pubkey !== 'string') return null;
    if (typeof kind !== 'number' || !isNsiteKind(kind)) return null;
    if (!Array.isArray(tags)) return null;

    return event as NostrEvent;
  } catch {
    return null;
  }
}

/**
 * What this launch of the app is for.
 *
 * `pending` gates the first render: the home screen must not flash up behind a
 * site that was opened directly from the launcher. It is one bridge call, and
 * on any platform without shortcuts it resolves synchronously to nothing.
 */
export function useNsiteLaunch(): { pending: boolean; launch: NsiteLaunch | null } {
  const [state, setState] = useState<{ pending: boolean; launch: NsiteLaunch | null }>(
    // Nothing to ask on the web, so nothing to wait for either.
    () => (supportsNsiteWindows() ? { pending: true, launch: null } : { pending: false, launch: null }),
  );

  useEffect(() => {
    if (!state.pending) return;

    let disposed = false;
    launchQuery ??= askLauncher();
    void launchQuery.then((launch) => {
      if (!disposed) setState({ pending: false, launch });
    });

    return () => { disposed = true; };
  }, [state.pending]);

  return state;
}

/**
 * Where inside the site to open, as of now.
 *
 * Starts as whatever the window was opened with, and is replaced when another
 * notification is tapped for a window that never closed — which is the
 * ordinary case for an app the user is already in, not the exception.
 */
export function useNsiteOpenPath(initial: string | undefined): string | undefined {
  const [live, setLive] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      listener = await NsiteShortcuts.addListener('nsiteOpenPath', ({ path }) => {
        if (!disposed && path) setLive(path);
      });
      if (disposed) void listener.remove();
    })().catch(() => {
      // Nothing to listen to on this build.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, []);

  return live ?? initial;
}

/**
 * The current manifest for a pinned site, fetched in the background.
 *
 * A shortcut outlives the manifest it was made from. The site publishes again
 * and the record on disk still names last week's blobs, so a pinned site would
 * be frozen on the day it was pinned unless something goes and looks.
 *
 * The result is deliberately *not* rendered. Swapping the manifest under a
 * running site would tear its WebView down and start it over, in the middle of
 * whatever the user was doing; what it is for is the next cold press.
 */
export function useNsiteRefresh(launch: NsiteLaunch | null) {
  const { nostr } = useNostr();

  const { data } = useQuery({
    queryKey: ['nsite-refresh', launch?.siteId],
    enabled: !!launch,
    queryFn: async (c) => {
      const parsed = parseNsiteSubdomain(launch!.siteId);
      // A snapshot is a regular event named by its own id: it is already
      // exactly the bytes it will always be, so there is nothing to look for.
      if (!parsed || parsed.kind === NSITE_SNAPSHOT_KIND) return null;

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.relay(NSITE_RELAY).query(
        [
          parsed.kind === NSITE_NAMED_KIND
            ? { kinds: [NSITE_NAMED_KIND], authors: [parsed.pubkey], '#d': [parsed.identifier], limit: 1 }
            : { kinds: [NSITE_ROOT_KIND], authors: [parsed.pubkey], limit: 1 },
        ],
        { signal },
      );

      return events.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    },
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });

  useEffect(() => {
    if (!launch || !data) return;
    if (data.id === launch.event?.id) return;

    void NsiteShortcuts.refresh({
      siteId: launch.siteId,
      label: launch.label,
      event: JSON.stringify(data),
    }).catch(() => {
      // A site that couldn't be refreshed keeps serving what it has.
    });
  }, [launch, data]);

  return data ?? null;
}
