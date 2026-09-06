import type { NostrEvent } from '@nostrify/nostrify';
import { Check, Plus, SlidersHorizontal, SquarePlus, Trash2 } from 'lucide-react';
import { useCallback, useRef, useState, type ReactNode } from 'react';

import { NsiteAppSettings } from '@/components/NsiteAppSettings';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useNsitePin } from '@/hooks/useNsitePin';
import { useNsiteWindow } from '@/hooks/useNsiteWindow';
import { impactMedium } from '@/lib/haptics';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { cn } from '@/lib/utils';

interface AppIconProps {
  event: NostrEvent;
  /** 1-based position on the wall, which is the site's channel number. */
  channel: number;
  /** Tune the site in here, for platforms that can't give it a window. */
  onSelect: () => void;
  /** Take the site off the wall, for the ones the user put there. */
  onRemove?: () => void;
}

/**
 * The face of a tile: the squircle, whatever is on it, and the sheen of light
 * across the glass.
 */
function TileFace({ background, children }: { background: string; children: ReactNode }) {
  return (
    <span className="app-squircle absolute inset-0 overflow-hidden" style={{ background }}>
      {children}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.22),transparent_45%)]"
      />
    </span>
  );
}

/** The tile, its shadow, and the halo that marks focus. */
function TileFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'relative block aspect-square w-full drop-shadow-[0_6px_12px_rgba(0,0,0,0.55)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A tile with nothing tuned into it yet, for the wait before the lineup itself
 * arrives — there is no site to name, so the label is a bar.
 */
export function AppIconSkeleton() {
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <TileFrame>
        <TileFace background="#0A0A0A">
          <WhiteNoise className="absolute inset-0 opacity-90" />
        </TileFace>
      </TileFrame>
      <span className="h-3 w-3/4 rounded-full bg-white/15 motion-safe:animate-pulse" />
    </div>
  );
}

/**
 * The tile at the end of the lineup, which is not a site but the way to add
 * one.
 *
 * It sits in the grid as a tile because that is where a person looks for it,
 * and it is drawn as an empty one — no artwork, no colour of its own — so it
 * reads as a slot waiting to be filled rather than as another app.
 */
export function AddAppTile({ onSelect }: { onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title="Add an app"
      className="group flex w-full flex-col items-center gap-2 outline-none"
    >
      <TileFrame className="motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:-translate-y-1">
        <span
          aria-hidden="true"
          className="app-squircle absolute -inset-[3px] bg-[#FEF960] opacity-0 transition-opacity group-focus-visible:opacity-100"
        />
        <TileFace background="rgba(255,255,255,0.09)">
          <span className="absolute inset-0 flex items-center justify-center">
            <Plus
              aria-hidden="true"
              strokeWidth={1.5}
              className="h-1/2 w-1/2 text-white/70 transition-colors group-hover:text-white group-focus-visible:text-white"
            />
          </span>
        </TileFace>
      </TileFrame>

      <span className="w-full truncate px-0.5 text-center text-xs text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] sm:text-sm">
        Add app
      </span>
    </button>
  );
}

/**
 * One app on the home screen: a rounded tile with the site's own icon on it
 * and its name underneath.
 *
 * The tile is never empty. Static plays on it while the icon is being resolved
 * — the site is known by then, so its name is already under the tile — and a
 * site that turns out to have no icon at all keeps a tile in its own color
 * with its initial on it.
 *
 * The shadow and the focus halo are both cast outside the tile, so neither can
 * live on the tile itself: the mask that cuts its corners would cut them off
 * with them. The shadow is a `drop-shadow` filter on the frame, which reads
 * the alpha of what it wraps and so follows the squircle, and the halo is a
 * second squircle sitting a few pixels proud behind it.
 */
export function AppIcon({ event, channel, onSelect, onRemove }: AppIconProps) {
  const { data: app, isPending } = useNsiteApp(event);

  // The nsite's own name until the site says what it calls itself.
  const name = app?.label ?? event.tags.find(([n]) => n === 'd')?.[1] ?? '???';

  const pinning = useNsitePin(event, name, app);
  const ownWindow = useNsiteWindow(event, name, app);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // A long press is a press. The menu opens on pointerdown and the pointerup
  // that follows still lands on the tile, so without this the site would tune
  // in behind the menu that was opened to avoid tuning it in. Held until just
  // after the menu closes, so dismissing it doesn't arm a stray tap either.
  const suppressTap = useRef(false);

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      suppressTap.current = true;
      impactMedium();
    } else {
      setTimeout(() => { suppressTap.current = false; }, 250);
    }
  }, []);

  // Where a site can have a window of its own, it gets one — pressing the tile
  // launches the site rather than tuning it in over the wall. Everywhere else
  // the wall is the only screen there is, so the viewer opens on top of it.
  const handleSelect = useCallback(() => {
    if (suppressTap.current) return;
    if (ownWindow.available) ownWindow.open(channel);
    else onSelect();
  }, [ownWindow, channel, onSelect]);

  const tile = (
    <button
      type="button"
      onClick={handleSelect}
      title={name}
      className="group flex w-full flex-col items-center gap-2 outline-none"
    >
      <TileFrame className="motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:-translate-y-1">
        <span
          aria-hidden="true"
          className="app-squircle absolute -inset-[3px] bg-[#FEF960] opacity-0 transition-opacity group-focus-visible:opacity-100"
        />
        {isPending ? (
          <TileFace background="#0A0A0A">
            <WhiteNoise className="absolute inset-0 opacity-90" />
          </TileFace>
        ) : (
          <TileFace background={app?.background ?? getTileGradient(name)}>
            {app?.iconUrl ? (
              <img
                src={app.iconUrl}
                alt=""
                decoding="async"
                loading="lazy"
                className={cn(
                  'absolute',
                  app.fit === 'cover'
                    ? 'inset-0 h-full w-full object-cover'
                    : 'inset-[18%] h-[64%] w-[64%] object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]',
                )}
              />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-3xl font-semibold leading-none text-white/95 sm:text-4xl">
                {getTileInitial(name)}
              </span>
            )}
          </TileFace>
        )}
      </TileFrame>

      <span className="w-full truncate px-0.5 text-center text-xs text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] sm:text-sm">
        {name}
      </span>
    </button>
  );

  // Every tile has a menu, because every app has settings — a site the user
  // can neither pin nor take off the wall has still been granted things, and
  // this is the only place to see what.
  return (
    <>
      <ContextMenu onOpenChange={handleOpenChange}>
        <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem onSelect={() => setSettingsOpen(true)}>
            <SlidersHorizontal />
            App settings
          </ContextMenuItem>
          {pinning.available && (
            <ContextMenuItem onSelect={pinning.pin} disabled={pinning.pinned}>
              {pinning.pinned ? <Check /> : <SquarePlus />}
              {pinning.pinned ? 'On your home screen' : 'Add to home screen'}
            </ContextMenuItem>
          )}
          {onRemove && (
            <ContextMenuItem onSelect={onRemove} variant="destructive">
              <Trash2 />
              Remove from Tenna
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Outside the menu, which is gone by the time this opens. */}
      <NsiteAppSettings
        event={event}
        name={name}
        app={app}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </>
  );
}
