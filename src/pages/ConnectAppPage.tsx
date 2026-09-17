import { useSeoMeta } from '@unhead/react';
import { ArrowLeft, Camera, Copy, Link2, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { QrScanner } from '@/components/QrScanner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useQrScanning } from '@/hooks/useQrScanning';
import { useToast } from '@/hooks/useToast';
import { NappPush } from '@/lib/nappPushPlugin';
import { SignerApps, supportsSignerApps } from '@/lib/signerAppsPlugin';
import { cn } from '@/lib/utils';

/**
 * Connecting an app, on a screen of its own.
 *
 * A screen rather than a dialog over the list, because this is the shape the
 * platform gives the same job: adding a Wi-Fi network, pairing a device,
 * adding an account are all whole screens in Android's settings, and the
 * dialogs there are for answering a question rather than for doing something.
 * Pasting a link, scanning a code and making one are three ways through one
 * task, and a task wants room and nothing else on screen — a card over a list
 * of every app that already has the key asks a person to read past it.
 *
 * Back leaves, which is the whole of the way out. Nothing here is accepted by
 * arriving: a link that came from outside the app is typed into the box for
 * the user to look at and press, never connected on sight. See
 * `DeepLinkHandler`.
 */
export function ConnectAppPage() {
  useSeoMeta({
    title: 'Connect an app — Tenna',
    description: 'Let an app somewhere else ask Tenna to sign for it.',
  });

  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { config } = useAppContext();
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const canScan = useQrScanning();

  // A link that arrived from outside the app, carried in router state rather
  // than in the URL because it holds the secret that proves the connection.
  const pasted = (location.state as { connect?: string } | null)?.connect ?? '';

  const [uri, setUri] = useState(pasted);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  // The link this screen made, once it has made one. It takes the place of the
  // box: having made a link, the only thing left to do with this screen is
  // copy it somewhere.
  const [invitation, setInvitation] = useState<string | null>(null);

  const ready = uri.trim().length > 0;

  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/settings/apps');
  }, [navigate]);

  /** The relays a new connection listens on: the ones this account publishes to. */
  const relays = useMemo(
    () =>
      config.relayMetadata.relays
        .filter((relay) => relay.write)
        .map((relay) => relay.url),
    [config.relayMetadata.relays],
  );

  /**
   * Ask for the notification permission, if it has not been given.
   *
   * A connection that cannot raise a notification can only ever answer what
   * has already been granted — anything else arrives on a socket with the app
   * closed, and a notification is the only way it reaches a person. So this is
   * asked at the moment a connection is made, which is the moment it means
   * something, rather than the first time a request is lost.
   *
   * Refusing is allowed. The connection still works for everything it was
   * granted up front; the rest is refused out loud rather than left hanging.
   */
  const askAboutNotifications = useCallback(async () => {
    try {
      const { granted } = await NappPush.status();
      if (granted) return;

      const asked = await NappPush.requestPermission();
      if (!asked.granted) {
        toast({
          title: 'Notifications are off',
          description:
            'This app can still do what you allow now, but Tenna cannot ask you about anything else while it is closed.',
        });
      }
    } catch {
      // No push plugin in this build. Nothing to ask for.
    }
  }, [toast]);

  /**
   * Take a link, and go back to the list the new connection is now in.
   *
   * Leaving on success rather than staying with an empty box: the task is
   * done, and the thing worth seeing next is the app sitting in the list with
   * its name on it.
   */
  const connect = useCallback(
    async (value: string) => {
      const link = value.trim();
      if (!link || !pubkey || busy) return;

      setBusy(true);
      try {
        const { name } = await SignerApps.connect({ account: pubkey, uri: link });
        toast({ title: `${name} is connected` });
        await askAboutNotifications();
        goBack();
      } catch (error) {
        toast({
          title: 'Could not connect that app',
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        });
      } finally {
        setBusy(false);
      }
    },
    [pubkey, busy, toast, askAboutNotifications, goBack],
  );

  const create = useCallback(async () => {
    if (!pubkey) return;
    if (!relays.length) {
      toast({
        title: 'No relays to listen on',
        description: 'Add a relay Tenna can write to, then try again.',
        variant: 'destructive',
      });
      return;
    }

    try {
      const { uri: made } = await SignerApps.createConnection({ account: pubkey, relays });
      setInvitation(made);
      await askAboutNotifications();
    } catch (error) {
      toast({
        title: 'Could not make a link',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  }, [pubkey, relays, toast, askAboutNotifications]);

  const copy = useCallback(() => {
    if (!invitation) return;
    void navigator.clipboard
      .writeText(invitation)
      .then(() => toast({ title: 'Link copied' }))
      .catch(() => toast({ title: 'Could not copy the link', variant: 'destructive' }));
  }, [invitation, toast]);

  return (
    <main className="relative min-h-screen select-none bg-card text-card-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-card/95 px-4 pb-3 pt-safe-offset-3 backdrop-blur">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/90 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeft aria-hidden="true" className="size-6" />
        </button>

        <h1 className="text-xl font-semibold">
          {invitation ? 'Your connection link' : 'Connect an app'}
        </h1>
      </header>

      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pb-safe-offset-8 pt-2">
        {invitation ? (
          <>
            <p className="text-base text-foreground/55">
              Paste this into the app you want to connect. It works once — whoever uses it
              first becomes the app on the other end.
            </p>

            <p className="max-h-60 overflow-auto break-all rounded-2xl bg-foreground/[0.06] p-4 font-mono text-sm">
              {invitation}
            </p>

            <Button onClick={copy} className="h-12 gap-3 rounded-xl text-base">
              <Copy aria-hidden="true" className="size-5" />
              Copy
            </Button>
          </>
        ) : (
          <>
            <p className="text-base text-foreground/55">
              An app running somewhere else can ask Tenna to sign for it. It will still ask
              you the first time it wants anything.
            </p>

            {/* One box, with whatever is worth doing to it at the right-hand
                end: the camera while it is empty, and the way out of it once it
                holds something. Two controls never show at once — a Connect
                button beside an empty box is a button that cannot be pressed,
                and a camera beside a link that is already there is an offer to
                throw it away. */}
            <div className="relative">
              <Input
                value={uri}
                onChange={(event) => setUri(event.target.value)}
                placeholder="nostrconnect://…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={cn('h-14 rounded-xl text-base', ready ? 'pr-28' : 'pr-14')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void connect(uri);
                }}
              />

              <div className="absolute inset-y-1.5 right-1.5 flex items-center">
                {ready ? (
                  <Button
                    onClick={() => void connect(uri)}
                    disabled={busy}
                    className="h-11 min-w-24 rounded-lg px-4 text-base"
                  >
                    {busy ? (
                      <Loader2 aria-hidden="true" className="size-5 animate-spin" />
                    ) : (
                      'Connect'
                    )}
                    {busy && <span className="sr-only">Connecting</span>}
                  </Button>
                ) : (
                  canScan && (
                    <button
                      type="button"
                      onClick={() => setScanning(true)}
                      aria-label="Scan a QR code"
                      className="flex size-11 items-center justify-center rounded-lg text-foreground/70 outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <Camera aria-hidden="true" className="size-6" />
                    </button>
                  )
                )}
              </div>
            </div>

            <Button
              variant="ghost"
              onClick={() => void create()}
              className="h-12 justify-start gap-3 rounded-xl px-3 text-base"
            >
              <Link2 aria-hidden="true" className="size-5" />
              Or make a link to paste there
            </Button>

            {!supportsSignerApps() && (
              <p className="text-base text-foreground/40">
                This build of Tenna cannot answer other apps.
              </p>
            )}
          </>
        )}
      </div>

      {/* A scanned link is connected on the spot. Pointing a camera at a code
          is as deliberate as pressing Connect, and the code has to be one —
          anything else is refused with the camera left running, so a wallet's
          QR code on the same table doesn't close the camera and leave the user
          wondering what it did. */}
      <QrScanner
        open={scanning}
        onOpenChange={setScanning}
        title="Scan a connection link"
        description="Point the camera at the code the other app is showing."
        mismatch="That code isn’t a connection link."
        onScan={(value) => {
          const link = value.trim();
          if (!link.toLowerCase().startsWith('nostrconnect://')) return false;

          setScanning(false);
          setUri(link);
          void connect(link);
          return true;
        }}
      />
    </main>
  );
}

export default ConnectAppPage;
