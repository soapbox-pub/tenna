/**
 * Hook that provides a JSON-RPC handler for the calls a sandboxed nsite makes
 * on its host: NIP-07 signer calls, proxied to the user's signer;
 * `notification.*` calls, which put a notification in the shade from the
 * site's own window; and `napp.push.*`, which hands the site's relay
 * subscriptions to the native push service so it can be woken while closed.
 *
 * Each method is gated by the permission system. If no stored decision
 * exists, a prompt is shown to the user. Prompts are serialized (one at a
 * time) to prevent overwhelming the user.
 *
 * **Two stores answer, and the split is the point.** A signer call is a
 * question about the user's key, remembered per identity in
 * `nsitePermissions`, and refused outright when nobody is signed in. A
 * notification is a question about the device, remembered per site in
 * `nsiteBrowserPermissions` — as every browser has keyed it — and answerable
 * for a logged-out reader. The two notification roads, a page saying something
 * now and a relay subscription saying something later, are one grant, because
 * to the person being asked they are one thing.
 *
 * This is the path for a site with a window. The same site's **service
 * worker** asks for the same things over a reserved path answered in native
 * code — see `NsiteWorkerSigner.java` and `NsiteRequests.java` — because a
 * worker woken by a push has no window and no bridge to reach this hook with.
 * Both roads reach one store and one tray, so a grant made here is honoured
 * there and a notification posted here is the worker's to replace.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import { useCallback, useRef, useState } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import { normalizeNappSubscriptions } from '@/lib/nappSubscriptions';
import {
  getNsiteBrowserPermission,
  setNsiteBrowserPermission,
  type NsiteBrowserPermissionType,
} from '@/lib/nsiteBrowserPermissions';

import {
  getNsitePermission,
  setNsitePermission,
  type NsitePermissionType,
} from '@/lib/nsitePermissions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** NIP-42 client authentication. Signed on request, without asking. */
const NIP42_AUTH = 22242;

/** Describes a pending permission prompt waiting for the user's decision. */
export interface NsitePromptState {
  /**
   * What is being asked for.
   *
   * Two stores answer for these. A {@link NsitePermissionType} is a decision
   * about the user's keys and is remembered per identity; a
   * {@link NsiteBrowserPermissionType} is a decision about the device and is
   * remembered per site. They share a prompt because they are the same
   * question to the person reading it.
   */
  type: NsitePermissionType | NsiteBrowserPermissionType;
  /** For signEvent: the event kind. Null otherwise. */
  kind: number | null;
  /** For signEvent: the unsigned event template. */
  event?: Record<string, unknown>;
}

/** The user's response to a permission prompt. */
export interface NsitePromptDecision {
  /** Whether the operation is allowed. */
  allowed: boolean;
  /** Whether to remember this decision. */
  remember: boolean;
}

interface UseNsiteSignerRpcOptions {
  /** Canonical nsite subdomain identifier. */
  siteId: string;
  /** Human-readable site name for storage. */
  siteName: string;
  /**
   * The site's NIP-5A manifest event.
   *
   * Carried only so that a notification can write the site down if nothing
   * else has yet; see `NappPushPlugin.show`.
   */
  event?: NostrEvent;
}

interface UseNsiteSignerRpcResult {
  /** The `onRpc` callback to pass to `<Nsite>`. Transport-agnostic. */
  onRpc: (method: string, params: unknown) => Promise<unknown>;
  /**
   * The `onCapability` callback to pass to `<Nsite>`.
   *
   * Not an RPC call — `getUserMedia` and `navigator.geolocation` are asked of
   * the browser rather than of the host, and reach this from the native chrome
   * client rather than over the provider's channel. It lives here anyway,
   * because what it needs is this hook's prompt: one question on screen at a
   * time, whichever of the two kinds of question it is.
   */
  onCapability: (kinds: NsiteBrowserPermissionType[]) => Promise<boolean>;
  /** Current pending prompt, or null if no prompt is active. */
  pendingPrompt: NsitePromptState | null;
  /**
   * Which question that is — distinct for every one asked.
   *
   * The sheet is keyed on it so that a prompt answered and immediately
   * followed by the next one in the queue starts over rather than inheriting
   * the last answer's "Remember for this site".
   */
  pendingPromptId: number;
  /** Call this to resolve the current prompt. */
  resolvePrompt: (decision: NsitePromptDecision) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNsiteSignerRpc({
  siteId,
  siteName,
  event: manifest,
}: UseNsiteSignerRpcOptions): UseNsiteSignerRpcResult {
  const { user } = useCurrentUser();
  const [pendingPrompt, setPendingPrompt] = useState<NsitePromptState | null>(null);

  /**
   * The questions waiting to be asked, oldest first, the one on screen at the
   * head. Each carries the resolver for the caller parked on it, so the prompt
   * UI can answer it without a stale closure.
   *
   * A queue rather than a single slot, because two of these can genuinely be
   * outstanding at once. RPC calls arrive one at a time — the injected
   * provider script serialises them — but a capability request does not come
   * that way: `getUserMedia` and `navigator.geolocation` are asked of the
   * WebView, reach {@link onCapability} over the native event channel, and
   * nothing upstream orders them. A site that wants the microphone and where
   * the user is on the same page load raises both within a few milliseconds.
   *
   * Overwriting a single slot in that case dropped the first question on the
   * floor: its resolver was replaced before anyone answered it, so its promise
   * never settled, `respondCapability` was never called, and the native
   * `Decision` behind it — a `GeolocationPermissions.Callback` — was left
   * holding a `getCurrentPosition` that neither succeeded nor failed. Which is
   * the same silence the geolocation handler was added to end, arriving by a
   * different route.
   */
  const promptQueueRef = useRef<Array<{
    id: number;
    state: NsitePromptState;
    resolve: (decision: NsitePromptDecision) => void;
  }>>([]);

  const nextPromptId = useRef(1);
  const [pendingPromptId, setPendingPromptId] = useState(0);

  /**
   * Show a permission prompt and wait for the user's decision.
   *
   * One is on screen at a time; the rest wait their turn rather than being
   * discarded.
   */
  const showPrompt = useCallback(
    (state: NsitePromptState): Promise<NsitePromptDecision> => {
      return new Promise<NsitePromptDecision>((resolve) => {
        const id = nextPromptId.current++;
        promptQueueRef.current.push({ id, state, resolve });
        // Only the head is displayed. Anything behind it is shown when the one
        // in front has been answered.
        if (promptQueueRef.current.length === 1) {
          setPendingPrompt(state);
          setPendingPromptId(id);
        }
      });
    },
    [],
  );

  /** Resolve the prompt on screen and bring up whatever was behind it. */
  const resolvePrompt = useCallback(
    (decision: NsitePromptDecision) => {
      const answered = promptQueueRef.current.shift();
      answered?.resolve(decision);

      const next = promptQueueRef.current[0];
      setPendingPrompt(next?.state ?? null);
      setPendingPromptId(next?.id ?? 0);
    },
    [],
  );

  /**
   * Check permission and optionally prompt. Returns true if allowed.
   * Throws an error (with a user-facing message) if denied.
   */
  const checkPermission = useCallback(
    async (
      type: NsitePermissionType,
      kind: number | null,
      promptState: NsitePromptState,
    ): Promise<void> => {
      if (!user) throw new Error('Not logged in');

      const stored = await getNsitePermission(siteId, user.pubkey, type, kind);

      if (stored === 'allow') return;
      if (stored === 'deny') throw new Error('User rejected');

      // No stored decision — ask the user.
      const decision = await showPrompt(promptState);

      if (decision.remember) {
        await setNsitePermission(siteId, user.pubkey, siteName, type, kind, decision.allowed);
      }

      if (!decision.allowed) {
        throw new Error('User rejected');
      }
    },
    [siteId, siteName, user, showPrompt],
  );

  /**
   * Whether the site may reach something of the device's — the camera, the
   * microphone, where the user is.
   *
   * Deliberately not `checkPermission`. That one refuses outright when nobody
   * is signed in, which is right for every question it answers — they are all
   * questions about a key. This one is a question about the device, is stored
   * per site rather than per identity, and has an answer for a logged-out
   * reader too. See `nsiteBrowserPermissions`.
   *
   * All of what was asked for, or none of it. `getUserMedia({video, audio})`
   * fails whole if either is refused, so granting half of it would only
   * produce a failure the user had apparently agreed to. Nothing else asks for
   * more than one capability at a time.
   */
  const onCapability = useCallback(
    async (kinds: NsiteBrowserPermissionType[]): Promise<boolean> => {
      if (kinds.length === 0) return false;

      for (const kind of kinds) {
        const stored = getNsiteBrowserPermission(siteId, kind);
        if (stored === 'allow') continue;
        if (stored === 'deny') return false;

        const decision = await showPrompt({ type: kind, kind: null });

        if (decision.remember) {
          setNsiteBrowserPermission(siteId, siteName, kind, decision.allowed);
        }
        if (!decision.allowed) return false;
      }

      return true;
    },
    [siteId, siteName, showPrompt],
  );

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  /**
   * Both halves of being allowed to notify: the site's, and the device's.
   *
   * Asked in that order, because the second opens a prompt drawn by the OS
   * over the top of everything, and putting that in front of a site the user
   * has not agreed to hear from yet asks the wrong question first.
   *
   * Throws rather than returning false, so a caller can simply await it. The
   * message is what the site sees.
   */
  const askToNotify = useCallback(async (): Promise<void> => {
    if (!(await onCapability(['notifications']))) {
      throw new Error('User rejected');
    }

    const { granted } = await NappPush.requestPermission();
    if (!granted) throw new Error('Notifications are turned off for Tenna');
  }, [onCapability]);

  /**
   * Post a notification for the site's own window.
   *
   * Handed to the same native call the site's worker reaches over its
   * reserved path, so what appears is the site's one row, tagged and replaced
   * and muted by the same rules. See `NappPushPlugin.show`.
   */
  const showNotification = useCallback(
    async (payload: unknown): Promise<null> => {
      if (!supportsNappPush()) {
        throw new Error('Notifications are not available on this platform');
      }
      if (!manifest) {
        throw new Error('No site to show a notification for');
      }

      // The payload is the site's own object, already checked for size and
      // serialisability on the way out of the shim. Re-encoded here rather
      // than passed through, because what crosses the bridge is text.
      let text: string;
      try {
        text = JSON.stringify(payload ?? {});
      } catch {
        throw new Error('Notification options must be serializable');
      }

      await askToNotify();

      const { shown } = await NappPush.show({
        siteId,
        label: siteName,
        event: JSON.stringify(manifest),
        payload: text,
      });

      // The two refusals a worker gets too: notifications off for Tenna
      // between the grant and the post, or the site muted.
      if (!shown) throw new Error('Notification refused');
      return null;
    },
    [siteId, siteName, manifest, askToNotify],
  );

  /** The site's live notifications, as `registration.getNotifications()` wants them. */
  const listNotifications = useCallback(
    async (tag: unknown): Promise<unknown> => {
      if (!supportsNappPush()) return [];

      const { notifications } = await NappPush.list({
        siteId,
        ...(typeof tag === 'string' && tag ? { tag } : {}),
      });
      return JSON.parse(notifications) as unknown;
    },
    [siteId],
  );

  /** Take one of the site's notifications down. Asks nobody anything. */
  const closeNotification = useCallback(
    async (key: unknown): Promise<null> => {
      if (!supportsNappPush() || typeof key !== 'string' || !key) return null;
      await NappPush.close({ siteId, key });
      return null;
    },
    [siteId],
  );

  /**
   * What `Notification.permission` should read, asked again.
   *
   * The value a site sees at load is stamped into the provider script, which
   * is exact at the moment the page starts and cannot stay that way: a grant
   * revoked from the shield menu, or the site muted, or Tenna's notifications
   * turned off in system settings, all happen behind the site's back. So the
   * shim asks again whenever it has reason to.
   *
   * Three things have to agree for this to read `granted`, and any one of them
   * saying no is `denied` — which is the web's word for "do not ask, it will
   * not work", and true of all three.
   */
  const notifyPermission = useCallback(async (): Promise<
    'granted' | 'denied' | 'default'
  > => {
    if (!supportsNappPush()) return 'denied';

    const stored = getNsiteBrowserPermission(siteId, 'notifications');
    if (stored === 'deny') return 'denied';

    try {
      const [{ granted }, { muted }] = await Promise.all([
        NappPush.status(),
        NappPush.getMuted({ siteId }),
      ]);
      if (!granted || muted) return 'denied';
    } catch {
      // Nothing to ask, or nothing answered. The grant is all that is known,
      // and reporting it is better than reporting a refusal nobody made.
    }

    return stored === 'allow' ? 'granted' : 'default';
  }, [siteId]);

  /**
   * `Notification.requestPermission()` — which asks, rather than reporting.
   *
   * Never rejects. The web's version resolves with whatever the answer turned
   * out to be, including "no", and a site that catches nothing should not be
   * left with an unhandled rejection for having been told no.
   */
  const requestNotifyPermission = useCallback(async (): Promise<
    'granted' | 'denied' | 'default'
  > => {
    try {
      await askToNotify();
      return 'granted';
    } catch {
      return await notifyPermission();
    }
  }, [askToNotify, notifyPermission]);

  // ---------------------------------------------------------------------------
  // RPC handler
  // ---------------------------------------------------------------------------

  const onRpc = useCallback(
    async (
      method: string,
      params: unknown,
    ): Promise<unknown> => {
      const p = (params ?? {}) as Record<string, unknown>;

      // ------------------------------------------------------------------
      // Notifications, and the subscriptions behind them
      // ------------------------------------------------------------------
      //
      // Answered whether or not anybody is signed in, unlike everything
      // below. A notification is a thing that appears on a device: the
      // question it raises is about this phone and this site, it is stored
      // that way, and a site shows one from its own window with no account in
      // sight. Refusing for want of a login would be refusing to answer a
      // question nobody asked about a key.
      switch (method) {
        case 'notification.show':
          return await showNotification(p.payload);

        case 'notification.list':
          return await listNotifications(p.tag);

        case 'notification.close':
          return await closeNotification(p.key);

        case 'notification.permission':
          return await notifyPermission();

        case 'notification.request':
          return await requestNotifyPermission();

        case 'napp.push.get': {
          if (!supportsNappPush()) throw new Error('Push is not available on this platform');
          const { subscriptions } = await NappPush.get({ siteId });
          return JSON.parse(subscriptions) as unknown;
        }

        case 'napp.push.set': {
          if (!supportsNappPush()) throw new Error('Push is not available on this platform');

          // Refused before the user is asked: a prompt for a request that
          // would then fail on its shape is a prompt for nothing.
          const subscriptions = normalizeNappSubscriptions(p.subscriptions);

          // Clearing needs no one's permission.
          if (subscriptions.length > 0) {
            await askToNotify();
          }

          await NappPush.set({
            siteId,
            label: siteName,
            subscriptions: JSON.stringify(subscriptions),
          });
          return undefined;
        }
      }

      // Everything past here is a question about the user's key.
      if (!user) {
        throw new Error('Not logged in');
      }

      const signer = user.signer;

      switch (method) {
        // ------------------------------------------------------------------
        // getPublicKey — always allowed
        // ------------------------------------------------------------------
        case 'nostr.getPublicKey': {
          return user.pubkey;
        }

        // ------------------------------------------------------------------
        // signEvent — permission gated per kind
        // ------------------------------------------------------------------
        case 'nostr.signEvent': {
          const event = p.event as Record<string, unknown> | undefined;
          if (!event || typeof event.kind !== 'number') {
            throw new Error('Invalid event');
          }

          const kind = event.kind as number;

          // Relay auth is not asked about. A kind 22242 is ephemeral, carries
          // no content, and says one thing to one relay: that whoever holds
          // this key is on the other end of this connection, right now. It
          // buys the site nothing it could not already have — it is reading
          // that relay as the user either way — and it is what a site has to
          // sign to be shown the user's own protected events at all. Tenna
          // signs these unprompted for its own relays (see `NostrProvider`),
          // and there is no reason to hold a site to a stricter rule than the
          // app applies to itself. A prompt here is a question with one sane
          // answer, asked mid-connection, which teaches people to say yes.
          if (kind !== NIP42_AUTH) {
            await checkPermission('signEvent', kind, {
              type: 'signEvent',
              kind,
              event,
            });
          }

          // Build the event template the signer expects.
          const template = {
            kind: event.kind as number,
            content: (event.content as string) ?? '',
            tags: (event.tags as string[][]) ?? [],
            created_at: (event.created_at as number) ?? Math.floor(Date.now() / 1000),
          };

          const signed = await signer.signEvent(template);
          return signed;
        }

        // ------------------------------------------------------------------
        // NIP-04 encryption
        // ------------------------------------------------------------------
        case 'nostr.nip04.encrypt': {
          if (!signer.nip04) throw new Error('Signer does not support NIP-04');

          const pubkey = p.pubkey as string;
          const plaintext = p.plaintext as string;
          if (!pubkey || typeof plaintext !== 'string') {
            throw new Error('Invalid params');
          }

          await checkPermission('nip04.encrypt', null, {
            type: 'nip04.encrypt',
            kind: null,
          });

          return await signer.nip04.encrypt(pubkey, plaintext);
        }

        case 'nostr.nip04.decrypt': {
          if (!signer.nip04) throw new Error('Signer does not support NIP-04');

          const pubkey = p.pubkey as string;
          const ciphertext = p.ciphertext as string;
          if (!pubkey || typeof ciphertext !== 'string') {
            throw new Error('Invalid params');
          }

          await checkPermission('nip04.decrypt', null, {
            type: 'nip04.decrypt',
            kind: null,
          });

          return await signer.nip04.decrypt(pubkey, ciphertext);
        }

        // ------------------------------------------------------------------
        // NIP-44 encryption
        // ------------------------------------------------------------------
        case 'nostr.nip44.encrypt': {
          if (!signer.nip44) throw new Error('Signer does not support NIP-44');

          const pubkey = p.pubkey as string;
          const plaintext = p.plaintext as string;
          if (!pubkey || typeof plaintext !== 'string') {
            throw new Error('Invalid params');
          }

          await checkPermission('nip44.encrypt', null, {
            type: 'nip44.encrypt',
            kind: null,
          });

          return await signer.nip44.encrypt(pubkey, plaintext);
        }

        case 'nostr.nip44.decrypt': {
          if (!signer.nip44) throw new Error('Signer does not support NIP-44');

          const pubkey = p.pubkey as string;
          const ciphertext = p.ciphertext as string;
          if (!pubkey || typeof ciphertext !== 'string') {
            throw new Error('Invalid params');
          }

          await checkPermission('nip44.decrypt', null, {
            type: 'nip44.decrypt',
            kind: null,
          });

          return await signer.nip44.decrypt(pubkey, ciphertext);
        }

        default:
          throw new Error(`Method not found: ${method}`);
      }
    },
    [
      user,
      checkPermission,
      siteId,
      siteName,
      askToNotify,
      showNotification,
      listNotifications,
      closeNotification,
      notifyPermission,
      requestNotifyPermission,
    ],
  );

  return { onRpc, onCapability, pendingPrompt, pendingPromptId, resolvePrompt };
}
