import type { NostrEvent } from '@nostrify/nostrify';
import { Check, Info, Plus, SquarePlus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import { NsiteAppInfo } from '@/components/NsiteAppInfo';
import {
  TileArtwork,
  TileButton,
  TileFace,
  TileMenuAnchor,
  TileStatic,
} from '@/components/Tile';
import { MENU, MENU_ITEM, MENU_ITEM_DESTRUCTIVE } from '@/components/tile-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useNsitePin } from '@/hooks/useNsitePin';
import { useNsiteWindow } from '@/hooks/useNsiteWindow';
import { getNsiteName } from '@/lib/nsiteSubdomain';

interface AppIconProps {
  event: NostrEvent;
  /** 1-based position among the sites, which is the site's channel number. */
  channel: number;
  /** Tune the site in here, for platforms that can't give it a window. */
  onSelect: () => void;
  /** Take the site off the wall. */
  onRemove?: () => void;
  /**
   * Whether the tile's menu is up.
   *
   * Held by the wall rather than by the tile, because the gesture that opens
   * it is the same one that picks the tile up to move it, and only the wall
   * can see both. See `useWallDrag`.
   */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
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
export function AppIcon({
  event,
  channel,
  onSelect,
  onRemove,
  menuOpen,
  onMenuOpenChange,
}: AppIconProps) {
  const { data: app, isPending } = useNsiteApp(event);

  // The manifest's name for the site until the site itself says what it goes by.
  const name = app?.label ?? getNsiteName(event) ?? '???';

  // An `AppIcon` is a tile on the wall and nowhere else, so it is always a
  // site the user has — a site merely being browsed in the picker draws itself
  // and is never announced to the system. Its channel is its place on the
  // wall, which is where it ranks in the share sheet. See `useNsitePin`.
  const pinning = useNsitePin(event, name, app, true, channel - 1);
  const ownWindow = useNsiteWindow(event, name, app);

  const [infoOpen, setInfoOpen] = useState(false);

  // Where a site can have a window of its own, it gets one — pressing the tile
  // launches the site rather than tuning it in over the wall. Everywhere else
  // the wall is the only screen there is, so the viewer opens on top of it.
  const launch = useCallback(() => {
    if (ownWindow.available) ownWindow.open(channel);
    else onSelect();
  }, [ownWindow, channel, onSelect]);

  // Every tile has a menu, because every app has an info panel — a site the
  // user can neither pin nor take off the wall has still been granted things,
  // and this is the only place to see what.
  return (
    <>
      <TileButton
        name={name}
        onSelect={launch}
        // A right-click, or the key that stands in for one. The finger's way
        // in is the hold, which the wall detects and answers with `menuOpen`.
        onContextMenu={(clicked) => {
          clicked.preventDefault();
          onMenuOpenChange(true);
        }}
      >
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

      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange} modal={false}>
        <TileMenuAnchor />
        {/* Kept off the edges of the screen: a tile at the end of a row is at
            the edge, and the menu is wider than it is. */}
        <DropdownMenuContent className={MENU} align="center" collisionPadding={16}>
          <DropdownMenuItem className={MENU_ITEM} onSelect={() => setInfoOpen(true)}>
            <Info />
            App info
          </DropdownMenuItem>
          {pinning.available && (
            <DropdownMenuItem
              className={MENU_ITEM}
              onSelect={pinning.pin}
              disabled={pinning.pinned}
            >
              {pinning.pinned ? <Check /> : <SquarePlus />}
              {pinning.pinned ? 'On your home screen' : 'Add to home screen'}
            </DropdownMenuItem>
          )}
          {onRemove && (
            <DropdownMenuItem
              className={MENU_ITEM_DESTRUCTIVE}
              onSelect={onRemove}
              variant="destructive"
            >
              <Trash2 />
              Remove from Tenna
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
