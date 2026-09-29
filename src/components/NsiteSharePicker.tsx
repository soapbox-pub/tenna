import type { NostrEvent } from '@nostrify/nostrify';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { readShareTarget } from '@/hooks/useNsiteShare';
import { useToast } from '@/hooks/useToast';
import { impactLight } from '@/lib/haptics';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import {
  NsiteShortcuts,
  supportsNsiteWindows,
  supportsShareSheet,
  type NsitePendingShare,
} from '@/lib/nsiteShortcutsPlugin';
import {
  planShareDelivery,
  type NsiteShareDelivery,
  type NsiteSharePayload,
} from '@/lib/nsiteShareTarget';

interface NsiteSharePickerProps {
  share: NsitePendingShare | null;
  onDismiss: () => void;
  onHandOff: () => void;
  /**
   * Open the site over the wall, delivering the share. Where a site cannot be
   * given a window of its own — iOS — this is how it is shared to.
   */
  onDeliver?: (event: NostrEvent, delivery: NsiteShareDelivery) => void;
}

/** One site the share could go to, with the tile to press. */
interface Destination {
  siteId: string;
  label: string;
  event: string;
  icon?: string;
}

/**
 * Which sites will take what was shared.
 *
 * The same test the site itself will apply when the share arrives, run early
 * so that a site with nowhere to put a photograph is not offered one. A site
 * whose stored target no longer parses is simply not a destination.
 */
function destinations(
  sites: Array<Destination & { shareTarget: string }>,
  payload: NsiteSharePayload,
): Destination[] {
  return sites.filter(({ shareTarget }) => {
    const target = readShareTarget(shareTarget);
    // The token is only there to be embedded in a URL, and no URL is built
    // here — this is the plan being used as a question rather than an answer.
    return !!target && planShareDelivery(target, payload, 'probe') !== null;
  });
}

/**
 * Where a share sent to Tenna itself ends up.
 *
 * Android decides on its own whether the per-site entries surface in the share
 * sheet, and on a share it chooses to render as a flat list of apps they are
 * simply absent. So Tenna takes shares under its own name too and asks here,
 * which is the way in that never depends on that ranking.
 */
export function NsiteSharePicker({ share, onDismiss, onHandOff, onDeliver }: NsiteSharePickerProps) {
  const { toast } = useToast();

  const { data: sites, isPending } = useQuery({
    queryKey: ['nsite-share-targets'],
    enabled: !!share && supportsShareSheet(),
    queryFn: async () => (await NsiteShortcuts.listShareTargets()).sites,
    staleTime: 0,
    gcTime: 0,
  });

  const payload = share?.payload;

  const options = useMemo(
    () => (sites && payload ? destinations(sites, payload) : []),
    [sites, payload],
  );

  const send = (destination: Destination) => {
    const token = share?.token;
    if (!token) return;

    void (async () => {
      try {
        impactLight();

        // No window to give the site: it is opened over the wall instead, on
        // the share. The plan is made here rather than in a window of its own.
        if (!supportsNsiteWindows()) {
          const site = sites?.find(({ siteId }) => siteId === destination.siteId);
          const target = readShareTarget(site?.shareTarget);
          const delivery = target && payload ? planShareDelivery(target, payload, token) : null;
          if (!delivery || !onDeliver) throw new Error('That app cannot take this');
          // A GET share is spent once its URL is built; a POST one is read
          // back when it is delivered, and let go of then.
          if (delivery.kind === 'get') {
            await NsiteShortcuts.releaseShare({ token }).catch(() => {});
          }
          onDeliver(JSON.parse(destination.event) as NostrEvent, delivery);
          onHandOff();
          return;
        }

        await NsiteShortcuts.open({
          siteId: destination.siteId,
          label: destination.label,
          event: destination.event,
          icon: destination.icon,
          shareToken: token,
        });
        // The site's window owns the share from here; releasing it is that
        // window's business, once it has read what is in it.
        onHandOff();
      } catch (err) {
        toast({
          title: 'Could not share to that app',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
      }
    })();
  };

  const what = payload?.files.length
    ? `${payload.files.length} file${payload.files.length === 1 ? '' : 's'}`
    : 'what you shared';

  return (
    <Dialog open={!!share} onOpenChange={(open) => { if (!open) onDismiss(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share to an app</DialogTitle>
          <DialogDescription>
            {isPending
              ? 'Looking for apps that can take it…'
              : options.length > 0
                ? `Pick where to send ${what}.`
                : 'None of your apps can take this.'}
          </DialogDescription>
        </DialogHeader>

        {options.length > 0 && (
          <div className="grid grid-cols-4 gap-x-4 gap-y-6 py-2">
            {options.map((destination) => (
              <button
                key={destination.siteId}
                type="button"
                onClick={() => send(destination)}
                className="group flex w-full flex-col items-center gap-2 outline-none"
              >
                <span className="relative block aspect-square w-full drop-shadow-[0_6px_12px_rgba(0,0,0,0.55)] motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:-translate-y-1">
                  <span
                    aria-hidden="true"
                    className="app-squircle absolute -inset-[3px] bg-primary opacity-0 transition-opacity group-focus-visible:opacity-100"
                  />
                  <span
                    className="app-squircle absolute inset-0 overflow-hidden"
                    style={{ background: getTileGradient(destination.label) }}
                  >
                    {destination.icon ? (
                      <img
                        // A PNG this app drew itself, out of the tile already
                        // on the wall — not anything the site handed over.
                        src={`data:image/png;base64,${destination.icon}`}
                        alt=""
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    ) : (
                      <span className="absolute inset-0 flex items-center justify-center font-crt text-3xl text-white/90">
                        {getTileInitial(destination.label)}
                      </span>
                    )}
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.22),transparent_45%)]"
                    />
                  </span>
                </span>

                <span className="w-full truncate px-0.5 text-center text-xs sm:text-sm">
                  {destination.label}
                </span>
              </button>
            ))}
          </div>
        )}

        {!isPending && options.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">
            An app has to be on your wall, and has to say it takes shares, before it can
            appear here.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
