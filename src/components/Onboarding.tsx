import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { ArrowLeft, Eye, EyeOff, Loader2 } from 'lucide-react';
import { getPublicKey, nip19 } from 'nostr-tools';
import { useCallback, useEffect, useState } from 'react';

import AuthDialog from '@/components/auth/AuthDialog';
import { IntroImage } from '@/components/IntroImage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSignup } from '@/hooks/useSignup';
import { toast } from '@/hooks/useToast';
import { saveNsec } from '@/lib/credentialManager';
import { impactLight, notificationSuccess } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * The screens, in order.
 *
 * Three that explain and three that do something. The explaining comes first
 * and is skippable throughout, because a person who already knows what Nostr is
 * should not have to be told, and a person who does not will not be persuaded
 * by a fourth paragraph.
 */
const STEPS = ['welcome', 'nostr', 'keys', 'create', 'save', 'done'] as const;

type Step = (typeof STEPS)[number];

/** The steps a user may walk backwards out of — everything before a key exists. */
const REVERSIBLE: ReadonlySet<Step> = new Set<Step>(['nostr', 'keys', 'create']);

/** The big button, at the size a thumb expects at the bottom of a phone screen. */
const PRIMARY = 'h-13 w-full rounded-full text-base font-semibold';

/**
 * Tenna's introduction, shown once on a device nobody has signed in on.
 *
 * Full screen rather than a dialog, and the only thing on screen while it is
 * up. Tenna opens onto a wall of apps that do nothing useful until there is a
 * key behind them, and the first launch is the one moment where explaining why
 * is not an interruption of something else the user was doing.
 *
 * It is skippable from every screen but the last, and skipping counts as
 * having been shown — see `useOnboarding`. What it must never be is a wall:
 * Tenna browses sites perfectly well signed out, and a person who wants to
 * look around first is entitled to.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [nsec, setNsec] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  // Set when the platform had nowhere to put the key and said so. The screen
  // stops insisting at that point: the key is on screen and selectable, and
  // holding someone hostage to a button that cannot work is worse than letting
  // them past it.
  const [saveFailed, setSaveFailed] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  const { generateKey, signInWithKey } = useSignup();
  const { user } = useCurrentUser();

  const index = STEPS.indexOf(step);

  const back = useCallback(() => {
    setStep((current) => {
      if (!REVERSIBLE.has(current)) return current;
      return STEPS[STEPS.indexOf(current) - 1] ?? current;
    });
  }, []);

  const advance = () => {
    impactLight();
    setStep(STEPS[index + 1] ?? 'done');
  };

  // The hardware back button walks the introduction backwards rather than
  // leaving the app, which is what it would otherwise do from here — this is
  // the root of the task, with no history behind it. On the first screen there
  // is nowhere back to, and on the screens after a key exists there is nothing
  // to go back *to*: the key has been made and the user has to be shown it.
  useEffect(() => {
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', back)
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [back]);

  // Someone who brought a key of their own, rather than making one here. The
  // dialog reports a login by there being a user where there was not one, and
  // that can only have happened while it was open.
  useEffect(() => {
    if (user && step === 'create') {
      notificationSuccess();
      onDone();
    }
  }, [user, step, onDone]);

  const handleCreate = () => {
    impactLight();
    setIsGenerating(true);
    // A beat, so the button visibly does something. On a device with a native
    // store behind it the work is a bridge call and is over before a frame.
    setTimeout(async () => {
      try {
        setNsec(await generateKey());
        setStep('save');
      } finally {
        setIsGenerating(false);
      }
    }, 600);
  };

  /**
   * Put the key somewhere the user will still have it, then sign them in.
   *
   * In that order, and not the other way round: this screen is the only moment
   * the key is readable, and signing in first would invite a user to walk away
   * from a key nothing has a copy of. A dismissed prompt still counts — saying
   * no to the password manager is a decision, not a failure, and it is met
   * with silence rather than a second ask.
   */
  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);

    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== 'nsec') throw new Error('Not an nsec');
      const npub = nip19.npubEncode(getPublicKey(decoded.data));

      const result = await saveNsec(npub, nsec, 'Tenna');

      if (result === 'saved-to-file') {
        toast({
          title: 'Key saved to your files',
          description:
            'This phone has no password manager for Tenna to use, so your key is in the Documents folder instead.',
        });
      }
    } catch {
      // A real failure — a write that did not work. Not a refusal.
      setSaveFailed(true);
      setIsSaving(false);
      toast({
        title: "Couldn't save your key",
        description: 'Copy it from the box above and keep it somewhere safe.',
        variant: 'destructive',
      });
      return;
    }

    try {
      await signInWithKey(nsec);
      notificationSuccess();
      setStep('done');
    } catch {
      toast({
        title: "Couldn't sign you in",
        description: 'Your key was made and saved. Try signing in with it from Settings.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  /** Sign in with the key that could not be saved, having said so plainly. */
  const continueUnsaved = async () => {
    setIsSaving(true);
    try {
      await signInWithKey(nsec);
      setStep('done');
    } catch {
      toast({ title: "Couldn't sign you in", variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    // Below the z-50 a dialog overlay uses, so the login dialog this screen can
    // open lands in front of it rather than racing it on document order.
    <div className="fixed inset-0 z-40 overflow-y-auto bg-background text-foreground">
      {/* Tenna's own weather, the same as the wall's. Nobody is signed in
          during the introduction, so there is never a theme over the top of
          it — but it is drawn behind everything all the same, so the screens
          the flow ends on look like the screen it hands over to. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_top,rgba(250,43,56,0.28),transparent_60%),radial-gradient(ellipse_at_bottom_left,rgba(172,210,222,0.16),transparent_55%)]"
      />

      <div className="relative mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-safe-offset-8 pt-safe-offset-3">
        <header className="flex h-11 shrink-0 items-center justify-between gap-3">
          {REVERSIBLE.has(step) ? (
            <button
              type="button"
              onClick={back}
              aria-label="Back"
              className="flex h-11 w-16 items-center justify-start rounded-lg text-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ArrowLeft aria-hidden="true" className="size-6" />
            </button>
          ) : (
            /* Both sides of the header are the same width whether or not there
               is anything in them, so the dots sit on the screen's centre
               rather than drifting with the controls. */
            <span className="w-16" />
          )}

          <Dots count={STEPS.length} active={index} />

          {step === 'done' ? (
            <span className="w-16" />
          ) : (
            <button
              type="button"
              onClick={onDone}
              className="w-16 shrink-0 rounded-full py-2 text-right text-base font-medium text-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
            >
              Skip
            </button>
          )}
        </header>

        {/*
          Keyed on the step so React rebuilds the subtree rather than reusing
          it, which is what makes the entrance animation play again each time
          instead of only on the first screen.
        */}
        <main
          key={step}
          className="flex flex-1 flex-col fade-in slide-in-from-right-4 duration-400 motion-safe:animate-in"
        >
          {step === 'welcome' && (
            <Screen
              image="/intro-tenna.png"
              title="Welcome to Tenna"
              body="Tenna is a browser for Nostr. The apps on your wall are published by people rather than companies, and they run here on your phone instead of on somebody else's computer."
            />
          )}

          {step === 'nostr' && (
            <Screen
              image="/intro-nostr.png"
              title="One account, everywhere"
              body="Nostr is a network where your account belongs to you and not to any single app. Sign in once here and every app on the wall already knows who you are. Nobody approves it, and nobody can take it away."
            />
          )}

          {step === 'keys' && (
            <Screen
              image="/intro-key.png"
              title="Your account is a key"
              body="Not a username and a password — a key, which only you hold. There is no way to reset one, so Tenna keeps yours on this phone and does the signing for you. The sites you visit never see it."
            />
          )}

          {step === 'create' && (
            <Screen
              image="/intro-create.png"
              title="Make yourself a key"
              body="It takes a moment and asks you for nothing. If you are already on Nostr, bring the key you have instead."
            />
          )}

          {step === 'save' && (
            <SaveScreen
              nsec={nsec}
              showKey={showKey}
              onToggleKey={() => setShowKey((shown) => !shown)}
            />
          )}

          {step === 'done' && (
            <Screen
              image="/intro-done.png"
              title="You're on"
              body="That's everything. Pick an app and have a look around — you are signed in wherever you go from here."
            />
          )}
        </main>

        <footer className="mt-8 shrink-0 space-y-3">
          {(step === 'welcome' || step === 'nostr' || step === 'keys') && (
            <Button onClick={advance} className={PRIMARY}>
              Next
            </Button>
          )}

          {step === 'create' && (
            <>
              <Button onClick={handleCreate} disabled={isGenerating} className={PRIMARY}>
                {isGenerating ? (
                  <>
                    <Loader2 aria-hidden="true" className="size-5 animate-spin" />
                    Making your key…
                  </>
                ) : (
                  'Create my account'
                )}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setAuthOpen(true)}
                disabled={isGenerating}
                className="h-12 w-full rounded-full text-base font-medium text-foreground/75 hover:text-foreground"
              >
                I already have a key
              </Button>
            </>
          )}

          {step === 'save' && (
            <Button
              onClick={saveFailed ? continueUnsaved : handleSave}
              disabled={isSaving}
              className={PRIMARY}
            >
              {isSaving ? (
                <>
                  <Loader2 aria-hidden="true" className="size-5 animate-spin" />
                  Saving…
                </>
              ) : saveFailed ? (
                "I've copied it — continue"
              ) : (
                'Save my key'
              )}
            </Button>
          )}

          {step === 'done' && (
            <Button onClick={onDone} className={PRIMARY}>
              Start browsing
            </Button>
          )}
        </footer>
      </div>

      <AuthDialog
        isOpen={authOpen}
        initialStep="login"
        onClose={() => setAuthOpen(false)}
      />
    </div>
  );
}

/** How far along, for the screens that are a sequence rather than a form. */
function Dots({ count, active }: { count: number; active: number }) {
  return (
    <div className="flex items-center gap-1.5" role="presentation">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            'size-1.5 rounded-full transition-colors',
            i === active ? 'bg-primary' : 'bg-foreground/25',
          )}
        />
      ))}
    </div>
  );
}

/** A picture, a heading, and a paragraph — the shape most of these screens are. */
function Screen({ image, title, body }: { image: string; title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 py-8 text-center">
      <IntroImage src={image} size="w-44" />

      <div className="space-y-4">
        <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight">
          {title}
        </h1>
        <p className="text-pretty text-lg leading-relaxed text-foreground/70">{body}</p>
      </div>
    </div>
  );
}

/**
 * The key itself, and the one warning worth giving about it.
 *
 * Masked to begin with, and the warning appears only once the key does. A
 * person who was never going to look at it does not need to be frightened, and
 * a person who reveals it is about to do something with it.
 */
function SaveScreen({
  nsec,
  showKey,
  onToggleKey,
}: {
  nsec: string;
  showKey: boolean;
  onToggleKey: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col justify-center gap-6 py-8">
      <div className="space-y-3">
        <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight">
          Keep a copy
        </h1>
        <p className="text-pretty text-lg leading-relaxed text-foreground/70">
          This is your key. Tenna has it on this phone already — the copy you are
          saving now is for everywhere else, and for whatever phone comes after
          this one.
        </p>
      </div>

      <div className="relative">
        <label htmlFor="onboarding-nsec" className="sr-only">
          Your secret key
        </label>
        <Input
          id="onboarding-nsec"
          type={showKey ? 'text' : 'password'}
          value={nsec}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-13 rounded-xl pr-12 font-mono text-base"
        />
        <button
          type="button"
          onClick={onToggleKey}
          aria-label={showKey ? 'Hide key' : 'Show key'}
          className="absolute right-1 top-1 flex size-11 items-center justify-center rounded-lg text-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
        >
          {showKey ? (
            <EyeOff aria-hidden="true" className="size-5" />
          ) : (
            <Eye aria-hidden="true" className="size-5" />
          )}
        </button>
      </div>

      {showKey && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-base leading-relaxed text-amber-200 fade-in slide-in-from-top-1 duration-200 motion-safe:animate-in">
          Never show this to anyone or type it into another app. Whoever has it
          is you, permanently — there is nothing to reset and no one to appeal to.
        </p>
      )}
    </div>
  );
}

export default Onboarding;
