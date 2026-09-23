import { NSecSigner, type NostrEvent, type NRelay } from '@nostrify/nostrify';
import { generateSecretKey, nip19 } from 'nostr-tools';

import type { NappSubscription } from '@/lib/nappSubscriptions';
import { secureStorage } from '@/lib/secureStorage';
import { APP_ID, NOSTR_PUSH_PUBKEY } from '@/lib/tenna';

/**
 * Talking to the push service.
 *
 * iOS cannot hold a relay socket open in the background — not for a minute, let
 * alone a day — so the thing that watches the relays on this device's behalf is
 * somewhere else. Tenna tells it how to reach the phone (an APNs token) and
 * what to watch for (the sites' own filters, merged), and it wakes the phone
 * when something matches. What arrives is handled by `NsiteNotify`.
 *
 * The service is addressed **by pubkey**: every request and response is a kind
 * 25742 event whose content is NIP-44 encrypted between the two, shaped like
 * NIP-46 on a kind of its own so signer traffic and push traffic never mix.
 * There is no HTTP endpoint to reach and no URL to configure.
 *
 * ## The key is the device's, and nobody's identity
 *
 * Requests are signed with an **ephemeral key generated once per install**,
 * never with the reader's own. The signing pubkey is the client record and the
 * only authorization there is, so it is a device identifier and is treated as
 * one: kept in the Keychain, never published, never shown, and never derived
 * from an account. The service therefore learns what this phone wants to be
 * told about and cannot learn whose phone it is — which matters, because what
 * it is being told is a list of the user's interests.
 */

/** Ephemeral, NIP-46 shaped, on a kind of its own. */
export const NOSTR_PUSH_KIND = 25742;

/** How long a request waits for its answer before giving up. */
const TIMEOUT = 15_000;

/** Where the device's own key lives. Keychain on iOS; see `secureStorage`. */
const KEY_STORAGE = `${APP_ID}:nostr-push:key`;

/** How a client is reached. One per client, replaced by calling `create` again. */
export type NostrPushConnection =
  | { method: 'apn'; token: string; topic: string; environment: 'sandbox' | 'production' }
  | { method: 'fcm'; token: string }
  | {
      method: 'web';
      endpoint: string;
      p256dh: string;
      auth: string;
      vapid_private_key: string;
    };

export type NostrPushMethod = 'create' | 'delete' | 'set' | 'get' | 'ping';

/** What the service answered, when it answered with an error. */
export class NostrPushError extends Error {
  /** Whether the service has forgotten this client and wants `create` again. */
  get unknownClient(): boolean {
    return /unknown client/i.test(this.message);
  }
}

// ---------------------------------------------------------------------------
// The device's key
// ---------------------------------------------------------------------------

let cached: Uint8Array | undefined;

/**
 * This install's key, made the first time it is wanted.
 *
 * A new key means a new client, and a client the service still holds under the
 * old one will expire on its own after thirty days — so losing this is
 * survivable and not worth any recovery machinery. What it must not do is
 * change on every launch, which is why it is stored rather than derived.
 */
async function deviceKey(): Promise<Uint8Array> {
  if (cached) return cached;

  const stored = await secureStorage.getItem(KEY_STORAGE);
  if (stored) {
    try {
      const decoded = nip19.decode(stored);
      if (decoded.type === 'nsec') {
        cached = decoded.data;
        return cached;
      }
    } catch {
      // Not a key any more. Making a new one is better than never pushing.
    }
  }

  const secret = generateSecretKey();
  await secureStorage.setItem(KEY_STORAGE, nip19.nsecEncode(secret));
  cached = secret;
  return secret;
}

/** This install's client pubkey, which is its whole identity to the service. */
export async function nostrPushClientPubkey(): Promise<string> {
  return new NSecSigner(await deviceKey()).getPublicKey();
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/**
 * Ask the service something and wait for its answer.
 *
 * Kind 25742 is ephemeral, so relays pass it on without storing it and there is
 * nothing to come back for: **the response subscription has to be open before
 * the request is published.** That is the whole reason for the shape below —
 * the iterator is started, given a turn to send its `REQ`, and only then is the
 * request signed and sent.
 */
export async function nostrPushRequest(
  relay: NRelay,
  method: NostrPushMethod,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const signer = new NSecSigner(await deviceKey());
  const pubkey = await signer.getPublicKey();
  const id = crypto.randomUUID().slice(0, 8);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const responses = relay.req(
      [{ kinds: [NOSTR_PUSH_KIND], authors: [NOSTR_PUSH_PUBKEY], '#p': [pubkey] }],
      { signal: controller.signal },
    );

    const answer = (async (): Promise<Record<string, unknown>> => {
      for await (const message of responses) {
        if (message[0] !== 'EVENT') continue;
        const event = message[2] as NostrEvent;

        let decoded: unknown;
        try {
          decoded = JSON.parse(await signer.nip44.decrypt(NOSTR_PUSH_PUBKEY, event.content));
        } catch {
          // Somebody else's, or not for us. The `authors` filter already says
          // it came from the service, so this is a bad decrypt and nothing more.
          continue;
        }

        const response = decoded as { id?: string; result?: unknown; error?: unknown };
        if (response.id !== id) continue;
        if (typeof response.error === 'string') throw new NostrPushError(response.error);
        return (response.result ?? {}) as Record<string, unknown>;
      }
      throw new Error('The push service did not answer');
    })();

    // A turn for the generator to reach its first `await` and send the `REQ`.
    // Without it the request can be published into a subscription that is not
    // yet open, and the answer — being ephemeral — is simply gone.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = { id, method, ...(params ? { params } : {}) };
    const event = await signer.signEvent({
      kind: NOSTR_PUSH_KIND,
      content: await signer.nip44.encrypt(NOSTR_PUSH_PUBKEY, JSON.stringify(request)),
      tags: [['p', NOSTR_PUSH_PUBKEY]],
      created_at: Math.floor(Date.now() / 1000),
    });
    await relay.event(event, { signal: controller.signal });

    return await answer;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ---------------------------------------------------------------------------
// The five methods
// ---------------------------------------------------------------------------

/** Register, or replace, how this device is reached. Keeps its subscriptions. */
export function nostrPushCreate(relay: NRelay, connection: NostrPushConnection) {
  return nostrPushRequest(relay, 'create', connection as unknown as Record<string, unknown>);
}

/** Replace this device's subscriptions. An empty list clears them. */
export function nostrPushSet(relay: NRelay, subscriptions: NappSubscription[]) {
  return nostrPushRequest(relay, 'set', { subscriptions });
}

/** Say the device is still here, so its client is not reaped after thirty days. */
export function nostrPushPing(relay: NRelay) {
  return nostrPushRequest(relay, 'ping');
}

/** Forget this device entirely, subscriptions and all. */
export function nostrPushDelete(relay: NRelay) {
  return nostrPushRequest(relay, 'delete');
}

// ---------------------------------------------------------------------------
// What the service will take
// ---------------------------------------------------------------------------

/**
 * Drop what the service refuses, quietly.
 *
 * Tenna lets a site write `search` in a filter, because Android's relays index
 * it and a site asking for one is asking for something real there. The push
 * service has no index for it and refuses the whole `set` — so a single site
 * using `search` would otherwise silence every site on the phone.
 *
 * A filter that cannot be registered is a filter that will never fire, which is
 * exactly what it would have done had it been sent and rejected; the difference
 * is that everybody else's still works. A subscription left with no filters at
 * all is dropped with them.
 */
export function forServiceSubscriptions(subscriptions: NappSubscription[]): NappSubscription[] {
  return subscriptions
    .map((subscription) => ({
      ...subscription,
      filters: subscription.filters.filter((filter) => !('search' in filter)),
    }))
    .filter((subscription) => subscription.filters.length > 0);
}
