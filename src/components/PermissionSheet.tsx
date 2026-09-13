import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { Check, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

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
import {
  permissionDescription,
  permissionIcon,
  permissionTitle,
  type PermissionKind,
} from '@/lib/permissionLabels';
import { cn } from '@/lib/utils';

/** Truncate a string to a maximum character length. */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\u2026';
}

// ---------------------------------------------------------------------------
// What is being asked
// ---------------------------------------------------------------------------

/**
 * The question, and everything the user might want to see before answering it.
 *
 * Shared by every sheet because the answer depends on what is in the event and
 * not at all on who sent it. Scrolls on its own, so the buttons never move.
 */
export function PermissionDetails({
  type,
  kind,
  event,
}: {
  type: PermissionKind;
  kind: number | null;
  event?: Record<string, unknown> | null;
}) {
  const [showDetails, setShowDetails] = useState(false);

  const eventContent = event?.content as string | undefined;
  const eventJson = event ? JSON.stringify(event, null, 2) : null;

  // The tags, which are where a signing request keeps the things a reader
  // would actually want to know — who is addressed, what is referenced, what
  // is being replaced — and which used to be visible only by opening the raw
  // JSON. Content is the part an app writes for a person; tags are the part it
  // writes for a protocol, and it is the protocol doing the surprising things.
  const eventTags = Array.isArray(event?.tags)
    ? (event.tags as unknown[]).filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((part) => typeof part === 'string'),
      )
    : [];

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-2">
      <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-3">
        <div className="mt-0.5 shrink-0">{permissionIcon(type)}</div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{permissionTitle(type, kind)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{permissionDescription(type)}</p>
        </div>
      </div>

      {type === 'signEvent' && eventContent && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="mb-1 text-xs text-muted-foreground">Content</p>
          <p className="whitespace-pre-wrap break-words text-sm">{truncate(eventContent, 280)}</p>
        </div>
      )}

      {/* The tags, plainly. One row each, name apart from value, so that a `p`
          naming a stranger or an `e` naming somebody else's note is readable
          without opening the JSON. */}
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
  );
}

// ---------------------------------------------------------------------------
// The sheet itself
// ---------------------------------------------------------------------------

interface PermissionSheetProps {
  /** The asker's mark: a site's tile, an app's launcher icon. */
  artwork: ReactNode;
  /** What the asker is called. */
  name: string;
  /** The line under the name. */
  subtitle: string;
  children: ReactNode;
  /** The "remember this" checkbox, or nothing if it should not be offered. */
  remember?: {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  allowLabel?: string;
  denyLabel?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  /**
   * One button instead of two, for a sheet with nothing to decide.
   *
   * A dead end still has to be acknowledged and closed, but offering that as a
   * choice between Allow and Deny would be asking a question with one answer
   * written twice.
   */
  soleAction?: { label: string; onPress: () => void };
  /**
   * Fill the window rather than rising partway up it.
   *
   * A sheet leaves a gap above itself, and where the thing that asked is
   * behind that gap — a site in Tenna's own frame, dimmed but still there —
   * the gap is the whole point. Where it is not, the gap is a hole onto
   * nothing, and a question hanging over a void reads as something having
   * gone wrong rather than as the app underneath being interrupted.
   *
   * That is the case for another application's request, whose window cannot
   * be seen through however transparent everything in it is made — see
   * {@code SignerActivity.seeThrough}. So it fills the screen and looks like
   * a screen.
   */
  fill?: boolean;
  /** Backing out: dragged down, escaped, or the Android back gesture. */
  onDismiss: () => void;
}

/**
 * The sheet a request for permission comes up in.
 *
 * A bottom sheet rather than a dialog in the middle, because of where the
 * question comes from. Something was being used and has been interrupted by a
 * question about it, and a sheet rising from the bottom edge reads as exactly
 * that, where a floating card reads as Tenna having replaced whatever was
 * there. It is the same shape Android's own permission prompts use, for the
 * same reason.
 *
 * Where the thing that asked is genuinely behind the sheet — a site in Tenna's
 * own frame — the gap above it is left open and the site shows through,
 * dimmed. Where it cannot be, the sheet fills the window instead: see `fill`.
 *
 * It is also the shape that puts the two buttons under the thumb. The decision
 * is at the bottom of a sheet that starts at the bottom; nothing about it
 * requires reaching the top of the screen.
 *
 * Dragging it down is a no. A dismissal is never an approval, and never a
 * remembered one either: a gesture that got away from someone must not be able
 * to write a decision the asker gets to keep.
 */
export function PermissionSheet({
  artwork,
  name,
  subtitle,
  children,
  remember,
  allowLabel = 'Allow',
  denyLabel = 'Deny',
  onAllow,
  onDeny,
  soleAction,
  fill = false,
  onDismiss,
}: PermissionSheetProps) {
  const dismiss = useCallback(() => onDismiss(), [onDismiss]);

  // The frame under the sheet stands aside for this one while it is up, so the
  // gesture lands here and nowhere else.
  useEffect(() => {
    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', dismiss)
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [dismiss]);

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      {/* Tall enough to be a sheet rather than a toast even when the question
          is one line. The cap comes from the drawer's own styles, and the gap
          it leaves at the top is the point: what shows through it is whatever
          asked, still there, waiting on an answer.

          Unless there is nothing to show through it, in which case the sheet
          is the window — the drawer's own height, margin, corners and top
          edge all go, and the top padding keeps the handle out from under the
          status bar. Still a drawer: it is dragged down to dismiss, and that
          still reads as putting something back rather than as cancelling. */}
      <DrawerContent
        className={cn(
          'mx-auto w-full max-w-lg',
          fill
            ? 'h-full pt-safe data-[vaul-drawer-direction=bottom]:mt-0 data-[vaul-drawer-direction=bottom]:max-h-none data-[vaul-drawer-direction=bottom]:rounded-none data-[vaul-drawer-direction=bottom]:border-t-0'
            : 'min-h-[55svh]',
        )}
      >
        <DrawerHeader className="flex flex-row items-center gap-3 pt-2">
          <span aria-hidden="true" className="relative block size-10 shrink-0">
            {artwork}
          </span>
          {/* Left-aligned against the drawer's own centring, which is for a
              sheet whose header is a heading. This one is an identity beside
              an icon, and it reads off the icon. */}
          <div className="min-w-0 flex-1 text-left">
            <DrawerTitle className="truncate text-base">{name}</DrawerTitle>
            <DrawerDescription className="text-xs">{subtitle}</DrawerDescription>
          </div>
        </DrawerHeader>

        {children}

        <DrawerFooter className="gap-3 pb-safe-offset-4">
          {/* A remembered decision is offered for anything that gets this far.
              What the sheet shows — the kind, the content, the tags — is what a
              person needs to decide; deciding once is then theirs to choose,
              and a prompt the app refuses to stop showing is a prompt people
              learn to dismiss. */}
          {remember && !soleAction && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="permission-remember"
                checked={remember.checked}
                onCheckedChange={(checked) => remember.onChange(checked === true)}
              />
              <Label
                htmlFor="permission-remember"
                className="cursor-pointer select-none text-xs text-muted-foreground"
              >
                {remember.label}
              </Label>
            </div>
          )}

          {soleAction ? (
            <Button variant="outline" size="lg" className="w-full" onClick={soleAction.onPress}>
              {soleAction.label}
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button variant="outline" size="lg" className="flex-1 gap-1.5" onClick={onDeny}>
                <X className="size-4" />
                {denyLabel}
              </Button>
              <Button size="lg" className="flex-1 gap-1.5" onClick={onAllow}>
                <Check className="size-4" />
                {allowLabel}
              </Button>
            </div>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
