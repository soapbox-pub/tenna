import { Capacitor, registerPlugin } from '@capacitor/core';

/** What a pinned launch of the app was for, if it was one. */
export interface NsiteLaunchSite {
  /** The nsite subdomain the shortcut names, or undefined for a normal launch. */
  siteId?: string;
  /** The manifest event as JSON text — see the note on the native side. */
  event?: string;
  /** The name the shortcut was pinned under. */
  label?: string;
}

export interface NsiteShortcutsPlugin {
  /** Whether this launcher will take a pinned shortcut at all. */
  isSupported(): Promise<{ supported: boolean }>;

  /**
   * Ask the launcher to put a site on the home screen.
   *
   * Resolving means the request was made. Android puts up its own
   * confirmation, so whether a shortcut appears is the user's answer to that,
   * not something reported back here.
   */
  pin(options: {
    siteId: string;
    label: string;
    /** The manifest event as JSON text. */
    event: string;
    /** Base64 PNG for the adaptive icon, without a data URL prefix. */
    icon?: string;
  }): Promise<{ requested: boolean }>;

  isPinned(options: { siteId: string }): Promise<{ pinned: boolean }>;

  /** The site this activity was launched for, with its cached manifest. */
  getLaunchSite(): Promise<NsiteLaunchSite>;

  /** Store a newer manifest for a site, if it is pinned. */
  refresh(options: {
    siteId: string;
    label: string;
    event: string;
  }): Promise<{ updated: boolean }>;

  /** Leave a pinned site, taking its task with it. */
  finish(): Promise<void>;
}

export const NsiteShortcuts = registerPlugin<NsiteShortcutsPlugin>('NsiteShortcuts');

/**
 * Whether this platform has a home screen to put an nsite on.
 *
 * Android only, and only in the app — the web has its own, entirely different
 * install story, and iOS grants no equivalent to a third-party app at all.
 * Whether the *launcher* will accept a shortcut is a further question, asked
 * of {@link NsiteShortcutsPlugin.isSupported}.
 */
export function supportsNsiteShortcuts(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NsiteShortcuts');
}
