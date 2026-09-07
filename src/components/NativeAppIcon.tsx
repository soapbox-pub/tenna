import { Info, Trash2 } from 'lucide-react';
import { useCallback } from 'react';

import { TileArtwork, TileButton, TileImage, TileMenuAnchor, TileStatic } from '@/components/Tile';
import { MENU, MENU_ITEM, MENU_ITEM_DESTRUCTIVE } from '@/components/tile-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useNativeAppIcon } from '@/hooks/useNativeApps';
import { useToast } from '@/hooks/useToast';
import { notificationError } from '@/lib/haptics';
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
 * The robot, drawn small enough to survive being a fifth of an inch across.
 *
 * The viewBox is the ink and nothing else — no margin of its own — so that
 * whatever centres it is centring the shape rather than the box around it.
 */
function AndroidMark({ className }: { className?: string }) {
  return (
    <svg viewBox="3.5 1.6 17 12.4" aria-hidden="true" className={className}>
      <path
        d="M7.4 2.4 9.3 6.1M16.6 2.4 14.7 6.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M3.5 14a8.5 8.5 0 0 1 17 0z" fill="currentColor" />
      <circle cx="8.7" cy="9.3" r="1.05" fill="#fff" />
      <circle cx="15.3" cy="9.3" r="1.05" fill="#fff" />
    </svg>
  );
}

/**
 * The mark in the corner of a device app's tile.
 *
 * Every other tile on the wall opens inside Tenna; these leave it. Android
 * says the same thing the same way about a shortcut a browser put on its home
 * screen — a small badge of whoever is really behind the icon, clipped to the
 * corner — and a person who has seen one of those knows what this one means
 * without being told.
 *
 * A white disc with a ring of the wallpaper around it, so it reads against a
 * dark icon and a bright one alike, and set a little proud of the tile so the
 * artwork keeps its own corner.
 */
function AndroidBadge() {
  return (
    <span
      aria-hidden="true"
      className="absolute -bottom-[3%] -right-[3%] flex size-[32%] items-center justify-center rounded-full bg-white ring-2 ring-[#150609]"
    >
      <AndroidMark className="h-auto w-[58%] text-[#3DDC84]" />
    </span>
  );
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
  const { toast } = useToast();
  // `isLoading` rather than `isPending`: a query that is disabled because this
  // platform has no such apps is pending forever, and static forever with it.
  const { data: icon, isLoading } = useNativeAppIcon(app);

  const handleSelect = useCallback(() => {
    void NativeApps.launch(app)
      .then(({ launched }) => {
        if (launched) return;
        // Uninstalled since the wall was drawn. The stored list is reconciled
        // against the device on the next look, so this only has to say so.
        notificationError();
        toast({
          title: `${app.label} isn't installed anymore`,
          description: 'Its tile will come off the wall.',
          variant: 'destructive',
        });
      })
      .catch(() => {
        notificationError();
        toast({
          title: `Could not open ${app.label}`,
          variant: 'destructive',
        });
      });
  }, [app, toast]);

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
        onSelect={handleSelect}
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
