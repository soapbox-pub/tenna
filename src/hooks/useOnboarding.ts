import { useCallback, useEffect, useRef, useState } from 'react';

import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';

/**
 * Whether to show the introduction, and how to be done with it.
 *
 * The answer is latched at the first render and never recomputed, which is the
 * whole point of the hook. Signing in is the last thing the introduction does,
 * and a live `!user` test would therefore pull the screen out from under the
 * user at the moment they succeeded — the closing screen would never be drawn.
 * So the question "is this a launch that needs an introduction" is asked once,
 * on the way in, and the flow itself says when it is finished.
 *
 * Somebody already signed in at launch is never asked, whatever the stored flag
 * says: a person with an account has had the only part of this that does
 * anything.
 */
export function useOnboarding(): { show: boolean; dismiss: () => void } {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();

  const [show, setShow] = useState(() => !config.onboarded && !user);

  // Held in a ref because `updateConfig` is a new closure on every render, and
  // `dismiss` is depended on by an effect that registers a hardware back
  // button listener. An unstable `dismiss` would tear that down and rebuild it
  // on every render.
  const updateConfigRef = useRef(updateConfig);
  useEffect(() => {
    updateConfigRef.current = updateConfig;
  }, [updateConfig]);

  const dismiss = useCallback(() => {
    setShow(false);
    updateConfigRef.current((current) => ({ ...current, onboarded: true }));
  }, []);

  return { show, dismiss };
}
