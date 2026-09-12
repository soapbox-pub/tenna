import { useSeoMeta } from '@unhead/react';
import { ArrowLeft, Copy, Link2, Plus, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { TileArtwork } from '@/components/Tile';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  useAuthorizedApps,
  type AuthorizedApp,
  type AuthorizedPermission,
} from '@/hooks/useAuthorizedApps';
import { useAppContext } from '@/hooks/useAppContext';
import { useToast } from '@/hooks/useToast';
import { NappPush } from '@/lib/nappPushPlugin';
import { permissionTitle } from '@/lib/permissionLabels';
import { SignerApps, supportsSignerApps } from '@/lib/signerAppsPlugin';

/** The section-card class the rest of Settings uses. */
const GROUP = 'rounded-2xl bg-foreground/[0.06] px-5 py-4';
const GROUP_TITLE = 'flex min-h-9 items-center text-lg font-medium text-foreground';

/** Matching the relay switches: large enough to hit, quiet enough to scan. */
const SWITCH =
  'h-7 w-12 data-[state=unchecked]:bg-foreground/20 [&>span]:size-6 [&>span]:data-[state=checked]:translate-x-5';

/** How long ago, in the shortest true form. */
function ago(at: number): string {
  if (!at) return 'Never used';

  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'Just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;

  return new Date(at).toLocaleDateString();
}

/** What a row says about itself in one line. */
function summarize(app: AuthorizedApp): string {
  const allowed = app.permissions.filter((permission) => permission.allowed).length;
  const refused = app.permissions.length - allowed;

  if (!app.permissions.length) return app.subtitle;
  if (!allowed) return refused === 1 ? '1 thing refused' : `${refused} things refused`;
  return allowed === 1 ? '1 thing allowed' : `${allowed} things allowed`;
}

// ---------------------------------------------------------------------------
// The detail sheet
// ---------------------------------------------------------------------------

/**
 * One application, and everything it may do.
 *
 * A row opens this rather than carrying its own switches, the same way the
 * relay list works: the list stays scannable, and the thing being changed is
 * named at the top of the screen that changes it.
 */
function AppDialog({
  app,
  onClose,
  onRevoke,
  onForget,
}: {
  app: AuthorizedApp | undefined;
  onClose: () => void;
  onRevoke: (app: AuthorizedApp, permission: AuthorizedPermission) => void;
  onForget: (app: AuthorizedApp) => void;
}) {
  const { toast } = useToast();

  return (
    <Dialog open={!!app} onOpenChange={(open) => !open && onClose()}>
      {app && (
        <DialogContent className="max-w-sm rounded-3xl">
          <DialogHeader>
            <DialogTitle className="text-left text-xl">{app.name}</DialogTitle>
            <DialogDescription className="break-all text-left text-base">
              {app.subtitle}
            </DialogDescription>
          </DialogHeader>

          {app.permissions.length > 0 ? (
            <div className="divide-y divide-border">
              {app.permissions.map((permission) => (
                <div
                  key={`${permission.type}:${permission.kind ?? ''}`}
                  className="flex min-h-12 items-center justify-between gap-4 py-2"
                >
                  <Label className="text-base font-normal text-foreground">
                    {permissionTitle(permission.type, permission.kind)}
                  </Label>
                  {/* Off is the only move. A switch that could be turned back
                      on would be this screen granting a permission, which is
                      not a thing a settings screen should be able to do — a
                      grant is given in the moment it is asked for, where the
                      user can see what is being asked. */}
                  <Switch
                    checked={permission.allowed}
                    onCheckedChange={() => onRevoke(app, permission)}
                    className={SWITCH}
                  />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-base text-foreground/55">
              Nothing has been allowed yet. This connection is listening, and will ask the
              first time it wants something.
            </p>
          )}

          {app.connection && (
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard
                  .writeText(app.connection!.uri)
                  .then(() =>
                    toast({
                      title: 'Link copied',
                      description: 'Paste it into the app you want to connect.',
                    }),
                  )
                  .catch(() => {
                    toast({ title: 'Could not copy the link', variant: 'destructive' });
                  });
              }}
              className="h-11 justify-start gap-3 rounded-xl px-3 text-base"
            >
              <Copy aria-hidden="true" className="size-5" />
              Copy the connection link
            </Button>
          )}

          <DialogFooter className="sm:justify-start">
            <Button
              variant="ghost"
              onClick={() => onForget(app)}
              className="h-11 justify-start gap-3 rounded-xl px-3 text-base text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 aria-hidden="true" className="size-5" />
              {app.source === 'bunker' ? 'Disconnect' : 'Revoke access'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Making a connection
// ---------------------------------------------------------------------------

/**
 * Accepting a link an app sent, or making one for it to accept.
 *
 * Both are in one dialog because they are the same act from two ends, and
 * which end a person is at depends only on which of the two apps has a box to
 * paste into.
 */
function ConnectDialog({
  open,
  pasted,
  onOpenChange,
  onConnect,
  onCreate,
}: {
  open: boolean;
  /** A link that arrived as a deep link, waiting to be accepted. */
  pasted: string;
  onOpenChange: (open: boolean) => void;
  onConnect: (uri: string) => Promise<boolean>;
  onCreate: () => void;
}) {
  // Seeded from the link that arrived, and never reset by an effect: the
  // parent gives this component a `key` off that link, so a new one arriving
  // remounts it rather than writing over whatever was being typed.
  const [uri, setUri] = useState(pasted);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const ok = await onConnect(uri.trim());
    setBusy(false);
    if (ok) {
      setUri('');
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader>
          <DialogTitle className="text-left text-xl">Connect an app</DialogTitle>
          <DialogDescription className="text-left text-base">
            An app running somewhere else can ask Tenna to sign for it. It will still ask you
            the first time it wants anything.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={uri}
            onChange={(event) => setUri(event.target.value)}
            placeholder="nostrconnect://…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-12 rounded-xl text-base"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && uri.trim()) void submit();
            }}
          />
          <Button
            onClick={() => void submit()}
            disabled={!uri.trim() || busy}
            className="h-12 rounded-xl px-5 text-base"
          >
            Connect
          </Button>
        </div>

        <DialogFooter className="sm:justify-start">
          <Button
            variant="ghost"
            onClick={onCreate}
            className="h-11 justify-start gap-3 rounded-xl px-3 text-base"
          >
            <Link2 aria-hidden="true" className="size-5" />
            Or make a link to paste there
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The link Tenna just made, for copying into the app that needs it. */
function InvitationDialog({
  uri,
  onClose,
}: {
  uri: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();

  return (
    <Dialog open={!!uri} onOpenChange={(open) => !open && onClose()}>
      {uri && (
        <DialogContent className="max-w-sm rounded-3xl">
          <DialogHeader>
            <DialogTitle className="text-left text-xl">Your connection link</DialogTitle>
            <DialogDescription className="text-left text-base">
              Paste this into the app you want to connect. It works once — whoever uses it
              first becomes the app on the other end.
            </DialogDescription>
          </DialogHeader>

          <p className="max-h-32 overflow-auto break-all rounded-xl bg-foreground/[0.06] p-3 font-mono text-xs">
            {uri}
          </p>

          <DialogFooter className="sm:justify-start">
            <Button
              onClick={() => {
                void navigator.clipboard
                  .writeText(uri)
                  .then(() => toast({ title: 'Link copied' }))
                  .catch(() => toast({ title: 'Could not copy the link', variant: 'destructive' }));
              }}
              className="h-12 w-full gap-3 rounded-xl text-base"
            >
              <Copy aria-hidden="true" className="size-5" />
              Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * Who has been given this account's key.
 *
 * Three kinds of thing, in one list, because to the person reading it they are
 * one thing: a site Tenna opened, an app on the phone that asked, and an app
 * somewhere else that was invited. They keep their grants in different places
 * for reasons about where those grants have to be readable from, and none of
 * that is a distinction worth putting on a screen.
 */
export function AuthorizedAppsPage() {
  useSeoMeta({
    title: 'Authorized apps — Tenna',
    description: 'What has been given permission to use your key.',
  });

  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { config } = useAppContext();
  const { apps, reload, revoke, forget, pubkey } = useAuthorizedApps();

  // A link that arrived from outside the app, carried in router state rather
  // than in the URL because it holds the secret that proves the connection.
  // Nothing is accepted by arriving here — see `DeepLinkHandler`.
  const pasted = (location.state as { connect?: string } | null)?.connect ?? '';

  const [openId, setOpenId] = useState<string | null>(null);
  // Open already when a link brought us here: this screen is the answer to
  // that link, and the dialog is where the answer is given.
  const [connecting, setConnecting] = useState(!!pasted);
  const [invitation, setInvitation] = useState<string | null>(null);

  const open = apps?.find((app) => app.id === openId);

  /** The relays a new connection listens on: the ones this account publishes to. */
  const relays = useMemo(
    () =>
      config.relayMetadata.relays
        .filter((relay) => relay.write)
        .map((relay) => relay.url),
    [config.relayMetadata.relays],
  );

  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/settings');
  }, [navigate]);

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

  const connect = useCallback(
    async (uri: string) => {
      if (!pubkey) return false;
      try {
        const { name } = await SignerApps.connect({ account: pubkey, uri });
        toast({ title: `${name} is connected` });
        await askAboutNotifications();
        await reload();
        return true;
      } catch (error) {
        toast({
          title: 'Could not connect that app',
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        });
        return false;
      }
    },
    [pubkey, reload, toast, askAboutNotifications],
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
      const { uri } = await SignerApps.createConnection({ account: pubkey, relays });
      setConnecting(false);
      setInvitation(uri);
      await askAboutNotifications();
      await reload();
    } catch (error) {
      toast({
        title: 'Could not make a link',
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      });
    }
  }, [pubkey, relays, reload, toast, askAboutNotifications]);

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

        <h1 className="text-xl font-semibold">Authorized apps</h1>
      </header>

      <div className="mx-auto max-w-2xl">
        <div className="flex flex-col gap-2 px-4 pb-safe-offset-8 pt-2">
          <section className={GROUP}>
            <div className="flex items-center justify-between gap-3">
              <h2 className={GROUP_TITLE}>Apps and sites</h2>
              {supportsSignerApps() && !!pubkey && (
                <button
                  type="button"
                  onClick={() => setConnecting(true)}
                  aria-label="Connect an app"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/90 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <Plus aria-hidden="true" className="size-5" />
                </button>
              )}
            </div>

            <p className="mt-1 text-base text-foreground/55">
              What you have let sign, encrypt or decrypt with your key. Turning something off
              here means being asked about it again.
            </p>

            {apps === null ? (
              <ul className="-mx-2 mt-2 divide-y divide-border">
                {[0, 1, 2].map((row) => (
                  <li key={row} className="flex items-center gap-3 px-2 py-3">
                    <Skeleton className="size-10 shrink-0 rounded-xl bg-foreground/10" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <Skeleton className="h-4 w-32 bg-foreground/10" />
                      <Skeleton className="h-3 w-20 bg-foreground/10" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : apps.length === 0 ? (
              <p className="mt-3 text-base text-foreground/40">
                {pubkey
                  ? 'Nothing yet. An app that asks to sign will appear here once you answer it.'
                  : 'Sign in to see what has been given your key.'}
              </p>
            ) : (
              <ul className="-mx-2 mt-2 divide-y divide-border">
                {apps.map((app) => (
                  <li key={app.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(app.id)}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <span aria-hidden="true" className="relative block size-10 shrink-0">
                        <TileArtwork
                          name={app.name}
                          iconUrl={app.icon}
                          fit="cover"
                          background={null}
                        />
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-foreground">
                          {app.name}
                        </span>
                        <span className="block truncate text-sm text-foreground/50">
                          {summarize(app)}
                        </span>
                      </span>

                      <span className="shrink-0 text-sm text-foreground/40">
                        {ago(app.lastUsed)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <AppDialog
        app={open}
        onClose={() => setOpenId(null)}
        onRevoke={(app, permission) => void revoke(app, permission)}
        onForget={(app) => {
          setOpenId(null);
          void forget(app);
        }}
      />

      <ConnectDialog
        key={pasted}
        open={connecting}
        pasted={pasted}
        onOpenChange={setConnecting}
        onConnect={connect}
        onCreate={() => void create()}
      />

      <InvitationDialog uri={invitation} onClose={() => setInvitation(null)} />
    </main>
  );
}

export default AuthorizedAppsPage;
