import { Laptop, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { impactLight, notificationError } from '@/lib/haptics';
import { NearbyLogin, type NearbyLoginStatus } from '@/lib/nearbyLoginPlugin';

type Phase =
  | NearbyLoginStatus
  | { state: 'starting' }
  | { state: 'sent'; computer: string }
  | { state: 'failed'; message: string };

/** Whether a rejection was the user saying no, which is not a failure to report. */
function isCancel(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'CANCELED';
}

/**
 * Log a computer in as `pubkey`, over Bluetooth.
 *
 * The computer is Din: its login screen has a button that waits for a phone.
 * This draws where the search has got to and the code to compare; the yes is
 * given to the system prompt the app process puts up, not to anything here.
 */
export function NearbyLoginDialog({
  pubkey,
  open,
  onOpenChange,
}: {
  pubkey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ state: 'starting' });
  // Bumped by "Try again" to start over.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase({ state: 'starting' });

    const listener = NearbyLogin.addListener('status', (status) => {
      if (active) setPhase(status);
    });

    NearbyLogin.start({ pubkey })
      .then(({ computer }) => {
        if (!active) return;
        impactLight();
        setPhase({ state: 'sent', computer });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isCancel(error)) {
          onOpenChange(false);
          return;
        }
        notificationError();
        setPhase({
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      active = false;
      void listener.then((handle) => handle.remove());
      void NearbyLogin.cancel();
    };
    // onOpenChange is the parent's setter; a fresh one mustn't restart the search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pubkey, attempt]);

  const busy = phase.state !== 'sent' && phase.state !== 'failed';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader>
          <DialogTitle className="text-left text-xl">Log in on a computer</DialogTitle>
          <DialogDescription className="text-left text-base">
            {phase.state === 'sent'
              ? `${phase.computer} is signed in as you. Sign out there when you're done with it.`
              : phase.state === 'comparing'
                ? `Check that ${phase.computer} shows the same code, then approve.`
                : 'On the computer, choose Log in with your phone. Keep this phone close to it.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-32 flex-col items-center justify-center gap-3 py-2" aria-live="polite">
          {phase.state === 'comparing' ? (
            <p className="font-mono text-4xl font-semibold tracking-widest tabular-nums">
              {phase.code.slice(0, 3)} {phase.code.slice(3)}
            </p>
          ) : phase.state === 'failed' ? (
            <p role="alert" className="text-center text-base text-destructive">
              {phase.message}
            </p>
          ) : phase.state === 'sent' ? (
            <Laptop aria-hidden="true" className="size-12 text-primary" />
          ) : (
            <>
              <Loader2 aria-hidden="true" className="size-10 animate-spin text-primary" />
              <p className="text-base text-foreground/70">
                {phase.state === 'connecting'
                  ? 'Connecting…'
                  : phase.state === 'sending'
                    ? 'Sending…'
                    : 'Looking for the computer…'}
              </p>
            </>
          )}
        </div>

        <DialogFooter>
          {phase.state === 'failed' && (
            <Button
              variant="ghost"
              onClick={() => setAttempt((n) => n + 1)}
              className="h-11 rounded-full px-6 text-base"
            >
              Try again
            </Button>
          )}
          <Button
            variant={busy ? 'ghost' : 'default'}
            onClick={() => onOpenChange(false)}
            className="h-11 rounded-full px-6 text-base"
          >
            {busy ? 'Cancel' : 'Done'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
