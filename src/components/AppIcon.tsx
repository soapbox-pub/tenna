import type { NostrEvent } from '@nostrify/nostrify';
import { Check, Info, Plus, SquarePlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

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
import {
  getNsiteName,
  getNsiteSubdomain,
  NSITE_NAMED_KIND,
  parseNsiteSubdomain,
} from '@/lib/nsiteSubdomain';
import { readTileSnapshot, writeTileSnapshot } from '@/lib/tileSnapshot';

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
 * What to call a site from its address alone. A named site is addressed by
 * its `d` tag, which is the name its manifest falls back to anyway; a root
 * site or a snapshot is addressed by a key, so the start of it is all there is.
 */
function nameFromAddress(siteId: string): string {
  const pointer = parseNsiteSubdomain(siteId);
  if (pointer?.kind === NSITE_NAMED_KIND && pointer.identifier) return pointer.identifier;
  return `${siteId.slice(0, 9)}…`;
}

/**
 * A site whose manifest hasn't arrived.
 *
 * Still a tile, in its place, because the user put it there. It is drawn as
 * it last was, if it ever was, and as static under its address otherwise; it
 * can't be opened yet, and the one thing that can be done to it is take it
 * off.
 */
export function AppIconPending({
  siteId,
  onRemove,
  menuOpen,
  onMenuOpenChange,
}: { siteId: string } & Pick<AppIconProps, 'onRemove' | 'menuOpen' | 'onMenuOpenChange'>) {
  const [snapshot] = useState(() => readTileSnapshot(siteId));
  const name = snapshot?.name ?? nameFromAddress(siteId);

  return (
    <>
      <TileButton
        name={name}
        onSelect={() => {}}
        onContextMenu={(clicked) => {
          clicked.preventDefault();
          onMenuOpenChange(true);
        }}
      >
        {snapshot ? (
          <TileArtwork
            name={name}
            iconUrl={snapshot.icon}
            fit={snapshot.fit}
            background={snapshot.background}
          />
        ) : (
          <TileStatic />
        )}
      </TileButton>

      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange} modal={false}>
        <TileMenuAnchor />
        <DropdownMenuContent className={MENU} align="center" collisionPadding={16}>
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
    </>
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
 * The tile is never empty, and on a site seen before it is never static: it
 * is drawn as it was last drawn, from a record on the device, on the first
 * frame — and redrawn from the site itself when that has been read, which is
 * also when the record is written for next time. A site never seen before
 * plays static while its icon is resolved, and one that turns out to have no
 * icon at all keeps a tile in its own color with its initial on it.
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

  const siteId = getNsiteSubdomain(event);
  const [snapshot] = useState(() => readTileSnapshot(siteId));

  // The site's own name for itself once it has been read; until then, what
  // it was called last time, or what the manifest calls it.
  const fallback = getNsiteName(event) ?? '???';
  const name = app ? (app.label ?? fallback) : (snapshot?.name ?? fallback);

  useEffect(() => {
    if (!app) return;
    writeTileSnapshot(siteId, {
      name,
      // The data URL where the pixels could be read back; failing that, a
      // hotlink is a URL that will still be there tomorrow, and a blob is not.
      icon: app.thumb ?? (app.iconUrl?.startsWith('https:') ? app.iconUrl : null),
      fit: app.fit,
      background: app.background,
      from: event.id,
    });
  }, [app, name, siteId, event.id]);

  // What is drawn: the site's answer, then last time's, then static.
  const art = app ?? snapshot;

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
        {art ? (
          <TileArtwork
            name={name}
            iconUrl={'iconUrl' in art ? art.iconUrl : art.icon}
            fit={art.fit}
            background={art.background}
          />
        ) : isPending ? (
          <TileStatic />
        ) : (
          <TileArtwork name={name} />
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
