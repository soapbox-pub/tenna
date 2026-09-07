import type { NostrEvent } from '@nostrify/nostrify';
import { Check, Info, Plus, SquarePlus, Trash2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { NsiteAppInfo } from '@/components/NsiteAppInfo';
import {
  TileArtwork,
  TileButton,
  TileFace,
  TileFrame,
  TileStatic,
} from '@/components/Tile';
import { MENU, MENU_ITEM, MENU_ITEM_DESTRUCTIVE } from '@/components/tile-variants';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useNsitePin } from '@/hooks/useNsitePin';
import { useNsiteWindow } from '@/hooks/useNsiteWindow';
import { impactMedium } from '@/lib/haptics';
import { getNsiteName } from '@/lib/nsiteSubdomain';

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
 * A tile with nothing tuned into it yet, for the wait before the lineup itself
 * arrives — there is no site to name, so the label is a bar.
 */
export function AppIconSkeleton() {
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <TileFrame>
        <TileStatic />
      </TileFrame>
      <span className="h-3 w-3/4 rounded-full bg-white/15 motion-safe:animate-pulse" />
    </div>
  );
}

/**
 * The tile at the end of the lineup, which is not an app but the way to add
 * one.
 *
 * It sits in the grid as a tile because that is where a person looks for it,
 * and it is drawn as an empty one — no artwork, no colour of its own — so it
 * reads as a slot waiting to be filled rather than as another app.
 */
export function AddAppTile({ onSelect }: { onSelect: () => void }) {
  return (
    <TileButton name="Add app" title="Add an app" onSelect={onSelect}>
      <TileFace background="rgba(255,255,255,0.09)">
        <span className="absolute inset-0 flex items-center justify-center">
          <Plus
            aria-hidden="true"
            strokeWidth={1.5}
            className="h-1/2 w-1/2 text-white/70 transition-colors group-hover:text-white group-focus-visible:text-white"
          />
        </span>
      </TileFace>
    </TileButton>
  );
}

/**
 * One nsite on the home screen: a rounded tile with the site's own icon on it
 * and its name underneath.
 *
 * The tile is never empty. Static plays on it while the icon is being resolved
 * — the site is known by then, so its name is already under the tile — and a
 * site that turns out to have no icon at all keeps a tile in its own color
 * with its initial on it.
 */
export function AppIcon({ event, channel, onSelect, onRemove }: AppIconProps) {
  const { data: app, isPending } = useNsiteApp(event);

  // The manifest's name for the site until the site itself says what it goes by.
  const name = app?.label ?? getNsiteName(event) ?? '???';

  const pinning = useNsitePin(event, name, app);
  const ownWindow = useNsiteWindow(event, name, app);

  const [infoOpen, setInfoOpen] = useState(false);

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
  const launch = useCallback(() => {
    if (ownWindow.available) ownWindow.open(channel);
    else onSelect();
  }, [ownWindow, channel, onSelect]);

  const handleSelect = useCallback(() => {
    if (suppressTap.current) return;
    launch();
  }, [launch]);

  const tile = (
    <TileButton name={name} onSelect={handleSelect}>
      {isPending ? (
        <TileStatic />
      ) : (
        <TileArtwork
          name={name}
          iconUrl={app?.iconUrl}
          fit={app?.fit}
          background={app?.background}
        />
      )}
    </TileButton>
  );

  // Every tile has a menu, because every app has an info panel — a site the
  // user can neither pin nor take off the wall has still been granted things,
  // and this is the only place to see what.
  return (
    <>
      <ContextMenu onOpenChange={handleOpenChange}>
        <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
        {/* Kept off the edges of the screen: the menu opens where the finger
            is, and a finger on the last tile in a row is at the edge. */}
        <ContextMenuContent className={MENU} collisionPadding={16}>
          <ContextMenuItem className={MENU_ITEM} onSelect={() => setInfoOpen(true)}>
            <Info />
            App info
          </ContextMenuItem>
          {pinning.available && (
            <ContextMenuItem
              className={MENU_ITEM}
              onSelect={pinning.pin}
              disabled={pinning.pinned}
            >
              {pinning.pinned ? <Check /> : <SquarePlus />}
              {pinning.pinned ? 'On your home screen' : 'Add to home screen'}
            </ContextMenuItem>
          )}
          {onRemove && (
            <ContextMenuItem
              className={MENU_ITEM_DESTRUCTIVE}
              onSelect={onRemove}
              variant="destructive"
            >
              <Trash2 />
              Remove from Tenna
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Outside the menu, which is gone by the time this opens. It is handed
          the same verbs the menu offers, because it stands in for the screen
          the device shows for its own apps, and that screen is where they all
          are. */}
      <NsiteAppInfo
        event={event}
        name={name}
        app={app}
        open={infoOpen}
        onOpenChange={setInfoOpen}
        onOpen={launch}
        pinning={pinning}
        onRemove={onRemove}
      />
    </>
  );
}
