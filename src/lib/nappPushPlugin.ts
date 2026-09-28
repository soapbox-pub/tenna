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
   * Post a notification for a site, from its window.
   *
   * The same call the site's worker makes over its own reserved path, landing
   * in the same place — so a notification from an open page is grouped,
   * tagged, replaced and muted exactly as one from a push is. There is no
   * second kind.
   *
   * `payload` is `{title, options}` as the Notifications API defines it, as
   * JSON text.
   *
   * `label` and `event` are what to write the site down as if it has no record
   * yet, which decides the name and the mark on the row. A site reached
   * straight from a link may not have one: nothing writes a record until a
   * tile for the site has been drawn.
   *
   * `shown` is false when the OS will not show it or the user has muted the
   * site — the same two refusals the worker gets.
   */
  show(options: {
    siteId: string;
    label: string;
    /** The NIP-5A manifest event, as JSON text. */
    event: string;
    payload: string;
  }): Promise<{ shown: boolean }>;

  /**
   * A site's live notifications, for `registration.getNotifications()`.
   *
   * Its own only, and the same list its worker sees. Filtered by `tag` when
   * one is given, as the API defines.
   */
  list(options: { siteId: string; tag?: string }): Promise<{ notifications: string }>;

  /** Take one of a site's notifications down, by the key it was filed under. */
  close(options: { siteId: string; key: string }): Promise<void>;

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
   * Every listening site's subscriptions, merged into one list, as JSON text.
   *
   * What the push service is told. **iOS only**, where there is a push service
   * at all: a host running several sites behind one device token registers as
   * one client with one list, because the service pushes an event to a client
   * at most once — so an event two sites both want costs one push and one
   * wake-up rather than two. Muted sites are left out, which is what makes
   * muting stop the traffic rather than only hide it.
   *
   * See `src/hooks/useNostrPushSync.ts`, and `NsiteStore.merged` for the merge.
   */
  subscriptions(): Promise<{ subscriptions: string }>;

  /**
   * The APNs device token, and which host minted it.
   *
   * **iOS only.** Resolves without a `token` when the user has refused
   * notifications, or when registration failed — never by hanging, so the
   * caller can simply await it. `environment` is read off the provisioning
   * profile: a token is minted against one APNs host and rejected by the
   * other, and the push service is told which at registration.
   */
  deviceToken(): Promise<{ token?: string; environment: 'sandbox' | 'production' }>;

  /**
   * Remember which of a site's files is its service worker.
   *
   * **iOS only**, and the whole reason `navigator.serviceWorker` is shimmed
   * there: WebKit will not register a real worker for a document under a custom
   * scheme, so the path the site passed to `register()` is the only record of
   * which script the notification extension should run. The file is fetched
   * into the shared blob cache at the same time, because an extension woken by
   * a push should not have to reach the network to find out what to say.
   *
   * `type` is the `type` the site registered with, which decides whether the
   * extension starts the script as a classic worker or a module.
   */
  registerWorker(options: { siteId: string; label: string; path: string; type: 'classic' | 'module' }): Promise<void>;

  /**
   * `registration.periodicSync.register(tag, { minInterval })`, written down
   * where the scheduler can see it.
   *
   * The web layer has already asked the user. Registering a tag the site
   * already has replaces its interval. `minInterval` is in milliseconds and is
   * rounded up to the platform's floor — fifteen minutes on both, and on iOS
   * a request the system is free to honour much later than that.
   *
   * `label` and `event` write the site down if nothing has yet, for the reason
   * they do in {@link show}: the worker is served from the site's record.
   */
  periodicSyncRegister(options: {
    siteId: string;
    label: string;
    /** The NIP-5A manifest event, as JSON text. */
    event?: string;
    tag: string;
    minInterval: number;
  }): Promise<void>;

  /** Forget one of a site's periodic sync tags. Unknown tags are not an error. */
  periodicSyncUnregister(options: { siteId: string; tag: string }): Promise<void>;

  /** A site's periodic sync tags, for `getTags()`. */
  periodicSyncTags(options: { siteId: string }): Promise<{ tags: string[] }>;

  /** Forget every periodic sync tag a site has, which is how revoking it reaches the scheduler. */
  periodicSyncClear(options: { siteId: string }): Promise<void>;

  /**
   * Every site allowed to send notifications, replacing the last list.
   *
   * A mirror of the grants in `nsiteBrowserPermissions`, which live in the web
   * layer's `localStorage` and cannot be read by anything native. What reads
   * this is a worker woken with nobody to ask — by a periodic sync, most of
   * all, which unlike a push is not itself proof the site was allowed to
   * notify — before it is allowed to put anything in the shade.
   */
  setNotifyGrants(options: { siteIds: string[] }): Promise<void>;

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

  /**
   * The merged list would now be different: a site subscribed, cleared, or was
   * muted.
   *
   * **iOS only.** A nudge rather than a diff — the list is read back whole,
   * for the same reason `nappNotificationsChanged` is.
   */
  addListener(
    eventName: 'nappSubscriptionsChanged',
    listener: () => void,
  ): Promise<PluginListenerHandle>;

  /**
   * The user tapped one of a site's notifications.
   *
   * **iOS only**, where a tap reaches the app rather than the site's worker:
   * running one takes a notification service extension, and iOS starts one of
   * those only to mutate an arriving push. So `data.url` is what routes, and
   * `path` is it. Android opens the window natively and raises
   * `notificationclick` in the worker besides.
   *
   * Retained until something is listening, because a cold launch out of a tap
   * gets here before React exists.
   */
  addListener(
    eventName: 'nappNotificationOpen',
    listener: (event: { siteId: string; path?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const NappPush = registerPlugin<NappPushPlugin>('NappPush');

/**
 * Whether sites here can subscribe to events and be woken for them.
 *
 * The app, on both platforms, by quite different means. Android holds the
 * relays itself in a foreground service and wakes the site's real service
 * worker. iOS cannot hold a socket in the background at all, so the
 * subscriptions go to a push service — see `src/lib/nostrPush.ts` — which wakes
 * the phone through APNs and hands the event to a notification extension that
 * runs the site's worker there. Either way a site calls `napp.push.set` and is
 * told about events while it is closed, which is the whole of what it asked.
 *
 * Not on the web, where the iframe path has no host around the page to do
 * either.
 */
export function supportsNappPush(): boolean {
  const platform = Capacitor.getPlatform();
  return (platform === 'android' || platform === 'ios')
    && Capacitor.isPluginAvailable('NappPush');
}

/**
 * Whether a site's worker can be woken on a schedule here.
 *
 * The same platforms as push, by the same two roads: WorkManager waking the
 * real worker on Android, and a `BGAppRefreshTask` running the shimmed one on
 * iOS — the second at whatever pace the system chooses. Neither WebView has
 * Periodic Background Sync of its own; see `PERIODIC_SYNC_SOURCE`.
 */
export function supportsPeriodicSync(): boolean {
  return supportsNappPush();
}

/**
 * Whether a site's `navigator.serviceWorker` is Tenna's rather than the
 * engine's.
 *
 * iOS only. It decides two things that travel together: that the provider
 * script installs the stand-in container, and that `register()` has to be
 * recorded natively — see `registerWorker`. On Android the worker is real and
 * neither applies.
 */
export function supportsNappWorkerShim(): boolean {
  return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('NappPush');
}

/**
 * Whether Tenna registers with a push service for this device.
 *
 * iOS only, and the same condition as the worker shim for the same reason: the
 * two are one arrangement. Kept apart because they are read in different
 * places and mean different things.
 */
export function supportsNostrPush(): boolean {
  return Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('NappPush');
}
