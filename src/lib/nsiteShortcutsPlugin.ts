import { Capacitor, registerPlugin } from '@capacitor/core';

/** What this window was opened for, if it is a site's rather than Tenna's. */
export interface NsiteLaunchSite {
  /** The nsite subdomain this window is for, or undefined for Tenna itself. */
  siteId?: string;
  /** The manifest event as JSON text — see the note on the native side. */
  event?: string;
  /** The name the site was opened under. */
  label?: string;
  /** The channel it sits on, for the tune-in. Absent when opened from the launcher. */
  channel?: number;
  /** Whether the channel wall is what's behind this window. */
  fromWall?: boolean;
}

export interface NsiteShortcutsPlugin {
  /** Whether this launcher will take a pinned shortcut at all. */
  isSupported(): Promise<{ supported: boolean }>;

  /**
   * Open a site in a window of its own, or bring the one it has forward.
   *
   * The same window a pinned shortcut opens: keyed on the site id, so a site
   * opened from the wall and then pressed on the home screen is resumed rather
   * than started a second time.
   */
  open(options: {
    siteId: string;
    label: string;
    /** The manifest event as JSON text, for the window to serve from. */
    event: string;
    /** Base64 PNG for the recents card, without a data URL prefix. */
    icon?: string;
    /** Channel number the site sits on, for the tune-in. */
    channel?: number;
  }): Promise<void>;

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

  /** The site this window was opened for, with its cached manifest. */
  getLaunchSite(): Promise<NsiteLaunchSite>;

  /** Store a newer manifest for a site, if it still has a record. */
  refresh(options: {
    siteId: string;
    label: string;
    event: string;
  }): Promise<{ updated: boolean }>;

  /** Leave a site's window, taking its task with it. */
  finish(): Promise<void>;
}

export const NsiteShortcuts = registerPlugin<NsiteShortcutsPlugin>('NsiteShortcuts');

/**
 * Whether this platform can give an nsite a window of its own.
 *
 * Android only, and only in the app: a task per site, with its own card in the
 * recents switcher and its own icon on the home screen if the user wants one.
 * The web has its own, entirely different install story, and iOS grants no
 * equivalent to a third-party app at all — on both, a site is opened inside
 * Tenna instead.
 *
 * Whether the *launcher* will accept a pinned shortcut is a further question,
 * asked of {@link NsiteShortcutsPlugin.isSupported}.
 */
export function supportsNsiteWindows(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NsiteShortcuts');
}
