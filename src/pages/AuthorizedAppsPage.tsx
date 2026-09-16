import { useSeoMeta } from '@unhead/react';
import { ArrowLeft, Copy, Plus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AppMark } from '@/components/AppMark';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  useAuthorizedApps,
  type AuthorizedApp,
  type AuthorizedPermission,
} from '@/hooks/useAuthorizedApps';
import { useToast } from '@/hooks/useToast';
import { permissionTitle } from '@/lib/permissionLabels';
import { supportsSignerApps } from '@/lib/signerAppsPlugin';

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
  const { apps, revoke, forget, pubkey } = useAuthorizedApps();

  const [openId, setOpenId] = useState<string | null>(null);

  const open = apps?.find((app) => app.id === openId);

  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/settings');
  }, [navigate]);

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
                  onClick={() => navigate('/settings/apps/connect')}
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
                        <AppMark
                          name={app.name}
                          icon={app.icon}
                          adaptive={app.adaptive}
                          tile={app.tile}
                          badge={app.source === 'package'}
                          // Cut out of the list's own surface rather than the
                          // wallpaper: this screen is a card, and a ring of
                          // the colour behind the card would be a halo.
                          badgeClassName="ring-card"
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
    </main>
  );
}

export default AuthorizedAppsPage;
