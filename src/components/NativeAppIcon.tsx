import { Info, Trash2 } from 'lucide-react';
import { useCallback, useRef } from 'react';

import { TileArtwork, TileButton, TileImage, TileStatic } from '@/components/Tile';
import { MENU, MENU_ITEM, MENU_ITEM_DESTRUCTIVE } from '@/components/tile-variants';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useNativeAppIcon } from '@/hooks/useNativeApps';
import { useToast } from '@/hooks/useToast';
import { impactMedium, notificationError } from '@/lib/haptics';
import { NativeApps, type NativeApp } from '@/lib/nativeAppsPlugin';

interface NativeAppIconProps {
  app: NativeApp;
  /** Take the app off the wall. Every native tile was put there by the user. */
  onRemove: () => void;
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
export function NativeAppIcon({ app, onRemove }: NativeAppIconProps) {
  const { toast } = useToast();
  // `isLoading` rather than `isPending`: a query that is disabled because this
  // platform has no such apps is pending forever, and static forever with it.
  const { data: iconUrl, isLoading } = useNativeAppIcon(app);

  // A long press is a press — see the same guard on `AppIcon`.
  const suppressTap = useRef(false);

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      suppressTap.current = true;
      impactMedium();
    } else {
      setTimeout(() => { suppressTap.current = false; }, 250);
    }
  }, []);

  const handleSelect = useCallback(() => {
    if (suppressTap.current) return;

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

  // The icon as the device draws it, and nothing else — see `TileImage`. Only
  // an app whose artwork could not be read at all falls back to a tile with
  // its initial on it, where there is nothing of the app's own left to show.
  const tile = (
    <TileButton name={app.label} onSelect={handleSelect}>
      {isLoading ? (
        <TileStatic />
      ) : iconUrl ? (
        <TileImage src={iconUrl} name={app.label} />
      ) : (
        <TileArtwork name={app.label} />
      )}
    </TileButton>
  );

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
      <ContextMenuContent className={MENU} collisionPadding={16}>
        <ContextMenuItem
          className={MENU_ITEM}
          onSelect={() => void NativeApps.settings({ packageName: app.packageName }).catch(() => {})}
        >
          <Info />
          App info
        </ContextMenuItem>
        <ContextMenuItem className={MENU_ITEM_DESTRUCTIVE} onSelect={onRemove} variant="destructive">
          <Trash2 />
          Remove from Tenna
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
