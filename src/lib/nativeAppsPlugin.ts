import { Capacitor, registerPlugin } from '@capacitor/core';

/** One launchable app already on the device. */
export interface NativeApp {
  /** `packageName/activityName` — a native app's identity on the wall. */
  id: string;
  packageName: string;
  /** The activity that launches it; a package may publish more than one. */
  activityName: string;
  label: string;
}

export interface NativeAppsPlugin {
  /** Whether this platform can enumerate and launch installed apps at all. */
  isSupported(): Promise<{ supported: boolean }>;

  /**
   * Every launchable app on the device, by name, without artwork.
   *
   * Icons are asked for separately — see {@link NativeAppsPlugin.icon}. The
   * list is what a picker needs to draw its rows; the artwork fills in behind
   * it rather than holding up the first paint of a couple of hundred names.
   */
  list(): Promise<{ apps: NativeApp[] }>;

  /**
   * One app's icon, as a base64 PNG without a data URL prefix.
   *
   * Null if the app has been uninstalled since the list was taken.
   */
  icon(options: { packageName: string; activityName?: string }): Promise<{ icon: string | null }>;

  /**
   * Open an app.
   *
   * `launched: false` means it is no longer on the device — an ordinary
   * answer, not an error, for a tile that has outlived what it points at.
   */
  launch(options: { packageName: string; activityName?: string }): Promise<{ launched: boolean }>;

  /** Open the system's own settings page for an app. */
  settings(options: { packageName: string }): Promise<{ opened: boolean }>;
}

export const NativeApps = registerPlugin<NativeAppsPlugin>('NativeApps');

/**
 * Whether the device's own apps can go on the wall.
 *
 * Android only, in the app. Everywhere else there is nothing to enumerate: iOS
 * grants no third-party app a list of what is installed, and a browser is not
 * told what is on the machine it runs on — so on those the wall is nsites and
 * the add dialog says nothing about anything else.
 */
export function supportsNativeApps(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NativeApps');
}
