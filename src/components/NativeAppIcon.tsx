import { Info, Trash2 } from 'lucide-react';

import { AndroidBadge } from '@/components/AndroidBadge';
import { TileArtwork, TileButton, TileImage, TileMenuAnchor, TileStatic } from '@/components/Tile';
import { MENU, MENU_ITEM, MENU_ITEM_DESTRUCTIVE } from '@/components/tile-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useLaunchNativeApp, useNativeAppIcon } from '@/hooks/useNativeApps';
import { NativeApps, type NativeApp } from '@/lib/nativeAppsPlugin';

interface NativeAppIconProps {
  app: NativeApp;
  /** Take the app off the wall. Every native tile was put there by the user. */
  onRemove: () => void;
  /** Whether the tile's menu is up — the wall's business. See `AppIcon`. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
}

/**
 * One of the device's own apps on the wall.
 *
 * The same tile as an nsite's, and deliberately so: a person's phone does not
 * sort its home screen by what technology is behind each icon, and neither
 * should this one. What differs is underneath — the icon comes from the
 * package manager rather than from Blossom, pressing it hands off to the OS,
 * and "App info" means the system's settings page, since there is nothing
 * Tenna could say about an app it did not open.
 */
export function NativeAppIcon({
  app,
  onRemove,
  menuOpen,
  onMenuOpenChange,
}: NativeAppIconProps) {
  // `isLoading` rather than `isPending`: a query that is disabled because this
  // platform has no such apps is pending forever, and static forever with it.
  const { data: icon, isLoading } = useNativeAppIcon(app);
  const launch = useLaunchNativeApp();

  // An adaptive icon is a square with no shape cut out of it yet, so it takes
  // the same squircle an nsite's artwork does and the wall comes out of one
  // mould. A legacy icon has an outline of its own already — Tenna's shape
  // would only clip corners that were transparent anyway — so it is drawn as
  // it arrived, and an app whose artwork could not be read at all falls back
  // to a tile with its initial on it.
  return (
    <>
      <TileButton
        name={app.label}
        onSelect={() => launch(app)}
        onContextMenu={(clicked) => {
          clicked.preventDefault();
          onMenuOpenChange(true);
        }}
      >
        {isLoading ? (
          <TileStatic />
        ) : !icon ? (
          <TileArtwork name={app.label} />
        ) : icon.adaptive ? (
          <TileArtwork name={app.label} iconUrl={icon.url} fit="cover" />
        ) : (
          <TileImage src={icon.url} name={app.label} />
        )}

        <AndroidBadge />
      </TileButton>

      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange} modal={false}>
        <TileMenuAnchor />
        <DropdownMenuContent className={MENU} align="center" collisionPadding={16}>
          <DropdownMenuItem
            className={MENU_ITEM}
            onSelect={() => void NativeApps.settings({ packageName: app.packageName }).catch(() => {})}
          >
            <Info />
            App info
          </DropdownMenuItem>
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
    </>
  );
}
