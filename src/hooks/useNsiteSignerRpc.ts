/**
 * Hook that provides a JSON-RPC handler for the calls a sandboxed nsite makes
 * on its host: NIP-07 signer calls, proxied to the user's signer, and
 * `napp.push.*` calls, which hand the site's relay subscriptions to the native
 * push service.
 *
 * Each method is gated by the permission system. If no stored decision
 * exists, a prompt is shown to the user. Prompts are serialized (one at a
 * time) to prevent overwhelming the user.
 */
import { useCallback, useRef, useState } from 'react';

import { useCurrentUser } from '@/hooks/useCurrentUser';
import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import { normalizeNappSubscriptions } from '@/lib/nappSubscriptions';
import {
  getNsitePermission,
  setNsitePermission,
  type NsitePermissionType,
} from '@/lib/nsitePermissions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes a pending permission prompt waiting for the user's decision. */
export interface NsitePromptState {
  /** The permission type being requested. */
  type: NsitePermissionType;
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
}

interface UseNsiteSignerRpcResult {
  /** The `onRpc` callback to pass to `<Nsite>`. Transport-agnostic. */
  onRpc: (method: string, params: unknown) => Promise<unknown>;
  /** Current pending prompt, or null if no prompt is active. */
  pendingPrompt: NsitePromptState | null;
  /** Call this to resolve the current prompt. */
  resolvePrompt: (decision: NsitePromptDecision) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNsiteSignerRpc({
  siteId,
  siteName,
}: UseNsiteSignerRpcOptions): UseNsiteSignerRpcResult {
  const { user } = useCurrentUser();
  const [pendingPrompt, setPendingPrompt] = useState<NsitePromptState | null>(null);

  // Ref to the resolve/reject pair for the current prompt, so the prompt UI
  // can resolve it without a stale closure.
  const promptResolverRef = useRef<{
    resolve: (decision: NsitePromptDecision) => void;
    reject: (err: Error) => void;
  } | null>(null);

  /**
   * Show a permission prompt and wait for the user's decision.
   * Only one prompt is active at a time (enforced by the injected script's
   * serial queue — it only sends one RPC at a time).
   */
  const showPrompt = useCallback(
    (state: NsitePromptState): Promise<NsitePromptDecision> => {
      return new Promise<NsitePromptDecision>((resolve, reject) => {
        promptResolverRef.current = { resolve, reject };
        setPendingPrompt(state);
      });
    },
    [],
  );

  /** Resolve the current prompt with the user's decision. */
  const resolvePrompt = useCallback(
    (decision: NsitePromptDecision) => {
      if (promptResolverRef.current) {
        promptResolverRef.current.resolve(decision);
        promptResolverRef.current = null;
      }
      setPendingPrompt(null);
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

      const stored = getNsitePermission(siteId, user.pubkey, type, kind);

      if (stored === 'allow') return;
      if (stored === 'deny') throw new Error('User rejected');

      // No stored decision — ask the user.
      const decision = await showPrompt(promptState);

      if (decision.remember) {
        setNsitePermission(siteId, user.pubkey, siteName, type, kind, decision.allowed);
      }

      if (!decision.allowed) {
        throw new Error('User rejected');
      }
    },
    [siteId, siteName, user, showPrompt],
  );

  // ---------------------------------------------------------------------------
  // RPC handler
  // ---------------------------------------------------------------------------

  const onRpc = useCallback(
    async (
      method: string,
      params: unknown,
    ): Promise<unknown> => {
      if (!user) {
        throw new Error('Not logged in');
      }

      const signer = user.signer;
      const p = (params ?? {}) as Record<string, unknown>;

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

          await checkPermission('signEvent', kind, {
            type: 'signEvent',
            kind,
            event,
          });

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

        // ------------------------------------------------------------------
        // napp.push — relay subscriptions Tenna holds open for the site
        // ------------------------------------------------------------------
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
            await checkPermission('push', null, { type: 'push', kind: null });

            const { granted } = await NappPush.requestPermission();
            if (!granted) throw new Error('Notifications are turned off for Tenna');
          }

          await NappPush.set({
            siteId,
            label: siteName,
            subscriptions: JSON.stringify(subscriptions),
          });
          return undefined;
        }

        default:
          throw new Error(`Method not found: ${method}`);
      }
    },
    [user, checkPermission, siteId, siteName],
  );

  return { onRpc, pendingPrompt, resolvePrompt };
}
