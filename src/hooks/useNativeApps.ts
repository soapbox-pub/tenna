import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useToast } from '@/hooks/useToast';
import { notificationError } from '@/lib/haptics';
import { NativeApps, supportsNativeApps, type NativeApp } from '@/lib/nativeAppsPlugin';
import { appKey, recordLaunch } from '@/lib/recents';

/**
 * Every launchable app on the device, by name.
 *
 * The list only changes when something is installed or removed, so it is held
 * for the life of the screen rather than re-asked: enumerating a few hundred
 * packages and loading a label for each is a package-manager round trip per
 * app, and the picker that reads this is opened and closed in seconds.
 *
 * `enabled` is for the screens that may never ask. The wall's search bar can
 * offer the whole drawer, but most launches never open it, and a few hundred
 * package-manager round trips on the off chance is not a cold start worth
 * spending — so it asks when it is first looked in, not when it is drawn.
 */
export function useInstalledApps(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['native-apps'],
    enabled: supportsNativeApps() && (options?.enabled ?? true),
    queryFn: async (): Promise<NativeApp[]> => {
      const { apps } = await NativeApps.list();
      return apps;
    },
    staleTime: 5 * 60_000,
  });
}

/**
 * Hand an app on the device over to the OS, from wherever it was pressed.
 *
 * The tile on the wall and a row in the search bar are the same press with the
 * same two ways of going wrong, so they are one verb. An app that has been
 * uninstalled since it was listed is an answer rather than an error — it is
 * said out loud, because a press that appears to do nothing is worse than a
 * press that explains itself — and neither failure is written down as a
 * launch, since nothing was launched.
 */
export function useLaunchNativeApp() {
  const { toast } = useToast();

  return useCallback(
    (app: NativeApp) => {
      void NativeApps.launch(app)
        .then(({ launched }) => {
          if (launched) {
            recordLaunch(appKey(app));
            return;
          }
          // Uninstalled since it was added. A tile stays where it is, because
          // the wall is the user's list and nothing takes a thing off it but
          // them; this says so and points at the way off.
          notificationError();
          toast({
            title: `${app.label} isn't installed anymore`,
            description: 'Hold its tile to remove it from Tenna.',
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
    },
    [toast],
  );
}

/** An app's artwork, and what may be done to it. */
export interface NativeAppIconArt {
  /** Data URL for the PNG. */
  url: string;
  /**
   * Whether it is a full square with no shape cut out of it yet, and so may
   * be put behind the squircle every other tile on the wall is cut to.
   */
  adaptive: boolean;
}

/**
 * One app's icon, as a data URL.
 *
 * Per app rather than per list because that is how they are drawn: a picker
 * row and a tile on the wall each want one, the answer is the same for both,
 * and the cache under it means the second asker pays nothing. An app that has
 * been uninstalled resolves to null, and the tile falls back to its initial.
 */
export function useNativeAppIcon(app: { packageName: string; activityName: string } | undefined) {
  return useQuery({
    queryKey: ['native-app-icon', app?.packageName, app?.activityName],
    enabled: supportsNativeApps() && !!app,
    queryFn: async (): Promise<NativeAppIconArt | null> => {
      if (!app) return null;
      const { icon, adaptive } = await NativeApps.icon(app);
      return icon ? { url: `data:image/png;base64,${icon}`, adaptive } : null;
    },
    // Artwork changes when the app updates, which is not while it is on screen.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}
