import { useQuery } from '@tanstack/react-query';

import { NativeApps, supportsNativeApps, type NativeApp } from '@/lib/nativeAppsPlugin';

/**
 * Every launchable app on the device, by name.
 *
 * The list only changes when something is installed or removed, so it is held
 * for the life of the screen rather than re-asked: enumerating a few hundred
 * packages and loading a label for each is a package-manager round trip per
 * app, and the picker that reads this is opened and closed in seconds.
 */
export function useInstalledApps() {
  return useQuery({
    queryKey: ['native-apps'],
    enabled: supportsNativeApps(),
    queryFn: async (): Promise<NativeApp[]> => {
      const { apps } = await NativeApps.list();
      return apps;
    },
    staleTime: 5 * 60_000,
  });
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
    queryFn: async (): Promise<string | null> => {
      if (!app) return null;
      const { icon } = await NativeApps.icon(app);
      return icon ? `data:image/png;base64,${icon}` : null;
    },
    // Artwork changes when the app updates, which is not while it is on screen.
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: false,
  });
}
