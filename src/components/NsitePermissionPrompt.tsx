import { useState } from 'react';

import { PermissionDetails, PermissionSheet } from '@/components/PermissionSheet';
import { TileArtwork } from '@/components/Tile';
import type { NsiteIdentity } from '@/hooks/useNsiteIdentity';
import type { NsitePromptDecision, NsitePromptState } from '@/hooks/useNsiteSignerRpc';

interface NsitePermissionPromptProps {
  /** What the site asking is called, and what it looks like. */
  identity: NsiteIdentity;
  /** The pending prompt state from useNsiteSignerRpc. */
  prompt: NsitePromptState;
  /** Callback to resolve the prompt. */
  onResolve: (decision: NsitePromptDecision) => void;
}

/**
 * The sheet an nsite's request for permission comes up in.
 *
 * The sheet itself is {@link PermissionSheet}, shared with the one another
 * application gets, because it is the same question about the same key and a
 * person should not have to learn it twice. What is particular to a site is
 * only what is at the top of it: its tile, the mark on the wall that the user
 * pressed to open it.
 */
export function NsitePermissionPrompt({
  identity,
  prompt,
  onResolve,
}: NsitePermissionPromptProps) {
  const [remember, setRemember] = useState(false);

  return (
    <PermissionSheet
      // The wall's drawing rather than a picture in a circle, because a person
      // answering this has to recognise what is asking, and what they know it
      // by is the tile they pressed. A site that ships no artwork gets the same
      // initial on the same colour it has there, which is still its mark and
      // not a warning sign.
      artwork={
        <TileArtwork
          name={identity.name}
          iconUrl={identity.iconUrl}
          fit={identity.fit}
          background={identity.background}
        />
      }
      name={identity.name}
      subtitle="Permission request"
      remember={{
        label: 'Remember for this site',
        checked: remember,
        onChange: setRemember,
      }}
      onAllow={() => onResolve({ allowed: true, remember })}
      onDeny={() => onResolve({ allowed: false, remember })}
      // Never a remembered one; see the note on `PermissionSheet`.
      onDismiss={() => onResolve({ allowed: false, remember: false })}
    >
      <PermissionDetails type={prompt.type} kind={prompt.kind} event={prompt.event} />
    </PermissionSheet>
  );
}
