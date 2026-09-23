import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { useNostr } from '@nostrify/react';
import { useEffect } from 'react';

import { NappPush, supportsNostrPush } from '@/lib/nappPushPlugin';
import type { NappSubscription } from '@/lib/nappSubscriptions';
import {
  forServiceSubscriptions,
  nostrPushClientPubkey,
  nostrPushCreate,
  nostrPushPing,
  nostrPushSet,
  NostrPushError,
} from '@/lib/nostrPush';
import { APP_ID, NOSTR_PUSH_RELAY } from '@/lib/tenna';

/**
 * Keeps the push service's idea of this device up to date.
 *
 * iOS only, and the other half of `napp.push` there. A site calls
 * `napp.push.set`, which on Android starts a foreground service and opens a
 * relay socket; here it writes the subscriptions down and this is what carries
 * them to somebody who can watch a relay — see `src/lib/nostrPush.ts`. Nothing
 * of the site's is involved and nothing it did is waiting on this: a `set` that
 * has been stored has been honoured as far as the site can tell, and the
 * registration catches up a moment later.
 *
 * ## One client, whatever a phone is running
 *
 * Every site's subscriptions go up as one list under one key, because the
 * service pushes an event to a client at most once. Two sites watching the same
 * author then cost one push and one wake-up; a client per site would cost one
 * of each per site, for the same event. Which site a push turns out to be for
 * is worked out on the device when it arrives, against the same filters. See
 * `NsiteStore.merged` and `NotificationService`.
 *
 * ## What it does and does not send
 *
 * Only what changed. The merged list is compared against the one the service
 * last accepted, and an unchanged list is not re-sent — a `ping` goes instead,
 * at most once a day, which is what keeps the client from being reaped after
 * thirty days of silence.
 *
 * Nothing at all happens until there is both a device token and something to
 * subscribe to, so an install where nobody ever turns notifications on never
 * appears at the service.
 */

/** What was last accepted, so an unchanged list is not sent again. */
interface Registration {
  /** The client pubkey it belongs to. A new key is a new client. */
  client: string;
  token: string;
  environment: string;
  /** The subscriptions as sent, JSON text. */
  subscriptions: string;
  /** When the service was last spoken to at all, in milliseconds. */
  pingedAt: number;
}

const STORAGE = `${APP_ID}:nostr-push:registration`;

/** How often to say the device is still here. The service reaps after thirty days. */
const PING_INTERVAL = 24 * 60 * 60 * 1000;

function read(): Registration | undefined {
  try {
    const stored = localStorage.getItem(STORAGE);
    return stored ? (JSON.parse(stored) as Registration) : undefined;
  } catch {
    return undefined;
  }
}

function write(registration: Registration): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(registration));
  } catch {
    // A device with no storage re-registers every launch, which is wasteful
    // and correct. `create` on an existing client replaces its connection and
    // keeps its subscriptions, so nothing is lost by saying it twice.
  }
}

export function NostrPushSync() {
  const { nostr } = useNostr();

  useEffect(() => {
    if (!supportsNostrPush()) return;

    let disposed = false;
    const listeners: PluginListenerHandle[] = [];

    // One run at a time. A resume and a site's `set` can land within a frame of
    // each other, and two registrations racing would each think the other's was
    // the stored one.
    let running = false;
    let again = false;

    const sync = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;

      try {
        const [{ token, environment }, { subscriptions: merged }] = await Promise.all([
          NappPush.deviceToken(),
          NappPush.subscriptions(),
        ]);

        const stored = read();

        // No token means the user has not allowed notifications, or
        // registration failed. Either way there is nowhere to push to.
        if (!token) return;

        const parsed = forServiceSubscriptions(JSON.parse(merged) as NappSubscription[]);
        const wanted = JSON.stringify(parsed);

        // Nobody has subscribed to anything and we have never registered. An
        // install that never turns a site's notifications on never appears at
        // the service at all.
        if (!stored && parsed.length === 0) return;

        const client = await nostrPushClientPubkey();
        const relay = nostr.relay(NOSTR_PUSH_RELAY);
        const { id: topic } = await App.getInfo();

        const register = async (): Promise<Registration> => {
          await nostrPushCreate(relay, {
            method: 'apn',
            token,
            topic,
            environment: environment === 'sandbox' ? 'sandbox' : 'production',
          });
          // `create` keeps whatever subscriptions the client had, but this
          // device no longer knows what those were, so nothing is claimed for
          // them and the `set` below always runs.
          const fresh: Registration = {
            client,
            token,
            environment,
            subscriptions: '',
            pingedAt: Date.now(),
          };
          write(fresh);
          return fresh;
        };

        let registration = stored;
        if (
          !registration
          || registration.client !== client
          || registration.token !== token
          || registration.environment !== environment
        ) {
          registration = await register();
        }

        /** Run something, and re-register once if the service has forgotten us. */
        const withClient = async (work: () => Promise<unknown>): Promise<void> => {
          try {
            await work();
          } catch (error) {
            if (!(error instanceof NostrPushError) || !error.unknownClient) throw error;
            // Reaped, or the service lost its database. Registering again is
            // the documented recovery and costs one round trip.
            registration = await register();
            await work();
          }
        };

        if (registration.subscriptions !== wanted) {
          await withClient(() => nostrPushSet(relay, parsed));
          write({ ...registration, subscriptions: wanted, pingedAt: Date.now() });
        } else if (Date.now() - registration.pingedAt > PING_INTERVAL) {
          await withClient(() => nostrPushPing(relay));
          write({ ...registration, pingedAt: Date.now() });
        }
      } catch (error) {
        // A relay that did not answer, a service that is down, a phone with no
        // network. Nothing here is urgent and nothing is lost: the next launch,
        // the next resume, or the next site to subscribe tries again.
        console.warn('[NostrPushSync] could not reach the push service:', error);
      } finally {
        running = false;
        if (again && !disposed) {
          again = false;
          void sync();
        }
      }
    };

    void sync();

    void (async () => {
      const handles = await Promise.all([
        // A site subscribed, cleared, or was muted.
        NappPush.addListener('nappSubscriptionsChanged', () => { void sync(); }),
        // Coming back is when a token is most likely to have been reissued,
        // and when a ping is due.
        App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) void sync();
        }),
      ]);

      if (disposed) {
        for (const handle of handles) void handle.remove();
        return;
      }
      listeners.push(...handles);
    })().catch(() => {
      // Nothing to listen to. The sync on mount already ran.
    });

    return () => {
      disposed = true;
      for (const listener of listeners) void listener.remove();
    };
  }, [nostr]);

  return null;
}
