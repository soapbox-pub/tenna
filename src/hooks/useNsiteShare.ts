import { useEffect, useState } from 'react';

import {
  NsiteShortcuts,
  supportsNsiteWindows,
  supportsShareSheet,
  type NsitePendingShare,
} from '@/lib/nsiteShortcutsPlugin';
import {
  parseShareTarget,
  planShareDelivery,
  type NsiteShareDelivery,
  type NsiteShareTarget,
} from '@/lib/nsiteShareTarget';

/**
 * A site's stored `share_target`, read back and checked again.
 *
 * The record on disk was written by an earlier version of this app, from a
 * manifest that has since been able to change, so what comes back out is
 * treated as untrusted input and put through the same rules it went in by.
 * `parseShareTarget` wants the whole manifest, so the stored member is wrapped
 * back into one; the action is already site-absolute, so it needs no base.
 */
export function readShareTarget(json: string | undefined): NsiteShareTarget | null {
  if (!json) return null;

  try {
    return parseShareTarget({ share_target: JSON.parse(json) }, '/');
  } catch {
    return null;
  }
}

/** Where a share is in its journey from the sheet to the site. */
type ShareState =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'ready'; delivery: NsiteShareDelivery | null };

/**
 * Work out how to hand a staged share to the site this window is for.
 *
 * Resolved before the site is opened rather than after, because the answer is
 * the URL it opens on — a share delivered to a site already sitting on its
 * front page would mean loading the site twice, and the second load throwing
 * away whatever the first had started.
 *
 * A null delivery with `ready` means the share cannot be given to this site:
 * it declares no target any more, or none that fits what was shared. The
 * caller opens the site normally, which is a better answer than a dead end.
 */
export function useNsiteShareDelivery(launch: {
  siteId: string;
  shareToken?: string;
  shareTarget?: string;
} | null): ShareState {
  const token = launch?.shareToken;
  const stored = launch?.shareTarget;

  // Keyed by the token it answers rather than reset when one arrives, so that
  // "not resolved yet" is something this renders rather than something it has
  // to set — an effect that writes state on its way in only re-renders twice
  // to say what the first render already knew.
  const [resolved, setResolved] = useState<{
    token: string;
    delivery: NsiteShareDelivery | null;
  } | null>(null);

  useEffect(() => {
    if (!token) return;

    let disposed = false;

    void (async () => {
      const target = readShareTarget(stored);
      let delivery: NsiteShareDelivery | null = null;

      if (target) {
        try {
          const payload = await NsiteShortcuts.getSharePayload({ token });
          delivery = planShareDelivery(target, payload, token);
        } catch {
          // The staging directory is gone — swept, or already delivered.
        }
      }

      // A GET share is spent the moment its URL is built; a POST one is read
      // back from disk by the bootstrap page, so it has to outlive this.
      if (!delivery || delivery.kind === 'get') {
        await NsiteShortcuts.releaseShare({ token }).catch(() => {});
      }

      if (!disposed) setResolved({ token, delivery });
    })();

    return () => { disposed = true; };
  }, [token, stored]);

  if (!token) return { status: 'none' };
  if (resolved?.token !== token) return { status: 'pending' };
  return { status: 'ready', delivery: resolved.delivery };
}

/**
 * The share this window is to deliver, as of now.
 *
 * Starts as whatever the window was opened with. A second one may arrive at a
 * window that never closed — sharing into an app you already have open is the
 * ordinary case, not the exception — and replaces it.
 */
export function useShareToken(initial: string | undefined): string | undefined {
  const [live, setLive] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!supportsNsiteWindows()) return;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      listener = await NsiteShortcuts.addListener('nsiteShare', ({ token }) => {
        if (!disposed && token) setLive(token);
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
 * A share the user sent to Tenna itself, with no site chosen.
 *
 * The share sheet decides for itself whether to show the per-site entries, and
 * on a share it renders as a flat list of apps they are simply absent — so
 * Tenna takes shares under its own name too, and asks. One arrives either on
 * the intent this window started with, or, if the wall was already up, as an
 * event.
 */
export function usePendingShare(): {
  share: NsitePendingShare | null;
  dismiss: () => void;
  handOff: () => void;
} {
  const [share, setShare] = useState<NsitePendingShare | null>(null);

  useEffect(() => {
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    const take = (pending: NsitePendingShare) => {
      if (!disposed && pending.token && pending.payload) setShare(pending);
    };

    if (!supportsShareSheet()) return;

    void (async () => {
      listener = await NsiteShortcuts.addListener('nsiteShare', take);
      if (disposed) {
        void listener.remove();
        return;
      }
      take(await NsiteShortcuts.getPendingShare());
    })().catch(() => {
      // No share sheet integration on this build; nothing to wait for.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, []);

  return {
    share,

    // Closed with nowhere to go: nobody is coming for the staged bytes, so
    // they go now rather than waiting on the next sweep.
    dismiss: () => {
      setShare((current) => {
        if (current?.token) {
          void NsiteShortcuts.releaseShare({ token: current.token }).catch(() => {});
        }
        return null;
      });
    },

    // Given to a site instead. The staging directory has to outlive this
    // window — the site's own window is about to open and read it — so this
    // closes the picker and lets go of the share without unstaging it.
    handOff: () => setShare(null),
  };
}
