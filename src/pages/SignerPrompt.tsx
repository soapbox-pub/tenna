import { useState } from 'react';

import { AppMark } from '@/components/AppMark';
import { PermissionDetails, PermissionSheet } from '@/components/PermissionSheet';
import type { PermissionKind } from '@/lib/permissionLabels';
import type { SignerRequest } from '@/lib/signerPromptPlugin';

/** The event being signed, if one is and it can be read. */
function parseEvent(json: string | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // An event that cannot be read is one the sheet describes by its kind
    // alone — which it does not have either, so the request is as opaque to
    // the user as it is to us, and that is worth showing rather than hiding.
    return null;
  }
}

/**
 * The sheet another application's request appears in.
 *
 * This whole window is transparent — see `SignerActivity` — so what is behind
 * the sheet is the app that asked, still on screen, which is the thing a
 * person needs in order to answer. Nothing else of Tenna is drawn here: no
 * wall, no router, no wallpaper.
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
      onDismiss={() => onResolve(false, false)}
    >
      <PermissionDetails
        type={type}
        kind={request.kind ?? null}
        event={parseEvent(request.event)}
      />

      {/* Between the scrolling detail and the buttons, and never part of
          either. `shrink-0` because the region above it is what gives when the
          sheet runs out of room, and a line that says which identity is about
          to be used is not a line to let a long tag list push off screen. */}
      {request.accountName && (
        <p className="shrink-0 border-t px-4 pb-1 pt-2 text-xs text-muted-foreground">
          Signing as <span className="text-foreground">{request.accountName}</span>
        </p>
      )}
    </PermissionSheet>
  );
}
