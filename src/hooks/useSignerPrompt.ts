import { useCallback, useEffect, useState } from 'react';

import {
  SignerPrompt,
  supportsSignerPrompt,
  type SignerRequest,
} from '@/lib/signerPromptPlugin';

/** A request with everything the sheet needs, or null for "nothing to ask". */
function normalize(answer: Partial<SignerRequest>): SignerRequest | null {
  if (!answer.id || !answer.method) return null;
  return {
    id: answer.id,
    method: answer.method,
    permission: answer.permission ?? null,
    appName: answer.appName ?? '',
    appKind: answer.appKind ?? 'package',
    requesterId: answer.requesterId ?? null,
    icon: answer.icon ?? null,
    account: answer.account ?? null,
    accountName: answer.accountName,
    peer: answer.peer ?? null,
    kind: answer.kind,
    event: answer.event,
    canRemember: !!answer.canRemember,
    signedIn: !!answer.signedIn,
    signedInElsewhere: !!answer.signedInElsewhere,
  };
}

/**
 * Asked once per window, and shared.
 *
 * The same arrangement as `useNsiteLaunch`, for the same reason: the answer
 * decides what this launch of the app *is* — a signing sheet over somebody
 * else's app, or Tenna — and that never changes afterwards. Holding the promise
 * at module scope means the question survives a remount and is never asked
 * twice, and module scope is per window since every task boots the web layer
 * into a WebView of its own.
 */
let firstAsk: Promise<SignerRequest | null> | null = null;

function ask(): Promise<SignerRequest | null> {
  if (!supportsSignerPrompt()) return Promise.resolve(null);
  return SignerPrompt.getPending().then(normalize).catch(() => null);
}

// Asked the moment this module loads rather than on first render. The plugin is
// only registered in the window that has a question in it, so off that window
// this costs nothing and resolves immediately.
if (supportsSignerPrompt()) firstAsk = ask();

export interface SignerPromptState {
  /** Gates the first paint: nothing must flash up over the app that asked. */
  pending: boolean;
  request: SignerRequest | null;
  /** Answer the request in front of the user, and take the next one. */
  resolve: (allowed: boolean, remember: boolean) => void;
}

/**
 * What this launch of the app is for, when the answer is "a signing request".
 *
 * `pending` is one bridge call, and on any window without the plugin it
 * resolves synchronously to nothing.
 */
export function useSignerPrompt(): SignerPromptState {
  const [state, setState] = useState<{ pending: boolean; request: SignerRequest | null }>(() =>
    supportsSignerPrompt() ? { pending: true, request: null } : { pending: false, request: null },
  );

  useEffect(() => {
    if (!state.pending) return;

    let disposed = false;
    firstAsk ??= ask();
    void firstAsk.then((request) => {
      if (!disposed) setState({ pending: false, request });
    });

    return () => {
      disposed = true;
    };
  }, [state.pending]);

  // A client may send several requests into one window — NIP-55 has a flag for
  // exactly that — in which case the next one arrives while the sheet is up.
  useEffect(() => {
    if (!supportsSignerPrompt()) return;

    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;

    void (async () => {
      listener = await SignerPrompt.addListener('signerRequest', () => {
        void ask().then((request) => {
          if (!disposed && request) setState({ pending: false, request });
        });
      });
      if (disposed) void listener.remove();
    })().catch(() => {
      // An older build of the app shell. One request at a time, then.
    });

    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, []);

  const resolve = useCallback((allowed: boolean, remember: boolean) => {
    const id = state.request?.id;
    if (!id) return;

    // Cleared first, so the sheet cannot be answered twice by a double tap.
    // The activity finishes itself when its queue empties; if it does not —
    // because a client sent more than one — the next arrives through the
    // listener above.
    setState({ pending: false, request: null });

    void SignerPrompt.resolve({ id, allowed, remember })
      .then(() => ask())
      .then((next) => {
        if (next) setState({ pending: false, request: next });
      })
      .catch(() => {
        // The window is going away regardless; the activity answers the caller.
      });
  }, [state.request?.id]);

  return { ...state, resolve };
}

/**
 * Whether this window is a signing sheet, answered synchronously.
 *
 * Set on the document by `SignerActivity` before any of the app's own scripts
 * run, because the things that have to know — the transparent background, the
 * wallpaper that must not be drawn over it — have to know on the first frame
 * rather than one bridge call later.
 */
export function isSignerSheet(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.classList.contains('signer-sheet');
}
