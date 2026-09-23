import { App as NativeApp } from '@capacitor/app';
import { useSeoMeta } from '@unhead/react';
import { ArrowLeft, ChevronRight, LogIn, LogOut, Plus, Trash2, UserPlus, UserRound } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import AuthDialog from '@/components/auth/AuthDialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { useAppContext } from '@/hooks/useAppContext';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { impactLight, notificationError } from '@/lib/haptics';
import { cn, middleEllipsis } from '@/lib/utils';

/** Where the source lives, for the one row on the page that leaves the app. */
const REPOSITORY =
  'https://nostrhub.io/npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/tenna';

/**
 * A group of settings, drawn as the system draws one.
 *
 * The same surface the App info screen uses, and for the same reason: this is
 * a page standing in for a system screen, and a person arriving here from the
 * launcher's own settings should not feel like they have changed operating
 * systems. See `NsiteAppInfo`.
 */
const GROUP = 'rounded-2xl bg-foreground/[0.06] px-5 py-4';

/** The heading on a group. Tall enough that a button beside it sits level. */
const GROUP_TITLE = 'flex min-h-9 items-center text-lg font-medium text-foreground';

/**
 * A switch's colours on a settings row. Its size comes from `size="lg"` on the
 * component, which is the only place a switch can be sized from — see `Switch`.
 */
const SWITCH = cn(
  'shrink-0',
  'data-[state=checked]:bg-primary data-[state=unchecked]:bg-foreground/20',
  'focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card',
  // Whatever reads on the accent the thumb sits in, which the theme has
  // already had to decide — white on Tenna's yellow would not read.
  '[&_[data-slot=switch-thumb]]:bg-primary-foreground!',
);

/** A relay as the config holds one. */
interface Relay {
  url: string;
  read: boolean;
  write: boolean;
}

/** The relay's address without the scheme every relay shares. */
function prettyRelay(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') return parsed.href;
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

/** What Tenna does with a relay, in the words NIP-65 is asking about. */
function relayModeLabel(relay: Relay): string {
  if (relay.read && relay.write) return 'Reads and writes';
  if (relay.read) return 'Reads only';
  if (relay.write) return 'Writes only';
  return 'Unused';
}

/**
 * Whatever was typed, as a relay address.
 *
 * A bare hostname is what people paste, and `wss://` is the only scheme a
 * relay has, so it is supplied rather than demanded. Anything that still will
 * not parse is handed back unchanged for the caller to refuse.
 */
function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  try {
    return new URL(trimmed).toString();
  } catch {
    try {
      return new URL(`wss://${trimmed}`).toString();
    } catch {
      return trimmed;
    }
  }
}

/** Whether an address is one Tenna could actually open a socket to. */
function isRelayUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'wss:' || protocol === 'ws:';
  } catch {
    return false;
  }
}

/**
 * The build the user is running.
 *
 * Asked of the native shell, because that is the only place the number exists
 * — the version is stamped into the Android package at release time from the
 * git tag, and the web bundle carries no such thing. A browser gets no row.
 */
function useAppVersion(): { version: string; build: string } | undefined {
  const [info, setInfo] = useState<{ version: string; build: string }>();

  useEffect(() => {
    let disposed = false;

    NativeApp.getInfo()
      .then(({ version, build }) => {
        if (!disposed) setInfo({ version, build });
      })
      .catch(() => {
        // No package to ask about. The row is left off rather than guessed at.
      });

    return () => {
      disposed = true;
    };
  }, []);

  return info;
}

/**
 * One of the round buttons under the account.
 *
 * The same control the App info screen puts under an app's name: a circle with
 * the mark in it and the word underneath, sized for a thumb rather than a
 * pointer. See `NsiteAppInfo`.
 */
function SettingsAction({
  icon: Icon,
  label,
  onClick,
  to,
  destructive,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  onClick?: () => void;
  /** Where the button goes, for the ones that are a link rather than an act. */
  to?: string;
  destructive?: boolean;
}) {
  const inner = (
    <>
      <span
        className={cn(
          'flex size-16 items-center justify-center rounded-full transition-colors',
          'group-focus-visible:ring-2 group-focus-visible:ring-primary group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card',
          destructive
            ? 'bg-destructive/15 text-destructive group-hover:bg-destructive/25'
            : 'bg-foreground/10 text-foreground group-hover:bg-foreground/15',
        )}
      >
        <Icon aria-hidden={true} className="size-6" />
      </span>
      <span className="whitespace-nowrap text-center text-sm font-medium leading-tight text-foreground/90">
        {label}
      </span>
    </>
  );

  // Wider than the circle it holds, so a two-word verb stays on one line and
  // the row of labels keeps a single baseline.
  const shell = 'group flex w-24 shrink-0 flex-col items-center gap-2 outline-none';

  if (to) {
    return (
      <Link to={to} className={shell}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={shell}>
      {inner}
    </button>
  );
}

/**
 * What one relay is for, and the way to be rid of it.
 *
 * A row on the list opens this rather than carrying its own switches, which is
 * how the system asks a question with more than one answer in it: the list
 * stays scannable, and the thing being changed is named at the top of the
 * screen that changes it.
 */
function RelayDialog({
  relay,
  canRemove,
  onClose,
  onToggle,
  onRemove,
}: {
  relay: Relay | undefined;
  /** False for the last relay standing — see the list below. */
  canRemove: boolean;
  onClose: () => void;
  onToggle: (field: 'read' | 'write', value: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <Dialog open={!!relay} onOpenChange={(open) => !open && onClose()}>
      {relay && (
        <DialogContent className="max-w-sm rounded-3xl">
          <DialogHeader>
            <DialogTitle className="break-all text-left text-xl">
              {prettyRelay(relay.url)}
            </DialogTitle>
            <DialogDescription className="text-left text-base">
              Tenna looks for sites and profiles on the relays it reads, and sends
              what you sign to the ones it writes.
            </DialogDescription>
          </DialogHeader>

          <div className="divide-y divide-border">
            <div className="flex min-h-12 items-center justify-between gap-4 py-2">
              <Label htmlFor="relay-read" className="text-base font-normal text-foreground">
                Read
              </Label>
              <Switch
                id="relay-read"
                size="lg"
                checked={relay.read}
                // The list has no way to say "neither", and NIP-65 has no tag
                // for it, so the last one on cannot be turned off. Removing
                // the relay is what that would have meant.
                disabled={relay.read && !relay.write}
                onCheckedChange={(value) => onToggle('read', value)}
                className={SWITCH}
              />
            </div>

            <div className="flex min-h-12 items-center justify-between gap-4 py-2">
              <Label htmlFor="relay-write" className="text-base font-normal text-foreground">
                Write
              </Label>
              <Switch
                id="relay-write"
                size="lg"
                checked={relay.write}
                disabled={relay.write && !relay.read}
                onCheckedChange={(value) => onToggle('write', value)}
                className={SWITCH}
              />
            </div>
          </div>

          <DialogFooter className="sm:justify-start">
            <Button
              variant="ghost"
              onClick={onRemove}
              disabled={!canRemove}
              className="h-11 justify-start gap-3 rounded-xl px-3 text-base text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 aria-hidden="true" className="size-5" />
              {canRemove ? 'Remove relay' : 'Your only relay'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Where a new relay's address is typed. */
function AddRelayDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Returns whether the address was taken; a refusal keeps the box up. */
  onAdd: (url: string) => boolean;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    if (onAdd(value)) {
      setValue('');
      onOpenChange(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setValue('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-sm rounded-3xl">
        <DialogHeader>
          <DialogTitle className="text-left text-xl">Add relay</DialogTitle>
          <DialogDescription className="text-left text-base">
            The address of a Nostr relay. The scheme is filled in for you.
          </DialogDescription>
        </DialogHeader>

        <Label htmlFor="new-relay" className="sr-only">
          Relay address
        </Label>
        <Input
          id="new-relay"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="relay.example.com"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          className="h-12 rounded-xl text-base"
        />

        <DialogFooter>
          <Button
            onClick={submit}
            disabled={!value.trim()}
            className="h-11 rounded-full px-6 text-base"
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything about Tenna itself, rather than about one of the apps on it.
 *
 * Drawn as the device's own Settings is, for the same reason the App info
 * screen is drawn as the device's App info: Tenna is a home screen, and the
 * screens a home screen puts up should be the ones the person already knows.
 * So it is a page with a back arrow, an account at the top where the system
 * puts one, and the rest in filled groups a thumb can land on.
 *
 * Opaque, unlike the wall and a publisher's page: a theme's wallpaper is the
 * picture behind the apps, and this is the screen where the machinery under
 * them is shown. The theme's own colours are still what it is drawn in.
 */
export function SettingsPage() {
  useSeoMeta({
    title: 'Settings — Tenna',
    description: 'Your account, your relays, and the version of Tenna you are running.',
  });

  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  const { config, updateConfig } = useAppContext();
  const { currentUser, isLoading, removeLogin } = useLoggedInAccounts();
  const { mutate: publishEvent } = useNostrPublish();
  const version = useAppVersion();

  const [authOpen, setAuthOpen] = useState(false);
  const [addingRelay, setAddingRelay] = useState(false);
  const [editingRelay, setEditingRelay] = useState<string | null>(null);

  const relays = config.relayMetadata.relays;
  const editing = relays.find((relay) => relay.url === editingRelay);

  // While the metadata query is in flight and there is no name yet, nothing is
  // shown rather than a generated animal name that changes a moment later.
  const pending = isLoading && !currentUser?.metadata.name;
  const name = currentUser?.metadata.display_name || currentUser?.metadata.name || null;

  const fullNpub = useMemo(() => {
    if (!currentUser) return undefined;
    try {
      return nip19.npubEncode(currentUser.pubkey);
    } catch {
      return undefined;
    }
  }, [currentUser]);

  const npub = fullNpub ? middleEllipsis(fullNpub, 21) : undefined;

  // Back to wherever this was opened from, which is nearly always the wall. A
  // page opened cold has nothing behind it and should still land somewhere
  // rather than leaving the app.
  const goBack = () => {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  /**
   * Write a new relay list, and tell the network about it.
   *
   * The stored timestamp moves with every edit, because `NostrSync` treats the
   * config as stale whenever the relay's copy is newer — without this, an edit
   * made here would be overwritten by the kind 10002 it was about to replace.
   */
  const saveRelays = (next: Relay[], published: number) => {
    updateConfig((current) => ({
      ...current,
      relayMetadata: { relays: next, updatedAt: published },
    }));

    if (!currentUser) return;

    const tags = next
      .filter((relay) => relay.read || relay.write)
      .map((relay) =>
        relay.read && relay.write
          ? ['r', relay.url]
          : ['r', relay.url, relay.read ? 'read' : 'write'],
      );

    publishEvent(
      { kind: 10002, content: '', tags, created_at: published },
      {
        onError: () => {
          notificationError();
          toast({
            title: 'Saved here, but not published',
            description: 'Your relay list is set on this device. Nostr has the old one.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  // A second apart from anything already stored, so the edit is unambiguously
  // the newer of the two wherever the comparison is made.
  const stamp = () => Math.floor(Date.now() / 1000);

  const handleAddRelay = (input: string): boolean => {
    const url = normalizeRelayUrl(input);

    if (!isRelayUrl(url)) {
      notificationError();
      toast({
        title: 'Not a relay address',
        description: 'Try something like relay.example.com.',
        variant: 'destructive',
      });
      return false;
    }

    if (relays.some((relay) => relay.url === url)) {
      notificationError();
      toast({
        title: 'Already on the list',
        description: prettyRelay(url),
        variant: 'destructive',
      });
      return false;
    }

    impactLight();
    saveRelays([...relays, { url, read: true, write: true }], stamp());
    return true;
  };

  const handleToggleRelay = (url: string, field: 'read' | 'write', value: boolean) => {
    impactLight();
    saveRelays(
      relays.map((relay) => (relay.url === url ? { ...relay, [field]: value } : relay)),
      stamp(),
    );
  };

  const handleRemoveRelay = (url: string) => {
    impactLight();
    setEditingRelay(null);
    saveRelays(
      relays.filter((relay) => relay.url !== url),
      stamp(),
    );
  };

  return (
    // Opaque, and a system screen does not offer to select its own labels —
    // holding a finger on one would otherwise raise the WebView's Copy/Share
    // bar, which is the one thing that gives away that this is a page.
    <main className="relative min-h-screen select-none bg-card text-card-foreground">
      {/* Stays put while the page scrolls, so the way back is never off the
          top of a long relay list. */}
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-card/95 px-4 pb-3 pt-safe-offset-3 backdrop-blur">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/90 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeft aria-hidden="true" className="size-6" />
        </button>

        <h1 className="text-xl font-semibold">Settings</h1>
      </header>

      <div className="mx-auto max-w-2xl">
        {/* Whose phone this is, where the system puts it: at the top, above
            everything the account is the answer to. */}
        <section className="flex flex-col items-center gap-4 px-6 pb-8 pt-2">
          {pending ? (
            <Skeleton className="size-20 rounded-full bg-foreground/10" />
          ) : (
            <Avatar className="size-20">
              <AvatarImage src={currentUser?.metadata.picture} alt="" />
              <AvatarFallback className="bg-foreground/10 text-2xl text-foreground/80">
                {name ? name.slice(0, 1).toUpperCase() : <UserRound className="size-8" />}
              </AvatarFallback>
            </Avatar>
          )}

          {pending ? (
            <Skeleton className="h-9 w-48 bg-foreground/10" />
          ) : (
            <h2 className="w-full break-words text-center text-3xl font-semibold leading-tight">
              {currentUser ? (name ?? 'Anonymous') : 'Not signed in'}
            </h2>
          )}

          {/* The key, under whatever the profile called itself. A name is a
              claim anybody could make and reuse; this is the thing that was
              signed. */}
          {currentUser && npub && (
            <p
              title={fullNpub}
              className="-mt-2 max-w-full truncate font-mono text-sm text-foreground/65"
            >
              {npub}
            </p>
          )}

          {!currentUser && (
            <p className="-mt-2 max-w-sm text-center text-base text-foreground/65">
              Tenna holds your key so the sites on it never have to. Nothing here
              needs one, but signing in is what lets a site ask.
            </p>
          )}

          <div className="flex flex-wrap items-start justify-center gap-6 pt-6">
            {currentUser && fullNpub && (
              <SettingsAction icon={UserRound} label="Profile" to={`/${fullNpub}`} />
            )}

            <SettingsAction
              icon={currentUser ? UserPlus : LogIn}
              label={currentUser ? 'Add account' : 'Sign in'}
              onClick={() => setAuthOpen(true)}
            />

            {currentUser && (
              <SettingsAction
                icon={LogOut}
                label="Sign out"
                onClick={() => removeLogin(currentUser.id)}
                destructive
              />
            )}
          </div>
        </section>

        <div className="flex flex-col gap-2 px-4 pb-safe-offset-8">
          <section className={GROUP}>
            <div className="flex items-center justify-between gap-3">
              <h3 className={GROUP_TITLE}>Relays</h3>

              <button
                type="button"
                onClick={() => setAddingRelay(true)}
                aria-label="Add relay"
                title="Add relay"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/70 outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Plus aria-hidden="true" className="size-5" />
              </button>
            </div>

            <p className="mt-1 text-base text-foreground/55">
              Where Tenna looks for the sites on your wall, and for the people who
              publish them.
            </p>

            <ul className="-mx-2 mt-2 divide-y divide-border">
              {relays.map((relay) => (
                <li key={relay.url}>
                  <button
                    type="button"
                    onClick={() => setEditingRelay(relay.url)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-base text-foreground/90">
                        {prettyRelay(relay.url)}
                      </span>
                      <span className="block truncate text-sm text-foreground/50">
                        {relayModeLabel(relay)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {/* Said once, at the bottom, rather than beside every change: a
                list edited while signed out is this device's own, and there is
                no key to sign the kind 10002 that would tell anyone else. */}
            {!currentUser && (
              <p className="mt-3 text-sm text-foreground/45">
                Signed out, so this list stays on this device. Sign in and Tenna
                publishes it.
              </p>
            )}
          </section>

          {/* Above About, which is deliberately last because it is the static
              one. This is user state, like the relay list it sits under. */}
          <section className={GROUP}>
            <h3 className={GROUP_TITLE}>Apps</h3>

            <p className="mt-1 text-base text-foreground/55">
              Tenna can sign for other apps on this phone, and for apps running somewhere
              else that you connect to it.
            </p>

            <ul className="-mx-2 mt-2 divide-y divide-border">
              <li>
                <Link
                  to="/settings/apps"
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-3 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="text-base text-foreground/90">Authorized apps</span>
                  <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-foreground/40" />
                </Link>
              </li>
            </ul>
          </section>

          <section className={GROUP}>
            <h3 className={GROUP_TITLE}>About</h3>

            <ul className="-mx-2 mt-1 divide-y divide-border">
              {version && (
                <li className="flex items-center justify-between gap-3 px-2 py-3">
                  <span className="text-base text-foreground/90">Version</span>
                  <span className="shrink-0 font-mono text-sm text-foreground/55">
                    {version.version} ({version.build})
                  </span>
                </li>
              )}

              <li className="flex items-center justify-between gap-3 px-2 py-3">
                <span className="text-base text-foreground/90">License</span>
                <span className="shrink-0 text-sm text-foreground/55">
                  AGPL-3.0-or-later
                </span>
              </li>

              <li>
                {/* The one row that leaves Tenna. It goes to whatever the
                    device uses for the web, which on Android is a browser
                    rather than this WebView. */}
                <a
                  href={REPOSITORY}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-3 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span className="text-base text-foreground/90">Source code</span>
                  <span className="shrink-0 text-sm text-foreground/55">nostrhub.io</span>
                </a>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <RelayDialog
        relay={editing}
        canRemove={relays.length > 1}
        onClose={() => setEditingRelay(null)}
        onToggle={(field, value) => editing && handleToggleRelay(editing.url, field, value)}
        onRemove={() => editing && handleRemoveRelay(editing.url)}
      />

      <AddRelayDialog
        open={addingRelay}
        onOpenChange={setAddingRelay}
        onAdd={handleAddRelay}
      />

      <AuthDialog isOpen={authOpen} onClose={() => setAuthOpen(false)} />
    </main>
  );
}

export default SettingsPage;
