import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import type { NostrEvent } from '@nostrify/nostrify';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ExternalLink, SquarePlus, Trash2, X } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';

import { NsiteEnvironment } from '@/components/NsiteEnvironment';
import { NsiteInfoPage, NsiteInfoRow } from '@/components/NsiteInfoPage';
import { TileArtwork, TileFrame } from '@/components/Tile';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteAllowance } from '@/hooks/useNsiteAllowance';
import { useNsiteBrowserAllowance } from '@/hooks/useNsiteBrowserAllowance';
import { useNsiteEnv } from '@/hooks/useNsiteEnv';
import type { NsiteApp } from '@/hooks/useNsiteApp';
import type { UseNsitePinResult } from '@/hooks/useNsitePin';
import { useToast } from '@/hooks/useToast';
import { impactLight, impactMedium, notificationError } from '@/lib/haptics';
import { NappPush, supportsNappPush, supportsPeriodicSync } from '@/lib/nappPushPlugin';
import { NativeApps, supportsNativeApps } from '@/lib/nativeAppsPlugin';
import {
  clearNsitePermissions,
  getPermissionLabel,
  removeNsitePermission,
  type NsitePermission,
} from '@/lib/nsitePermissions';
import {
  clearNsiteBrowserPermissions,
  getBrowserPermissionLabel,
  removeNsiteBrowserPermission,
  type NsiteBrowserPermission,
} from '@/lib/nsiteBrowserPermissions';
import { NsiteWebView, supportsNativeNsite } from '@/lib/nsiteNativePlugin';
import { requestNsiteOpen } from '@/lib/nsiteOpenRequest';
import { getNsiteSubdomain, NSITE_SNAPSHOT_KIND } from '@/lib/nsiteSubdomain';
import { isNsiteUrl, nsiteUrl } from '@/lib/nsiteUrl';
import { cn, middleEllipsis } from '@/lib/utils';

/** The screens one level in from App info. */
type InfoScreen = 'permissions' | 'storage' | 'environment' | 'addresses';

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
 * Who put the site out, under the site's name.
 *
 * Not a claim the site makes about itself: the manifest is signed, so the
 * publisher is the key behind that signature, and the face and name here are
 * only that key's own profile shown in its place. The key is always known —
 * the profile may not be, and a publisher who has never written one is still
 * named, by the npub cut short, rather than left blank.
 *
 * Pressing it goes to their page, which is the same question asked further:
 * whose is this, and what else is theirs. The screen closes on the way, since
 * this one is a page rather than a card and there would otherwise be a
 * full-screen dialog left sitting over the one it navigated to.
 */
function Publisher({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;

  // The profile is a small, quick thing to fetch and it sits between the app's
  // name and the row of buttons. A line that appeared late would push the
  // buttons down under a finger already reaching for them, so the space is
  // held from the start.
  if (author.isPending) {
    return (
      <div className="flex items-center gap-2" aria-hidden="true">
        <Skeleton className="size-6 rounded-full bg-foreground/10" />
        <Skeleton className="h-4 w-28 bg-foreground/10" />
      </div>
    );
  }

  const npub = (() => {
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return null;
    }
  })();

  const name = metadata?.display_name || metadata?.name || (npub ? middleEllipsis(npub, 15) : 'Unknown publisher');

  const face = (
    <>
      <Avatar size="sm" className="shrink-0">
        <AvatarImage src={metadata?.picture} alt="" />
        <AvatarFallback className="bg-foreground/10 text-foreground/80">
          {name.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      {/* Whole, however long. This is a page rather than a row: there is
          nothing after the name competing for the line, and a publisher cut
          short here is the one fact the screen exists to state. */}
      <span className="min-w-0 break-words text-base text-foreground/70">{name}</span>
    </>
  );

  // A key that won't encode has no page to go to, so it stays a label.
  if (!npub) {
    return <div className="flex max-w-full items-center gap-2">{face}</div>;
  }

  return (
    <DialogClose asChild>
      <Link
        to={`/${npub}`}
        title={`Everything published by ${name}`}
        className="-mx-2 flex max-w-full items-center gap-2 rounded-full px-2 py-1 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
      >
        {face}
      </Link>
    </DialogClose>
  );
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
          'group-focus-visible:ring-2 group-focus-visible:ring-primary group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card',
          destructive
            ? 'bg-destructive/15 text-destructive group-hover:bg-destructive/25'
            : 'bg-foreground/10 text-foreground group-hover:bg-foreground/15',
          disabled && 'bg-foreground/5 text-foreground/30 group-hover:bg-foreground/5',
        )}
      >
        <Icon aria-hidden={true} className="size-6" />
      </span>
      <span
        className={cn(
          'whitespace-nowrap text-center text-sm font-medium leading-tight',
          disabled ? 'text-foreground/40' : 'text-foreground/90',
        )}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * A size on disk the way the system's own App info writes one: decimal units,
 * as storage is sold and as the device's settings count it, with a single
 * decimal place once there is a unit big enough to need one.
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
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
        className="min-w-0 flex-1 truncate rounded-lg px-2 py-3 text-left font-mono text-xs text-foreground/70 outline-none transition-colors hover:bg-foreground/5 hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-primary"
      >
        {copied ? 'Copied' : middleEllipsis(uri, 34)}
      </button>

      <button
        type="button"
        onClick={() => onOpen(uri)}
        aria-label={`Open ${uri}`}
        title="Open"
        className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/50 outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
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

    list.push(nsiteUrl(siteId));
    return list;
  }, [event, siteId]);
  const allowance = useNsiteAllowance(siteId, user?.pubkey);
  const permissions = allowance?.permissions ?? [];

  // What the site may do with the device, as against with an identity. Keyed
  // by site rather than by pubkey, so there is an answer here for a
  // logged-out reader too. See `nsiteBrowserPermissions`.
  const browserAllowance = useNsiteBrowserAllowance(siteId);
  const browserPermissions = browserAllowance?.permissions ?? [];

  const hasPermissions = permissions.length > 0 || browserPermissions.length > 0;

  // What the row on App info says is behind it: the permissions themselves
  // when there are few enough to read on one line, a count when there are not.
  const permissionSummary = (() => {
    const labels = [
      ...browserPermissions.filter((perm) => perm.allowed).map((perm) => getBrowserPermissionLabel(perm.type)),
      ...permissions.map((perm) => getPermissionLabel(perm.type, perm.kind)),
    ];
    if (labels.length === 0) return 'No permissions granted';
    if (labels.length <= 2) return labels.join(' and ');
    return `${labels.length} permissions allowed`;
  })();

  // Taking back "send notifications" has to reach further than the stored
  // decision: the subscriptions the site set are on disk on the native side,
  // and the push service would go on listening for them.
  const forgetSubscriptions = () => {
    if (!supportsNappPush()) return;
    void NappPush.set({ siteId, label: name, subscriptions: '[]' }).catch(() => {
      // Left as they were; the next set() from the site prompts again.
    });
  };

  // The same for "refresh in the background": the tags are scheduled natively,
  // and would go on waking the site after the grant behind them was gone.
  const forgetPeriodicSync = () => {
    if (!supportsPeriodicSync()) return;
    void NappPush.periodicSyncClear({ siteId }).catch(() => {
      // Left scheduled; the next register() from the site prompts again.
    });
  };

  /**
   * Whether the user wants to hear from this site at all.
   *
   * A different question from the site's permission to send, and asked the
   * other way round: the permission is off until the site asks and is
   * granted, and this is on until somebody turns it off. So a site that has
   * never sent a notification still has a switch here, already on, and
   * turning it off now settles the matter before the site ever asks.
   *
   * The answer lives on the native side, where the listening is done — see
   * `NappMuted`. Undefined until it has been read, and drawn as a gap the
   * size of the switch rather than as a switch that flicks itself over a
   * moment after the screen opens.
   */
  const notifiable = supportsNappPush();
  const [muted, setMuted] = useState<boolean>();

  useEffect(() => {
    if (!notifiable) return;
    let disposed = false;

    NappPush.getMuted({ siteId })
      .then((result) => {
        if (!disposed) setMuted(result.muted);
      })
      .catch(() => {
        // Nothing stored, or nothing to ask. On is the answer either way.
        if (!disposed) setMuted(false);
      });

    return () => {
      disposed = true;
    };
  }, [notifiable, siteId]);

  const handleNotifications = (enabled: boolean) => {
    const previous = muted;
    impactLight();
    setMuted(!enabled);

    NappPush.setMuted({ siteId, muted: !enabled }).catch(() => {
      setMuted(previous);
      notificationError();
      toast({
        title: 'Could not change that',
        description: 'Notifications are as they were.',
        variant: 'destructive',
      });
    });
  };

  /**
   * What the site has stored on the device, and the way to wipe it.
   *
   * Only where the site has a WebView of its own: in the iframe the site's
   * storage belongs to a sandbox domain the page has no reach into, so there
   * is nothing to measure and nothing this screen could clear.
   *
   * Measured each time the screen opens rather than remembered, since the
   * site may have written a great deal since it was last looked at.
   */
  const measurable = supportsNativeNsite();
  const queryClient = useQueryClient();
  const usageKey = ['nsite-storage-usage', siteId];

  const usage = useQuery({
    queryKey: usageKey,
    queryFn: async () => (await NsiteWebView.getStorageUsage({ siteId })).bytes,
    enabled: open && measurable,
    staleTime: 0,
    gcTime: 0,
  });

  const [confirmingClear, setConfirmingClear] = useState(false);

  // The site's subscriptions and background syncs go too: they were set up
  // by the worker and the state being wiped, and a site starting fresh sets
  // them up again. Whether it may is a permission, and that stays.
  const clearStorage = useMutation({
    mutationFn: async () => {
      await NsiteWebView.clearStorage({ siteId });
      forgetSubscriptions();
      forgetPeriodicSync();
    },
    onSuccess: () => {
      impactMedium();
      toast({ title: 'Storage cleared', description: `${name} will start fresh the next time it opens.` });
    },
    onError: () => {
      notificationError();
      toast({
        title: 'Could not clear storage',
        description: 'Some of what it stored may still be there.',
        variant: 'destructive',
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: usageKey }),
  });

  // The variables the site reads as `window.ENV`. See `nsiteEnv`.
  const env = useNsiteEnv(siteId);

  // Which of the screens one level in is up, if any. App info itself is a
  // short list of doors; what is behind each is a page of its own.
  const [screen, setScreen] = useState<InfoScreen | null>(null);
  const screenProps = (which: InfoScreen) => ({
    open: screen === which,
    onOpenChange: (next: boolean) => setScreen(next ? which : null),
  });
  // Leaving App info leaves the screen inside it too, so the next visit
  // starts at the top rather than a level down.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setScreen(null);
  }

  const handleRemove = (perm: NsitePermission) => {
    if (!user) return;
    void removeNsitePermission(siteId, user.pubkey, perm.type, perm.kind);
  };

  const handleRemoveBrowser = (perm: NsiteBrowserPermission) => {
    removeNsiteBrowserPermission(siteId, perm.type);
    if (perm.type === 'notifications') forgetSubscriptions();
    if (perm.type === 'periodic-background-sync') forgetPeriodicSync();
  };

  const handleClearAll = () => {
    // Before the signer grants, and outside the check for one: taking back
    // what the site may do with the device is not a question about an account,
    // and a logged-out reader clearing this list still means it.
    const couldNotify = browserPermissions.some((perm) => perm.type === 'notifications');
    clearNsiteBrowserPermissions(siteId);
    if (couldNotify) forgetSubscriptions();
    forgetPeriodicSync();

    if (!user) return;
    void clearNsitePermissions(siteId, user.pubkey);
  };

  /**
   * Hand an address to the device.
   *
   * Nothing here registers `nostr:`, so that one is a question for whatever
   * else is installed — and one that often has no answer, which is why the
   * answer is waited for and said out loud.
   *
   * `nsite://` is the exception, because Tenna answers for it: going out to
   * the OS would come straight back in through Tenna's own intent filter, and
   * from inside a site's window it would surface the wall on the way. It is
   * taken here instead, and opens the site it names.
   */
  const handleOpenUri = (uri: string) => {
    const scheme = uri.split(':')[0];

    if (isNsiteUrl(uri)) {
      requestNsiteOpen(uri);
      onOpenChange(false);
      return;
    }

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
  // Back from the confirmation is back to the screen under it, and back from
  // a screen one level in is back to this one, not out of it.
  const confirmingRef = useRef(confirmingClear);
  const screenRef = useRef(screen);
  useEffect(() => {
    confirmingRef.current = confirmingClear;
    screenRef.current = screen;
  }, [confirmingClear, screen]);

  useEffect(() => {
    if (!open) return;
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', () => {
      if (confirmingRef.current) setConfirmingClear(false);
      else if (screenRef.current) setScreen(null);
      else onOpenChange(false);
    })
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
          'bg-card text-card-foreground',
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
        <header className="sticky top-0 z-10 flex items-center gap-3 bg-card/95 px-4 pb-3 pt-safe-offset-3 backdrop-blur">
          <DialogClose
            aria-label="Back"
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/90 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
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

          <h2 className="w-full break-words text-center text-3xl font-semibold leading-tight">
            {name}
          </h2>

          {/* Closer to the name than the gap would put it, because the two are
              one thing being read: what this is, and whose it is.

              Full width rather than left to size itself to its contents: a
              box that shrink-wraps a flex row containing wrappable text is
              measured at its narrowest, and the name inside breaks at every
              space it has with two thirds of the screen still empty beside
              it. Given the whole width, the row takes what it needs and the
              name wraps only when it truly cannot fit. */}
          <div className="-mt-2 flex w-full justify-center">
            <Publisher pubkey={event.pubkey} />
          </div>

          {/* Set well below the publisher: the icon, the name and whose it is
              are one block to be read, and the buttons are the answer to it.
              The gap is what separates the two. */}
          <div className="flex flex-wrap items-start justify-center gap-6 pt-6">
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

        <div className="px-4 pb-safe-offset-8">
          {/* One list of short rows, each a door to a page of its own, so the
              screen reads at a glance however much a site has been given. The
              switch is the exception: it is the one thing a person might have
              come here to change, and a page holding one switch is a detour. */}
          <div className="divide-y divide-border overflow-hidden rounded-2xl bg-foreground/[0.06]">
            {notifiable && (
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <Label
                  htmlFor="nsite-notifications"
                  className="min-w-0 text-lg font-medium text-foreground"
                >
                  Notifications
                </Label>

                {muted === undefined ? (
                  <Skeleton
                    aria-hidden="true"
                    className="h-7 w-12 shrink-0 rounded-full bg-foreground/10"
                  />
                ) : (
                  <Switch
                    id="nsite-notifications"
                    // The size a settings row wants, which only the component
                    // can give: a `h-7 w-12` here would be outranked and the
                    // thumb would sit outside the track. See `Switch`.
                    size="lg"
                    checked={!muted}
                    onCheckedChange={handleNotifications}
                    className={cn(
                      'shrink-0',
                      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-foreground/20',
                      'focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                      // The thumb is whatever reads on the accent it sits in,
                      // which the theme already had to decide — white on
                      // Tenna's yellow would not read, and neither would the
                      // page's own colour on somebody's pale primary.
                      '[&_[data-slot=switch-thumb]]:bg-primary-foreground!',
                    )}
                  />
                )}
              </div>
            )}

            <NsiteInfoRow
              label="Permissions"
              summary={permissionSummary}
              onClick={() => setScreen('permissions')}
            />

            {measurable && (
              <NsiteInfoRow
                label="Storage"
                summary={
                  usage.isPending
                    ? 'Measuring…'
                    : usage.data === undefined
                      ? 'Could not measure'
                      : usage.data > 0
                        ? `${formatBytes(usage.data)} used`
                        : 'Nothing stored'
                }
                onClick={() => setScreen('storage')}
              />
            )}

            <NsiteInfoRow
              label="Environment"
              summary={
                env.length === 0
                  ? 'No variables set'
                  : env.length === 1
                    ? '1 variable in window.ENV'
                    : `${env.length} variables in window.ENV`
              }
              onClick={() => setScreen('environment')}
            />

            <NsiteInfoRow
              label="Addresses"
              summary={addresses.length === 1 ? '1 address' : `${addresses.length} addresses`}
              onClick={() => setScreen('addresses')}
            />
          </div>
        </div>
      </DialogContent>

      <NsiteInfoPage title="Permissions" {...screenProps('permissions')}>
        {/* Both kinds of permission are listed together, because the
            distinction between them — one is about a key, the other about the
            device — is not one a person came here to think about. The
            device's are shown whether or not anyone is signed in, since that
            is what they are keyed on. */}
        <section className="rounded-2xl bg-foreground/[0.06] px-3 py-2">
          {!hasPermissions ? (
            <p className="px-2 py-3 text-base text-foreground/55">
              {user
                ? 'Nothing granted yet. What you allow this app to do will be listed here.'
                : 'Nothing granted yet. Sign in to also see what this app may do with your identity.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {browserPermissions.map((perm) => (
                <li key={perm.type} className="flex items-center gap-3 px-2 py-3">
                  <span className="min-w-0 flex-1 truncate text-base text-foreground/90">
                    {getBrowserPermissionLabel(perm.type)}
                    {!perm.allowed && (
                      <span className="text-foreground/45"> — refused</span>
                    )}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleRemoveBrowser(perm)}
                    aria-label={`Forget ${getBrowserPermissionLabel(perm.type)}`}
                    title="Forget"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/50 outline-none transition-colors hover:bg-foreground/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <X className="size-5" />
                  </button>
                </li>
              ))}

              {permissions.map((perm) => (
                <li
                  key={`${perm.type}-${perm.kind}`}
                  className="flex items-center gap-3 px-2 py-3"
                >
                  <span className="min-w-0 flex-1 truncate text-base text-foreground/90">
                    {getPermissionLabel(perm.type, perm.kind)}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleRemove(perm)}
                    aria-label={`Revoke ${getPermissionLabel(perm.type, perm.kind)}`}
                    title="Revoke"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/50 outline-none transition-colors hover:bg-foreground/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <X className="size-5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {hasPermissions && (
          <Button
            variant="ghost"
            className="mt-1 h-12 justify-start rounded-2xl px-5 text-base text-destructive hover:bg-foreground/10 hover:text-destructive"
            onClick={handleClearAll}
          >
            Revoke all
          </Button>
        )}
      </NsiteInfoPage>

      {/* Clearing is a question put again before it is done, unlike
          everything else here: a permission taken back can be given again,
          and what the site stored is gone for good — for some sites that is
          the only copy of a key. */}
      {measurable && (
        <NsiteInfoPage title="Storage" {...screenProps('storage')}>
          <section className="rounded-2xl bg-foreground/[0.06] px-5 py-4">
            {usage.isPending ? (
              <Skeleton aria-hidden="true" className="h-5 w-32 bg-foreground/10" />
            ) : (
              <p className="text-base text-foreground/70">
                {usage.data === undefined
                  ? 'Could not measure what this app has stored.'
                  : usage.data > 0
                    ? `${formatBytes(usage.data)} used on this device`
                    : 'Nothing stored on this device yet.'}
              </p>
            )}
          </section>

          {usage.data !== undefined && usage.data > 0 && (
            <Button
              variant="ghost"
              className="mt-1 h-12 justify-start rounded-2xl px-5 text-base text-destructive hover:bg-foreground/10 hover:text-destructive"
              onClick={() => setConfirmingClear(true)}
              disabled={clearStorage.isPending}
            >
              {clearStorage.isPending ? 'Clearing…' : 'Clear storage'}
            </Button>
          )}
        </NsiteInfoPage>
      )}

      <NsiteEnvironment siteId={siteId} name={name} {...screenProps('environment')} />

      {/* What the thing is called by everything that is not a person. Cut
          through the middle rather than wrapped, because whole they would be
          four lines of base32 and the ends are the parts that mean anything —
          the scheme at the front, and at the back the tail that names the
          site. */}
      <NsiteInfoPage title="Addresses" {...screenProps('addresses')}>
        <p className="px-1 pb-2 text-base text-foreground/60">
          Tap an address to copy it.
        </p>

        <section className="rounded-2xl bg-foreground/[0.06] px-3 py-2">
          <ul className="divide-y divide-border">
            {addresses.map((uri) => (
              <AddressRow key={uri} uri={uri} onOpen={handleOpenUri} />
            ))}
          </ul>
        </section>
      </NsiteInfoPage>

      <AlertDialog open={confirmingClear} onOpenChange={setConfirmingClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear {name}'s storage?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything this app has saved on this device will be deleted, including
              sign-ins, settings, offline data and its cache. If it is open, it will be
              closed. Its permissions stay as they are. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => clearStorage.mutate()}>
              Clear storage
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
