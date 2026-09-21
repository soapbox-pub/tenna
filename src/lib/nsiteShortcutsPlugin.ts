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
  /** The site's `share_target`, as JSON text, as the wall last read it. */
  shareTarget?: string;
  /**
   * A site-absolute path to open the site at, instead of its front page.
   *
   * Set when the window was opened by a notification that named a place
   * inside the site — `data.napp.url`, or the `data.url` every push service
   * worker on Nostr already writes.
   */
  path?: string;
}

/** A site the user has that will take something from the share sheet. */
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
    /**
     * Base64 PNG of the site's monochrome mark, for its notifications.
     *
     * Stored rather than used at once: a notification arrives for a site with
     * no window open, long after the manifest this was picked out of was read.
     * Omit it and whatever is already stored is left alone.
     */
    badge?: string;
    /** Channel number the site sits on, for the tune-in. */
    channel?: number;
    /** The site's `share_target` as JSON text, or omitted to leave it as-is. */
    shareTarget?: string;
    /** A staged share to hand the site once its window is up. */
    shareToken?: string;
    /**
     * A site-absolute path to open the site at, instead of its front page.
     *
     * The same thing a notification's path does, asked by a link instead: an
     * `nsite://<site>/somewhere` names a place, and the window opens there
     * whether it is starting cold or already up. Omitted by every other
     * caller, which names a site and lets it decide where that begins.
     */
    path?: string;
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
    /** Base64 PNG of the site's monochrome mark, for its notifications. */
    badge?: string;
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
   * Redraw a site's icon in place, wherever it already appears.
   *
   * Pinning is how a shortcut's artwork is normally set, and a site already on
   * the home screen cannot be pinned again from the wall — the menu offers it
   * only once. So when the drawing changes, or when a site turns out to ship
   * better artwork than was known at the time, this is the way the icon
   * already on the home screen catches up.
   *
   * The site's notification mark comes along, since nothing else writes one:
   * a notification arrives for a site with no window open, long after the
   * manifest it was picked out of was read.
   */
  refreshIcon(options: {
    siteId: string;
    /** Base64 PNG for the adaptive icon, without a data URL prefix. */
    icon: string;
    /** Base64 PNG of the site's monochrome mark, for its notifications. */
    badge?: string;
    /** Kept on the shortcut, so refreshing does not take it out of the sheet. */
    shareCategories?: string[];
    /** Kept for the same reason: updating a shortcut replaces it wholesale. */
    rank?: number;
  }): Promise<{ updated: boolean }>;

  /** Leave a site's window, taking its task with it. */
  finish(): Promise<void>;

  /**
   * Mirror the wall down to the native side.
   *
   * Being on the wall is what keeps a site's record — its manifest, its icon,
   * its place in the share sheet — and the native side cannot see local
   * storage. It has to know: a site's window decides whether to throw its
   * record away while running with no wall in memory, and the share sheet is
   * read by the system when nothing of Tenna's is running at all.
   *
   * The whole set goes down on every change rather than one site at a time, so
   * that a removal lost to a crash is corrected on the next launch instead of
   * leaving a site on the wall here forever. Sites that came off the wall and
   * are neither pinned nor subscribed are forgotten as part of the same call.
   */
  setWall(options: { siteIds: string[] }): Promise<void>;

  // -- The OS share sheet ---------------------------------------------------

  /**
   * Bring a site on the wall up to date, and offer it to the share sheet or
   * withdraw it.
   *
   * The wall is the only place a site's web app manifest is read, so it is the
   * only place that can say what a site takes from the sheet, what it is
   * called, or what it looks like — long after the site was added, and whether
   * or not it has ever been opened. This is the call the wall makes about a
   * site it is not otherwise touching.
   *
   * Offering is separate from {@link NsiteShortcutsPlugin.pin} because pinning
   * is a request the system answers out of our sight, and because a site does
   * not have to be pinned to be shared to — being on the wall is enough.
   */
  syncSite(options: {
    siteId: string;
    /** False takes the site back out of the sheet, leaving any pinned icon. */
    enabled: boolean;
    label?: string;
    icon?: string;
    shareCategories?: string[];
    /**
     * The site's place on the wall, from the top.
     *
     * Android caps how many share targets an app may publish, and every site
     * the user has publishes one — so past the cap this decides which site is
     * dropped. The wall is a list they arranged; the bottom of it is the right
     * end to cut from.
     */
    rank?: number;
    /**
     * The manifest event as JSON text.
     *
     * Only ever used to write a record for a site that hasn't got one — a site
     * added to the wall and never opened. A newer manifest for a site that has
     * one goes through {@link NsiteShortcutsPlugin.refresh} instead.
     */
    event?: string;
    /**
     * The site's `share_target` as JSON text, or `''` if it has none.
     *
     * Omit only when the site's manifest hasn't been read; an empty string is
     * how a site that dropped the member loses its place in the sheet.
     */
    shareTarget?: string;
  }): Promise<void>;

  /** Every site the user has that declared a `share_target`. */
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

  /**
   * A notification was tapped for a site whose window was already up.
   *
   * The cold-start case is the `path` on
   * {@link NsiteShortcutsPlugin.getLaunchSite}; this is the same thing landing
   * in a window that never restarted, where the site would otherwise never
   * learn there was anywhere to go.
   */
  addListener(
    event: 'nsiteOpenPath',
    handler: (open: { path: string }) => void,
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
