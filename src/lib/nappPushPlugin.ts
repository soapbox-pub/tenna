import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * The native half of `window.napp.push`.
 *
 * Subscriptions cross the bridge as JSON text, for the reason a signed
 * event's tags do: a filter's tag lists are arbitrarily shaped, and
 * Capacitor's object coercion does not keep them intact.
 */
export interface NappPushPlugin {
  /**
   * Replace a site's subscriptions. An empty list forgets the site.
   *
   * Resolves with the list as stored, after the native side has tidied it
   * the same way `normalizeNappSubscriptions` does.
   */
  set(options: {
    siteId: string;
    label: string;
    /** JSON text of a `NappSubscription[]`. */
    subscriptions: string;
  }): Promise<{ subscriptions: string }>;

  /** A site's subscriptions as stored, as JSON text; `"[]"` if none. */
  get(options: { siteId: string }): Promise<{ subscriptions: string }>;

  /**
   * Turn a site's notifications off, or back on.
   *
   * The user's answer, not the site's: it is kept apart from the
   * subscriptions a site replaces at will, and outlives them. Muting takes
   * down whatever the site has in the shade and drops the relays held open
   * for it; unmuting brings them back up against the subscriptions the site
   * had already set.
   */
  setMuted(options: { siteId: string; muted: boolean }): Promise<void>;

  /** Whether the user has turned a site's notifications off. */
  getMuted(options: { siteId: string }): Promise<{ muted: boolean }>;

  /**
   * Ask the OS for permission to post notifications.
   *
   * Resolves at once where none is needed or it was already given. `granted`
   * is whether notifications from Tenna can be shown at all afterwards.
   */
  requestPermission(): Promise<{ granted: boolean }>;

  status(): Promise<{
    /** Whether the OS will show notifications from Tenna. */
    granted: boolean;
    /** Whether the relay listener is up. */
    running: boolean;
    /** Whether sites can be served their workers here at all. */
    supported: boolean;
  }>;

  /**
   * Which of the given sites have a notification in the shade right now.
   *
   * Read from the system every time and never cached down there: the shade is
   * the only record of this that stays true, since tapping a notification
   * takes it away without anything of Tenna's running to hear about it.
   */
  unread(options: { siteIds: string[] }): Promise<{ siteIds: string[] }>;

  /**
   * A site's notifications appearing, changing, or going away.
   *
   * Carries the site it happened to, but the answer is always read back
   * whole — a swipe clears a row, a push may replace one, and the event is a
   * nudge rather than a diff.
   */
  addListener(
    eventName: 'nappNotificationsChanged',
    listener: (event: { siteId: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NappPush = registerPlugin<NappPushPlugin>('NappPush');

/**
 * Whether sites here can subscribe to events and be woken for them.
 *
 * Android only, in the app: it needs a foreground service to hold relays
 * open and a service worker to deliver to, and only the native nsite frame
 * can offer the second.
 */
export function supportsNappPush(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NappPush');
}
