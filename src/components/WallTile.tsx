import type { NostrEvent } from '@nostrify/nostrify';
import { Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import { AppIcon } from '@/components/AppIcon';
import { NativeAppIcon } from '@/components/NativeAppIcon';
import { TileButton, TileMenuAnchor, TileStatic } from '@/components/Tile';
import { MENU, MENU_ITEM_DESTRUCTIVE } from '@/components/tile-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useInstalledApps } from '@/hooks/useNativeApps';
import { useNsiteManifest } from '@/hooks/useNsiteManifest';
import type { NativeApp } from '@/lib/nativeAppsPlugin';
import { NSITE_NAMED_KIND, parseNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { parseWallUri, type WallAddress } from '@/lib/wallUri';

interface WallTileProps {
  /** The address on the wall this tile stands for. */
  uri: string;
  /** Its place among the sites, 1-based, which is the channel it tunes to. */
  channel: number;
  /** Tune a site in over the wall, for platforms that can't give it a window. */
  onSelect: (event: NostrEvent, channel: number) => void;
  /** Take the tile off the wall. */
  onRemove: () => void;
  /** Whether the tile's menu is up — the wall's business. See `AppIcon`. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

/** The menu a tile has when it has nothing else: the way off the wall. */
function RemoveOnlyMenu({
  menuOpen,
  onMenuOpenChange,
  onRemove,
}: Pick<WallTileProps, 'menuOpen' | 'onMenuOpenChange' | 'onRemove'>) {
  return (
    <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange} modal={false}>
      <TileMenuAnchor />
      <DropdownMenuContent className={MENU} align="center" collisionPadding={16}>
        <DropdownMenuItem
          className={MENU_ITEM_DESTRUCTIVE}
          onSelect={onRemove}
          variant="destructive"
        >
          <Trash2 />
          Remove from Tenna
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * What to call a site from its address alone.
 *
 * A named site is addressed by its `d` tag, which is the name its manifest
 * would fall back to anyway. A root site or a snapshot is addressed by a key,
 * so the most that can be said is the start of it.
 */
function nameFromAddress(id: string): string {
  const pointer = parseNsiteSubdomain(id);
  if (pointer?.kind === NSITE_NAMED_KIND && pointer.identifier) return pointer.identifier;
  return `${id.slice(0, 9)}…`;
}

/**
 * A site on the wall.
 *
 * The site's manifest is looked up here, by this tile and for this tile, and
 * the tile is drawn either way: with the manifest it is an `AppIcon`, with
 * the site's own name and artwork and everything that can be done to it;
 * without one it is static under the best name its address gives, and the
 * one thing that can be done to it is take it off. It never draws nothing,
 * because a site the user added is a site the user has whether or not a
 * relay has been reached today.
 */
function NsiteTile({
  address,
  channel,
  onSelect,
  onRemove,
  menuOpen,
  onMenuOpenChange,
}: Omit<WallTileProps, 'uri'> & { address: Extract<WallAddress, { kind: 'nsite' }> }) {
  const { data: event } = useNsiteManifest(address.id, address.relays);

  if (event) {
    return (
      <AppIcon
        event={event}
        channel={channel}
        onSelect={() => onSelect(event, channel)}
        onRemove={onRemove}
        menuOpen={menuOpen}
        onMenuOpenChange={onMenuOpenChange}
      />
    );
  }

  const name = nameFromAddress(address.id);

  return (
    <>
      <TileButton
        name={name}
        title={`${name} — still loading`}
        onSelect={() => {
          // Nothing to open yet. The tile is here so its place on the wall
          // is, and so it can be taken off.
        }}
        onContextMenu={(clicked) => {
          clicked.preventDefault();
          onMenuOpenChange(true);
        }}
      >
        <TileStatic />
      </TileButton>

      <RemoveOnlyMenu menuOpen={menuOpen} onMenuOpenChange={onMenuOpenChange} onRemove={onRemove} />
    </>
  );
}

/**
 * One of the device's own apps on the wall.
 *
 * Drawn from the address alone — package, activity, and the name it was added
 * under — so the tile is up before the package manager has been asked
 * anything. If the device's list is in hand it lends the app's current name,
 * since an update may have renamed it; it is never waited for and never
 * decides whether the tile is drawn. An app that has since been uninstalled
 * says so when pressed, and comes off when the user takes it off.
 */
function NativeTile({
  address,
  onRemove,
  menuOpen,
  onMenuOpenChange,
}: Pick<WallTileProps, 'onRemove' | 'menuOpen' | 'onMenuOpenChange'> & {
  address: Extract<WallAddress, { kind: 'app' }>;
}) {
  const { data: installed } = useInstalledApps();

  const app = useMemo((): NativeApp => {
    const id = `${address.packageName}/${address.activityName}`;
    return (
      installed?.find((candidate) => candidate.id === id) ?? {
        id,
        packageName: address.packageName,
        activityName: address.activityName,
        label: address.label ?? address.packageName,
      }
    );
  }, [address, installed]);

  return (
    <NativeAppIcon
      app={app}
      onRemove={onRemove}
      menuOpen={menuOpen}
      onMenuOpenChange={onMenuOpenChange}
    />
  );
}

/**
 * One tile on the wall, whatever is behind it.
 *
 * The wall hands this an address and a slot and nothing else. Which kind of
 * tile it is, and whatever that kind needs fetched, is worked out here — so
 * the wall itself has nothing to wait for and nothing to filter.
 */
export function WallTile({ uri, ...props }: WallTileProps) {
  const address = parseWallUri(uri);
  if (!address) return null;

  if (address.kind === 'nsite') return <NsiteTile address={address} {...props} />;
  return <NativeTile address={address} {...props} />;
}
