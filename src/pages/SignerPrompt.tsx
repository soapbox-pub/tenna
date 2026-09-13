import { useState } from 'react';

import { AppMark } from '@/components/AppMark';
import { PermissionDetails, PermissionSheet } from '@/components/PermissionSheet';
import { parseDraftEvent } from '@/lib/draftEvent';
import type { PermissionKind } from '@/lib/permissionLabels';
import type { SignerRequest } from '@/lib/signerPromptPlugin';

/**
 * The sheet another application's request appears in.
 *
 * A screen rather than a sheet, which was not the plan. The window was meant
 * to be transparent, with the app that asked still visible behind a sheet
 * over it — the thing a person most needs in order to answer a question about
 * signing as themselves. It cannot be: everything in this window is
 * transparent, the framework agrees the window does not occlude what is under
 * it, and what is above the sheet is a flat grey all the same. See
 * `SignerActivity.seeThrough`.
 *
 * So there is nothing behind this question, and it is drawn as what it is.
 * Nothing else of Tenna is here either: no wall, no router, no wallpaper.
 * This window's whole life is one question.
 *
 * The asker is drawn with the same tile the wall uses for a site. An app's
 * launcher icon goes in the squircle full-bleed, the way Android draws it
 * itself; an app whose icon could not be read gets its initial on a colour off
 * its name, which is still its mark.
 *
 * **Its package name is shown under it, always.** That is the one thing about
 * a caller nobody can choose for themselves — a label and an icon can be
 * copied from any app on the store — and the whole question here is which
 * application is being handed a key.
 */
export function SignerPrompt({
  request,
  onResolve,
}: {
  request: SignerRequest;
  onResolve: (allowed: boolean, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);

  const artwork = (
    <AppMark name={request.appName} icon={request.icon} adaptive={request.adaptive} />
  );

  // The package, not a second copy of the name. An app is only as identifiable
  // as the string it cannot pick for itself — and a caller with no package is
  // exactly the case where there is no such string, so the sheet says that
  // rather than repeating the name it was given.
  //
  // A remote app has no package either. What it cannot pick for itself is the
  // connection it is talking on, and the user made that one deliberately, so
  // the honest line is that it is not on this phone.
  const subtitle =
    request.appKind === 'bunker'
      ? 'Asking from somewhere else'
      : request.requesterId ?? 'Asking from a web page';

  // Nobody signed in, or nobody whose key is on this device. There is nothing
  // to decide, so the sheet says so and offers one way out rather than a
  // choice between two that do the same thing.
  if (!request.signedIn) {
    return (
      <PermissionSheet
        artwork={artwork}
        name={request.appName}
        subtitle={subtitle}
        soleAction={{ label: 'Close', onPress: () => onResolve(false, false) }}
        ownWindow
        onDismiss={() => onResolve(false, false)}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-sm font-medium">Nobody is signed in</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              This app asked Tenna to sign something, but there is no account signed in to
              Tenna. Open it, sign in, and try again.
            </p>
          </div>
        </div>
      </PermissionSheet>
    );
  }

  const type = (request.permission ?? 'signEvent') as PermissionKind;

  // Whether the card below will draw the author itself. Read here as well as
  // there because the answer decides what goes *outside* the scrolling region;
  // an event too broken to draw leaves nothing saying whose key this is.
  const embedded = type === 'signEvent' && parseDraftEvent(request.event) !== null;

  return (
    <PermissionSheet
      artwork={artwork}
      name={request.appName}
      subtitle={subtitle}
      remember={
        // Not offered to a caller with no package: every web page shares that
        // one identity, so a decision made about this one would answer for the
        // next. See `TennaSigning.decide`.
        request.canRemember
          ? {
              label: `Remember for ${request.appName}`,
              checked: remember,
              onChange: setRemember,
            }
          : undefined
      }
      onAllow={() => onResolve(true, remember)}
      onDeny={() => onResolve(false, remember)}
      ownWindow
      onDismiss={() => onResolve(false, false)}
    >
      <PermissionDetails
        type={type}
        kind={request.kind ?? null}
        // The text exactly as it arrived. Reading it is the sheet's job, and
        // one thing reading it means one answer to what is in it.
        event={request.event}
        pubkey={request.account ?? undefined}
      />

      {/* Which identity is about to be used, between the scrolling detail and
          the buttons and never part of either. `shrink-0` because the region
          above is what gives when the sheet runs out of room, and this is not
          a line to let a long post push off screen.
          
          Not shown for a signing request: the card above it draws the event
          under the signer's own face and name, which is both the same fact and
          a better place for it — it is where a person reads who posted
          something everywhere else they read posts. Saying it twice would make
          the smaller, redundant copy look like the real answer. */}
      {request.accountName && !embedded && (
        <p className="shrink-0 border-t px-4 pb-1 pt-2 text-xs text-muted-foreground">
          Signing as <span className="text-foreground">{request.accountName}</span>
        </p>
      )}
    </PermissionSheet>
  );
}
