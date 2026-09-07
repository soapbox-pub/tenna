import { useCallback, useMemo } from 'react';

import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useInstalledApps } from '@/hooks/useNativeApps';
import type { NativeApp } from '@/lib/nativeAppsPlugin';
import { APP_ID } from '@/lib/tenna';

const STORAGE_KEY = `${APP_ID}:added-native-apps`;

/** A device app the user put on the wall. */
export interface AddedNativeApp {
  packageName: string;
  activityName: string;
  /**
   * The name it went by when it was added.
   *
   * Kept so a tile has something to say under it before the device has been
   * asked for the current lineup — and after, the live label wins, because an
   * app that was renamed by an update should be renamed here too.
   */
  label: string;
}

/** Only the shape survives a round trip through localStorage; check it. */
function tidy(value: unknown): AddedNativeApp[] {
  if (!Array.isArray(value)) return [];

  const apps: AddedNativeApp[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { packageName, activityName, label } = entry as Partial<AddedNativeApp>;
    if (typeof packageName !== 'string' || !packageName) continue;
    if (typeof activityName !== 'string' || !activityName) continue;
    apps.push({ packageName, activityName, label: typeof label === 'string' ? label : packageName });
  }

  return apps;
}

/** Stable across renders, so the storage listener isn't rebound on each one. */
const SERIALIZER = {
  serialize: JSON.stringify,
  deserialize: (value: string): AddedNativeApp[] => tidy(JSON.parse(value)),
};

/** `packageName/activityName` — a native app's identity on the wall. */
export function nativeAppId(app: { packageName: string; activityName: string }): string {
  return `${app.packageName}/${app.activityName}`;
}

/**
 * The device's own apps that the user put on the wall.
 *
 * What is stored is the address of an app, not the app — the same bargain the
 * nsites make. A package name and an activity outlive updates that rename the
 * app or redraw its icon, and both are read back off the device every time the
 * wall is drawn, so a tile is never showing last month's version of something
 * sitting a tap away.
 *
 * The reconciliation only runs once the device has actually answered. A list
 * that hasn't arrived is not a device with no apps on it, and treating it as
 * one would empty the wall on every cold start.
 */
export function useAddedNativeApps() {
  const [stored, setStored] = useLocalStorage<AddedNativeApp[]>(STORAGE_KEY, [], SERIALIZER);
  const installed = useInstalledApps();

  const apps = useMemo((): NativeApp[] => {
    const live = installed.data;

    // Still asking. Show what was stored rather than an empty wall; a tile
    // whose app turns out to be gone is corrected a moment later.
    if (!live) {
      return stored.map((app) => ({ ...app, id: nativeAppId(app) }));
    }

    const byId = new Map(live.map((app) => [app.id, app]));

    return stored
      .map((app) => byId.get(nativeAppId(app)))
      .filter((app) => app !== undefined);
  }, [stored, installed.data]);

  const add = useCallback(
    (app: AddedNativeApp) => {
      setStored((prev) =>
        prev.some((a) => nativeAppId(a) === nativeAppId(app))
          ? prev
          : [...prev, { packageName: app.packageName, activityName: app.activityName, label: app.label }],
      );
    },
    [setStored],
  );

  const remove = useCallback(
    (id: string) => {
      setStored((prev) => prev.filter((app) => nativeAppId(app) !== id));
    },
    [setStored],
  );

  return {
    /** The apps on file, in the order they were added. */
    stored,
    /** Those of them still installed, with their current names. */
    apps,
    isLoading: installed.isLoading,
    add,
    remove,
  };
}
