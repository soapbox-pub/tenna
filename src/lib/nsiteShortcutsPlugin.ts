import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import type { NsiteSharePayload } from '@/lib/nsiteShareTarget';

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
  /**
   * A share waiting to be handed to the site, staged under this token.
   *
   * Set when the window was opened from the OS share sheet. The payload's
   * bytes stay on disk; only the token crosses, because an intent is a binder
   * transaction and a shared video is not going to fit in one.
   */
  shareToken?: string;
  /** The site's `share_target`, as JSON text, as it stood when it was pinned. */
  shareTarget?: string;
}

/** A pinned site that will take something from the share sheet. */
export interface NsiteShareSite {
  siteId: string;
  label: string;
  /** The manifest event as JSON text. */
  event: string;
  /** The site's `share_target`, as JSON text. */
  shareTarget: string;
  /** Base64 PNG of the tile, without a data URL prefix. */
  icon?: string;
}

/** A share that arrived without a site attached, for the user to place. */
export interface NsitePendingShare {
  token?: string;
  /** Metadata only — the files' bytes are served to the site, not to Tenna. */
  payload?: NsiteSharePayload;
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
    /** The site's `share_target` as JSON text, or omitted to leave it as-is. */
    shareTarget?: string;
    /** A staged share to hand the site once its window is up. */
    shareToken?: string;
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
    /** The site's `share_target` as JSON text, if it declared one. */
    shareTarget?: string;
    /**
     * The share sheet buckets the site belongs in. Empty means it is a
     * launcher shortcut and nothing more.
     */
    shareCategories?: string[];
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

  /**
   * Redraw a pinned site's icon in place.
   *
   * Pinning is how a shortcut's artwork is normally set, and a site already on
   * the home screen cannot be pinned again from the wall — the menu offers it
   * only once. So when the drawing changes, or when a site turns out to ship
   * better artwork than was known at the time, this is the way the icon
   * already on the home screen catches up.
   */
  refreshIcon(options: {
    siteId: string;
    /** Base64 PNG for the adaptive icon, without a data URL prefix. */
    icon: string;
    /** Kept on the shortcut, so refreshing does not take it out of the sheet. */
    shareCategories?: string[];
  }): Promise<{ updated: boolean }>;

  /** Leave a site's window, taking its task with it. */
  finish(): Promise<void>;

  // -- The OS share sheet ---------------------------------------------------

  /**
   * Offer this site to the share sheet, or withdraw it.
   *
   * Separate from {@link NsiteShortcutsPlugin.pin} because pinning is a
   * request the system answers out of our sight: the shortcut only becomes a
   * share target once it is known to be on the home screen.
   *
   * Also where the site's `share_target` is written to its record. The wall is
   * the only place a web app manifest is read, and it reads one long after the
   * site was pinned — so this is the moment a site pinned before Tenna knew
   * about share targets gains one.
   */
  setShareTarget(options: {
    siteId: string;
    /** False takes the site back out of the sheet, leaving any pinned icon. */
    enabled: boolean;
    label?: string;
    icon?: string;
    shareCategories?: string[];
    /**
     * The site's `share_target` as JSON text, or `''` if it has none.
     *
     * Omit only when the site's manifest hasn't been read; an empty string is
     * how a site that dropped the member loses its place in the sheet.
     */
    shareTarget?: string;
  }): Promise<void>;

  /** Every pinned site that declared a `share_target`. */
  listShareTargets(): Promise<{ sites: NsiteShareSite[] }>;

  /** A share the user sent to Tenna itself, with no site chosen yet. */
  getPendingShare(): Promise<NsitePendingShare>;

  /** What was staged under a token: text fields, and each file's metadata. */
  getSharePayload(options: { token: string }): Promise<NsiteSharePayload>;

  /** Throw away a staged share once it has been handed over or refused. */
  releaseShare(options: { token: string }): Promise<void>;

  /**
   * A share arrived while Tenna was already up.
   *
   * The cold-start case is {@link NsiteShortcutsPlugin.getPendingShare}; this
   * is the same thing landing in an activity that never restarted.
   */
  addListener(
    event: 'nsiteShare',
    handler: (share: NsitePendingShare) => void,
  ): Promise<PluginListenerHandle>;
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
