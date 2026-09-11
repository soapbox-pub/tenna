import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { useCallback, useEffect, useState } from 'react';
import { Bell, Camera, Check, KeyRound, Lock, Mic, Pen, TriangleAlert, X } from 'lucide-react';

import { TileArtwork } from '@/components/Tile';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Label } from '@/components/ui/label';
import { getKindLabel, getSensitiveKindReason } from '@/lib/kindLabels';
import type { NsiteIdentity } from '@/hooks/useNsiteIdentity';
import type { NsitePromptState, NsitePromptDecision } from '@/hooks/useNsiteSignerRpc';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface NsitePermissionPromptProps {
  /** What the site asking is called, and what it looks like. */
  identity: NsiteIdentity;
  /** The pending prompt state from useNsiteSignerRpc. */
  prompt: NsitePromptState;
  /** Callback to resolve the prompt. */
  onResolve: (decision: NsitePromptDecision) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPromptIcon(type: NsitePromptState['type']) {
  switch (type) {
    case 'signEvent':
      return <Pen className="size-5 text-amber-500" />;
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return <Lock className="size-5 text-blue-500" />;
    case 'nip04.decrypt':
    case 'nip44.decrypt':
      return <KeyRound className="size-5 text-violet-500" />;
    case 'push':
      return <Bell className="size-5 text-emerald-500" />;
    case 'camera':
      return <Camera className="size-5 text-rose-500" />;
    case 'microphone':
      return <Mic className="size-5 text-rose-500" />;
  }
}

function getPromptTitle(type: NsitePromptState['type'], kind: number | null): string {
  switch (type) {
    case 'signEvent':
      return kind !== null
        ? `Sign: ${getKindLabel(kind)}`
        : 'Sign event';
    case 'nip04.encrypt':
      return 'Encrypt message (NIP-04)';
    case 'nip04.decrypt':
      return 'Decrypt message (NIP-04)';
    case 'nip44.encrypt':
      return 'Encrypt message (NIP-44)';
    case 'nip44.decrypt':
      return 'Decrypt message (NIP-44)';
    case 'push':
      return 'Send notifications';
    case 'camera':
      return 'Use the camera';
    case 'microphone':
      return 'Use the microphone';
  }
}

function getPromptDescription(type: NsitePromptState['type']): string {
  switch (type) {
    case 'signEvent':
      return 'This app wants to sign a Nostr event on your behalf.';
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return 'This app wants to encrypt a message using your keys.';
    case 'nip04.decrypt':
    case 'nip44.decrypt':
      return 'This app wants to decrypt a message using your keys.';
    case 'push':
      return 'This app wants Tenna to watch relays for it and notify you of new events, even while it is closed.';
    case 'camera':
      return 'This app wants to see through your camera while you are using it.';
    case 'microphone':
      return 'This app wants to hear through your microphone while you are using it.';
  }
}

/** Truncate a string to a maximum character length. */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\u2026';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * The sheet an nsite's request for permission comes up in.
 *
 * A bottom sheet rather than a dialog in the middle, because of where the
 * question comes from. The site is still there behind it — really there in an
 * iframe, a picture of itself in a native window — and a sheet rising from the
 * bottom edge over the app that asked reads as that app being interrupted,
 * where a floating card reads as Tenna having replaced it. It is the same
 * shape Android's own signer prompts use, for the same reason.
 *
 * It is also the shape that puts the two buttons under the thumb. The decision
 * is at the bottom of a sheet that starts at the bottom; nothing about it
 * requires reaching the top of the screen.
 *
 * Dragging it down is a no. A dismissal is never an approval, and never a
 * remembered one either: a gesture that got away from someone must not be able
 * to write a decision the site gets to keep.
 */
export function NsitePermissionPrompt({
  identity,
  prompt,
  onResolve,
}: NsitePermissionPromptProps) {
  const [remember, setRemember] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const handleAllow = () => onResolve({ allowed: true, remember });
  const handleDeny = () => onResolve({ allowed: false, remember });

  // Backing out of the sheet, however it is done: dragged down, escaped, or —
  // on Android — the back gesture, which never reaches vaul. A no, and not a
  // remembered one; see the note on the component.
  const handleDismiss = useCallback(
    () => onResolve({ allowed: false, remember: false }),
    [onResolve],
  );

  // The frame under the sheet stands aside for this one while it is up, so the
  // gesture lands here and nowhere else.
  useEffect(() => {
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', handleDismiss)
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [handleDismiss]);

  const icon = getPromptIcon(prompt.type);
  const title = getPromptTitle(prompt.type, prompt.kind);
  const description = getPromptDescription(prompt.type);

  // For signEvent, show a preview of the event content.
  const eventContent = prompt.event?.content as string | undefined;
  const eventJson = prompt.event ? JSON.stringify(prompt.event, null, 2) : null;

  // The tags, which are where a signing request keeps the things a reader
  // would actually want to know — who is addressed, what is referenced, what
  // is being replaced — and which used to be visible only by opening the raw
  // JSON. Content is the part a site writes for a person; tags are the part it
  // writes for a protocol, and it is the protocol doing the surprising things.
  const eventTags = Array.isArray(prompt.event?.tags)
    ? (prompt.event.tags as unknown[]).filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((part) => typeof part === 'string'),
      )
    : [];

  // Some kinds are not a post. Signing one rewrites who the user is, what they
  // can prove, or what they still have — so the reason is spelled out, and the
  // decision cannot be made once and reused. See `SENSITIVE_KINDS`.
  const sensitive =
    prompt.type === 'signEvent' && prompt.kind !== null
      ? getSensitiveKindReason(prompt.kind)
      : null;

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) handleDismiss();
      }}
    >
      {/* Tall enough to be a sheet rather than a toast even when the question
          is one line. The cap comes from the drawer's own styles, and the gap
          it leaves at the top is the point: what shows through it is the app
          that asked, still there, waiting on an answer. */}
      <DrawerContent className="mx-auto min-h-[55svh] w-full max-w-lg">
        <DrawerHeader className="flex flex-row items-center gap-3 pt-2">
          {/* The site's own tile, at the size a sheet's header wants one.
              The wall's drawing rather than a picture in a circle, because a
              person answering this has to recognise what is asking, and what
              they know it by is the tile they pressed. A site that ships no
              artwork gets the same initial on the same colour it has there,
              which is still its mark and not a warning sign. */}
          <span aria-hidden="true" className="relative block size-10 shrink-0">
            <TileArtwork
              name={identity.name}
              iconUrl={identity.iconUrl}
              fit={identity.fit}
              background={identity.background}
            />
          </span>
          {/* Left-aligned against the drawer's own centring, which is for a
              sheet whose header is a heading. This one is an identity beside
              an icon, and it reads off the icon. */}
          <div className="min-w-0 flex-1 text-left">
            <DrawerTitle className="truncate text-base">{identity.name}</DrawerTitle>
            <DrawerDescription className="text-xs">Permission request</DrawerDescription>
          </div>
        </DrawerHeader>

        {/* The question, and everything the user might want to see before
            answering it. Scrolls on its own so the buttons never move. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-2">
          <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-3">
            <div className="mt-0.5 shrink-0">{icon}</div>
            <div className="min-w-0">
              <p className="text-sm font-medium">{title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            </div>
          </div>

          {/* What this kind costs, when it costs more than a post. Above the
              content, because it is the thing to read before the thing the
              site wrote to be read. */}
          {sensitive && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <TriangleAlert
                className="mt-0.5 size-5 shrink-0 text-amber-500"
                aria-hidden="true"
              />
              <p className="min-w-0 text-xs leading-relaxed">{sensitive}</p>
            </div>
          )}

          {/* Event content preview (signEvent only) */}
          {prompt.type === 'signEvent' && eventContent && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-1 text-xs text-muted-foreground">Content</p>
              <p className="whitespace-pre-wrap break-words text-sm">
                {truncate(eventContent, 280)}
              </p>
            </div>
          )}

          {/* The tags, plainly. One row each, name apart from value, so that
              a `p` naming a stranger or an `e` naming somebody else's note is
              readable without opening the JSON. */}
          {eventTags.length > 0 && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-1.5 text-xs text-muted-foreground">Tags</p>
              <ul className="space-y-1">
                {eventTags.slice(0, 12).map(([name, ...values], i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <span className="shrink-0 font-mono font-medium text-muted-foreground">
                      {truncate(name, 16)}
                    </span>
                    <span className="min-w-0 break-all font-mono">
                      {truncate(values.join(' '), 120)}
                    </span>
                  </li>
                ))}
              </ul>
              {eventTags.length > 12 && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  and {eventTags.length - 12} more
                </p>
              )}
            </div>
          )}

          {/* Raw event details (collapsible) */}
          {eventJson && (
            <Collapsible open={showDetails} onOpenChange={setShowDetails}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {showDetails ? 'Hide details' : 'Show details'}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                  {eventJson}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>

        <DrawerFooter className="gap-3 pb-safe-offset-4">
          {/* A remembered decision is a question answered once for every time
              it is asked again. That is a fair trade where the worst it buys
              is more of the same, and not where the event rewrites who the
              user is — so for those the offer is withdrawn rather than merely
              discouraged, and the site asks each time. */}
          {sensitive ? (
            <p className="text-xs text-muted-foreground">
              This one is asked every time.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <Checkbox
                id="nsite-remember"
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked === true)}
              />
              <Label
                htmlFor="nsite-remember"
                className="cursor-pointer select-none text-xs text-muted-foreground"
              >
                Remember for this site
              </Label>
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="lg"
              className="flex-1 gap-1.5"
              onClick={handleDeny}
            >
              <X className="size-4" />
              Deny
            </Button>
            <Button
              size="lg"
              className="flex-1 gap-1.5"
              onClick={handleAllow}
            >
              <Check className="size-4" />
              Allow
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
