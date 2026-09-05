import { Capacitor, registerPlugin } from '@capacitor/core';

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
