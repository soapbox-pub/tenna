import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import type { NostrEvent } from '@nostrify/nostrify';
import { ArrowLeft, Check, ExternalLink, SquarePlus, Trash2, X } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';

import { TileArtwork, TileFrame } from '@/components/Tile';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteAllowance } from '@/hooks/useNsiteAllowance';
import type { NsiteApp } from '@/hooks/useNsiteApp';
import type { UseNsitePinResult } from '@/hooks/useNsitePin';
import { useToast } from '@/hooks/useToast';
import { impactMedium, notificationError } from '@/lib/haptics';
import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import { NativeApps, supportsNativeApps } from '@/lib/nativeAppsPlugin';
import {
  clearNsitePermissions,
  getPermissionLabel,
  removeNsitePermission,
  type NsitePermission,
} from '@/lib/nsitePermissions';
import { getNsiteSubdomain, NSITE_SNAPSHOT_KIND } from '@/lib/nsiteSubdomain';
import { cn } from '@/lib/utils';

interface NsiteAppInfoProps {
  /** The NIP-5A manifest event for the site being described. */
  event: NostrEvent;
  /** What the site is called on the wall. */
  name: string;
  /** The site's own artwork, as resolved for its tile. */
  app?: NsiteApp;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tune the site in, the way pressing its tile would. */
  onOpen?: () => void;
  /** Putting the site on the device's own home screen, where that is offered. */
  pinning?: UseNsitePinResult;
  /** Take the site off the wall, for the ones the user put there. */
  onRemove?: () => void;
}

/**
 * Take the middle out of a string too long to show whole.
 *
 * The middle, because both ends of an nsite id carry meaning — the front is
 * what tells two sites apart at a glance, and the tail is the site's own name.
 * A trailing ellipsis would throw away the half that reads.
 */
function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/**
 * One of the round buttons under the app's name.
 *
 * The verbs an app answers to, drawn the way the system draws them: a circle
 * with the mark in it and the word underneath, sized for a thumb. A button
 * that has already been pressed to its end — a site that is on the home screen
 * — is dimmed rather than removed, so the row does not reshuffle underneath
 * the finger that just used it.
 */
function InfoAction({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // Wider than the circle it holds, so a two-word verb stays on one line
      // and the row of labels keeps a single baseline.
      className="group flex w-24 shrink-0 flex-col items-center gap-2 outline-none disabled:cursor-default"
    >
      <span
        className={cn(
          'flex size-16 items-center justify-center rounded-full transition-colors',
          'group-focus-visible:ring-2 group-focus-visible:ring-[#FEF960] group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-[#1B080C]',
          destructive
            ? 'bg-[#F96C91]/15 text-[#F96C91] group-hover:bg-[#F96C91]/25'
            : 'bg-white/10 text-white group-hover:bg-white/15',
          disabled && 'bg-white/5 text-white/30 group-hover:bg-white/5',
        )}
      >
        <Icon aria-hidden={true} className="size-6" />
      </span>
      <span
        className={cn(
          'whitespace-nowrap text-center text-sm font-medium leading-tight',
          disabled ? 'text-white/40' : 'text-white/90',
        )}
      >
        {label}
      </span>
    </button>
  );
}

/** How long a finger has to rest on an address before it is taken. */
const LONG_PRESS_MS = 500;

/**
 * One of the site's addresses, with the two things anybody wants from one.
 *
 * Holding it copies it, which is what a long press on a value means on this
 * device — the system's own screens have offered it for years, and it is the
 * gesture a person already makes at a string too long to read. The press is
 * timed here rather than left to the WebView's selection bar, since a page
 * imitating a system screen should not answer with the browser's furniture.
 * A tap copies too: a long press is not a gesture a keyboard can make, and a
 * row that only answers to one is a row some people cannot use.
 *
 * The button beside it hands the address to the device, where another app may
 * claim the scheme.
 */
function AddressRow({
  uri,
  onOpen,
}: {
  uri: string;
  onOpen: (uri: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const copy = () => {
    void navigator.clipboard?.writeText(uri).then(
      () => setCopied(true),
      () => {
        // No clipboard to write to. The address is on screen either way.
      },
    );
  };

  // Back to the address after a moment, so the next press has something to
  // confirm again.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const hold = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      impactMedium();
      copy();
    }, LONG_PRESS_MS);
  };

  const release = () => clearTimeout(timer.current);

  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        onClick={copy}
        onPointerDown={hold}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        // A finger that has started to scroll the page is no longer holding
        // this.
        onPointerMove={release}
        aria-label={`Copy ${uri}`}
        className="min-w-0 flex-1 truncate rounded-lg px-2 py-3 text-left font-mono text-xs text-white/70 outline-none transition-colors hover:bg-white/5 hover:text-white/90 focus-visible:ring-2 focus-visible:ring-[#FEF960]"
      >
        {copied ? 'Copied' : middleEllipsis(uri, 34)}
      </button>

      <button
        type="button"
        onClick={() => onOpen(uri)}
        aria-label={`Open ${uri}`}
        title="Open"
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/50 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-[#FEF960]"
      >
        <ExternalLink aria-hidden="true" className="size-5" />
      </button>
    </li>
  );
}

/**
 * What an app on the wall has been given, and how to take it back.
 *
 * Drawn as the device's own App info screen is, because that is the screen
 * this one stands in for: a page rather than a card, the icon large and the
 * name under it, the verbs as a row of round buttons, and everything else in
 * filled rows a thumb can land on. A person arriving here from a long press
 * has just come from the launcher's version of this, and the two should not
 * feel like different operating systems.
 *
 * This is the only place permissions are shown. A site never carries a badge
 * of its own: a control floating over someone else's page is either ignored or
 * in the way, and a decision about what an app may do with your identity
 * belongs where the app is listed rather than inside it — the same as every
 * other app on every other home screen.
 *
 * The prompt is what appears in the site itself, and only when the site asks
 * for something.
 */
export function NsiteAppInfo({
  event,
  name,
  app,
  open,
  onOpenChange,
  onOpen,
  pinning,
  onRemove,
}: NsiteAppInfoProps) {
  const { user } = useCurrentUser();
  const { toast } = useToast();

  const siteId = useMemo(() => getNsiteSubdomain(event), [event]);

  /**
   * The site's two addresses: the event that describes it, and the site.
   *
   * A snapshot is a regular event and is pointed at by its id; a root or named
   * site is replaceable and is pointed at by what addresses it, so that the
   * link keeps meaning the site rather than one version of it.
   */
  const addresses = useMemo(() => {
    const list: string[] = [];

    try {
      if (event.kind === NSITE_SNAPSHOT_KIND) {
        list.push(`nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind })}`);
      } else {
        const identifier = event.tags.find(([n]) => n === 'd')?.[1] ?? '';
        list.push(`nostr:${nip19.naddrEncode({ kind: event.kind, pubkey: event.pubkey, identifier })}`);
      }
    } catch {
      // A manifest that cannot be addressed still has a site behind it.
    }

    list.push(`nsite://${siteId}`);
    return list;
  }, [event, siteId]);
  const allowance = useNsiteAllowance(siteId, user?.pubkey);
  const permissions = allowance?.permissions ?? [];
  const hasPermissions = permissions.length > 0;

  // Taking back "send notifications" has to reach further than the stored
  // decision: the subscriptions the site set are on disk on the native side,
  // and the push service would go on listening for them.
  const forgetSubscriptions = () => {
    if (!supportsNappPush()) return;
    void NappPush.set({ siteId, label: name, subscriptions: '[]' }).catch(() => {
      // Left as they were; the next set() from the site prompts again.
    });
  };

  const handleRemove = (perm: NsitePermission) => {
    if (!user) return;
    removeNsitePermission(siteId, user.pubkey, perm.type, perm.kind);
    if (perm.type === 'push') forgetSubscriptions();
  };

  const handleClearAll = () => {
    if (!user) return;
    const hadPush = permissions.some((perm) => perm.type === 'push');
    clearNsitePermissions(siteId, user.pubkey);
    if (hadPush) forgetSubscriptions();
  };

  /**
   * Hand an address to the device.
   *
   * Nothing here registers `nostr:` or `nsite://` itself, so this is a
   * question for whatever else is installed — and one that often has no
   * answer, which is why the answer is waited for and said out loud.
   */
  const handleOpenUri = (uri: string) => {
    const scheme = uri.split(':')[0];

    if (!supportsNativeApps()) {
      // No plugin to ask. The WebView hands an unknown scheme to the OS on
      // navigation, and says nothing either way.
      window.location.href = uri;
      return;
    }

    void NativeApps.openUri({ uri })
      .then(({ opened }) => {
        if (opened) return;
        notificationError();
        toast({
          title: `Nothing here opens ${scheme}: links`,
          description: 'Install an app that handles them and try again.',
          variant: 'destructive',
        });
      })
      .catch(() => {
        notificationError();
        toast({ title: 'Could not open that address', variant: 'destructive' });
      });
  };

  // Back is how a screen like this one is left. Nothing on the wall behind it
  // claims the gesture, so without this it reaches the system and closes
  // Tenna outright — on a page imitating a system page, the one wrong answer.
  // Radix answers Escape, which is the same gesture on a keyboard and not one
  // anybody makes here.
  useEffect(() => {
    if (!open) return;
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', () => onOpenChange(false))
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {
        // No native shell to ask. On the web the back arrow is the way out.
      });

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [open, onOpenChange]);

  // Opening the site and taking it off the wall both leave nothing here worth
  // looking at, so the screen goes with them. Pinning does not: the system
  // puts its own question up, and the answer comes back to this screen.
  const leaveAnd = (act: () => void) => () => {
    onOpenChange(false);
    act();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Nothing here describes the app in a sentence; the screen is its name
        // and a set of controls.
        aria-describedby={undefined}
        // The back arrow is the way out, as it is on the screen this imitates.
        showCloseButton={false}
        className={cn(
          // A page, not a card: the whole screen, square corners, no border,
          // and it arrives from the bottom edge rather than growing out of the
          // middle.
          'inset-0 max-h-none w-full max-w-none translate-x-0 translate-y-0 sm:max-w-none',
          'flex flex-col gap-0 overflow-y-auto overscroll-contain rounded-none border-0 p-0',
          'bg-[#1B080C] text-white',
          // A system screen does not offer to select its own labels. Without
          // this, holding a finger anywhere on the page raises the WebView's
          // Copy/Share/Select all bar over it, which is the one thing that
          // would give away that this is a page and not a screen. The address
          // is the only text worth taking, and it has a button that copies it.
          'select-none',
          'data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100',
          'data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4',
        )}
      >
        {/* Stays put while the page scrolls, so the way back is never off the
            top of a long permission list. */}
        <header className="sticky top-0 z-10 flex items-center gap-3 bg-[#1B080C]/95 px-4 pb-3 pt-safe-offset-3 backdrop-blur">
          <DialogClose
            aria-label="Back"
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#FEF960]"
          >
            <ArrowLeft aria-hidden="true" className="size-6" />
          </DialogClose>

          <DialogTitle className="text-xl font-semibold">App info</DialogTitle>
        </header>

        {/* The same artwork the wall draws, at the size the system's own info
            screen draws an icon. */}
        <div className="flex flex-col items-center gap-4 px-6 pb-8 pt-2">
          <div className="w-20">
            <TileFrame>
              <TileArtwork
                name={name}
                iconUrl={app?.iconUrl}
                fit={app?.fit}
                background={app?.background}
              />
            </TileFrame>
          </div>

          <h2 className="max-w-full break-words text-center text-3xl font-semibold leading-tight">
            {name}
          </h2>

          <div className="flex flex-wrap items-start justify-center gap-6 pt-2">
            {onOpen && (
              <InfoAction icon={ExternalLink} label="Open" onClick={leaveAnd(onOpen)} />
            )}
            {/* One label for both states. A button that reads the same either
                way, dimmed and ticked once it is done, says "already there"
                without the row's words changing under the finger. */}
            {pinning?.available && (
              <InfoAction
                icon={pinning.pinned ? Check : SquarePlus}
                label="Home screen"
                onClick={pinning.pin}
                disabled={pinning.pinned}
              />
            )}
            {onRemove && (
              <InfoAction
                icon={Trash2}
                label="Remove"
                onClick={leaveAnd(onRemove)}
                destructive
              />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2 px-4 pb-safe-offset-8">
          <section className="rounded-2xl bg-white/[0.06] px-5 py-4">
            <div className="flex min-h-9 items-center justify-between gap-3">
              <h3 className="text-lg font-medium text-white">Permissions</h3>
              {hasPermissions && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 shrink-0 px-3 text-sm text-[#F96C91] hover:bg-white/10 hover:text-[#F96C91]"
                  onClick={handleClearAll}
                >
                  Revoke all
                </Button>
              )}
            </div>

            {/* A summary line where the system puts one, and the controls
                themselves where there is something to control. */}
            {!user ? (
              <p className="mt-1 text-base text-white/55">
                Sign in to see what this app may do with your identity.
              </p>
            ) : !hasPermissions ? (
              <p className="mt-1 text-base text-white/55">
                Nothing granted yet. What you allow this app to do will be listed here.
              </p>
            ) : (
              <ul className="-mx-2 mt-2 divide-y divide-white/10">
                {permissions.map((perm) => (
                  <li
                    key={`${perm.type}-${perm.kind}`}
                    className="flex items-center gap-3 px-2 py-3"
                  >
                    <span className="min-w-0 flex-1 truncate text-base text-white/90">
                      {getPermissionLabel(perm.type, perm.kind)}
                    </span>

                    <button
                      type="button"
                      onClick={() => handleRemove(perm)}
                      aria-label={`Revoke ${getPermissionLabel(perm.type, perm.kind)}`}
                      title="Revoke"
                      className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/50 outline-none transition-colors hover:bg-white/10 hover:text-[#F96C91] focus-visible:ring-2 focus-visible:ring-[#FEF960]"
                    >
                      <X className="size-5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Where a system screen keeps the package name and version: what
              the thing is called by everything that is not a person. Cut
              through the middle rather than wrapped, because whole they would
              be four lines of base32 and the ends are the parts that mean
              anything — the scheme at the front, and at the back the tail that
              names the site. */}
          <section className="rounded-2xl bg-white/[0.06] px-5 py-4">
            <h3 className="flex min-h-9 items-center text-lg font-medium text-white">
              Addresses
            </h3>

            <ul className="-mx-2 mt-1 divide-y divide-white/10">
              {addresses.map((uri) => (
                <AddressRow key={uri} uri={uri} onOpen={handleOpenUri} />
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
