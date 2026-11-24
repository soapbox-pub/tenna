import { Check } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { type ReactNode, useState } from 'react';

import { PermissionDetails, PermissionSheet } from '@/components/PermissionSheet';
import { TileArtwork } from '@/components/Tile';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import type { NsiteIdentity } from '@/hooks/useNsiteIdentity';
import type { NsitePromptDecision, NsitePromptState } from '@/hooks/useNsiteSignerRpc';
import { cn, middleEllipsis } from '@/lib/utils';

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
  const { user } = useCurrentUser();

  // The wall's drawing rather than a picture in a circle, because a person
  // answering this has to recognise what is asking, and what they know it by
  // is the tile they pressed. A site that ships no artwork gets the same
  // initial on the same colour it has there, which is still its mark and not a
  // warning sign.
  const artwork = (
    <TileArtwork
      name={identity.name}
      iconUrl={identity.iconUrl}
      fit={identity.fit}
      background={identity.background}
    />
  );

  if (prompt.type === 'requestPublicKey') {
    return <AccountPrompt identity={identity} artwork={artwork} onResolve={onResolve} />;
  }

  // Whether a site may notify is always kept, either way, as a browser's
  // Allow and Block are: a site's worker can only notify on a grant that is
  // written down. Backing out still decides nothing.
  const kept = prompt.type === 'notifications';

  return (
    <PermissionSheet
      artwork={artwork}
      name={identity.name}
      subtitle="Permission request"
      remember={kept ? undefined : {
        label: 'Remember for this site',
        checked: remember,
        onChange: setRemember,
      }}
      onAllow={() => onResolve({ allowed: true, remember: kept || remember })}
      onDeny={() => onResolve({ allowed: false, remember: kept || remember })}
      // Never a remembered one; see the note on `PermissionSheet`.
      onDismiss={() => onResolve({ allowed: false, remember: false })}
    >
      {/* A site sends a template with no `pubkey` in it — it is asking Tenna
          for the one field it cannot fill in — so whose post this would be has
          to come from here: the account a pinned signer acts as, or Tenna's. */}
      <PermissionDetails
        type={prompt.type}
        kind={prompt.kind}
        event={prompt.event}
        pubkey={prompt.account ?? user?.pubkey}
      />
    </PermissionSheet>
  );
}

/**
 * `window.nostr.requestPublicKey()`: the user gives the site one of the
 * accounts signed in to Tenna.
 *
 * Always asked, and never remembered, because it is not a permission but a
 * choice of who. The account Tenna is on now is picked to begin with, so a
 * person with one account has one button to press.
 */
function AccountPrompt({
  identity,
  artwork,
  onResolve,
}: {
  identity: NsiteIdentity;
  artwork: ReactNode;
  onResolve: (decision: NsitePromptDecision) => void;
}) {
  const { currentUser, authors } = useLoggedInAccounts();
  const [picked, setPicked] = useState<string | undefined>(currentUser?.pubkey);

  // Every login, in Tenna's order, with whatever profile has arrived for it.
  const accounts = currentUser
    ? [currentUser, ...authors.filter((account) => account.pubkey !== currentUser.pubkey)]
    : authors;

  const name = (pubkey: string, value: string | undefined) => {
    const tidy = value?.replace(/\s+/g, ' ').trim();
    if (tidy) return tidy;
    try {
      return middleEllipsis(nip19.npubEncode(pubkey), 15);
    } catch {
      return middleEllipsis(pubkey, 15);
    }
  };

  return (
    <PermissionSheet
      artwork={artwork}
      name={identity.name}
      subtitle="Wants an account"
      allowLabel="Continue"
      denyLabel="Cancel"
      onAllow={() => onResolve({ allowed: !!picked, remember: false, pubkey: picked })}
      onDeny={() => onResolve({ allowed: false, remember: false })}
      onDismiss={() => onResolve({ allowed: false, remember: false })}
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-2">
        <p className="text-sm text-muted-foreground">
          Choose an account for {identity.name}. It will be able to ask to sign
          and decrypt as that account, and will always ask first.
        </p>

        <div role="radiogroup" aria-label="Accounts" className="space-y-2">
          {accounts.map((account) => {
            const label = name(account.pubkey, account.metadata.display_name ?? account.metadata.name);
            const selected = picked === account.pubkey;
            return (
              <button
                key={account.pubkey}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setPicked(account.pubkey)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-primary',
                  selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
                )}
              >
                <Avatar className="size-10">
                  <AvatarImage src={account.metadata.picture} alt="" />
                  <AvatarFallback>{label.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{label}</span>
                  {account.pubkey === currentUser?.pubkey && (
                    <span className="block text-xs text-muted-foreground">Signed in now</span>
                  )}
                </span>
                {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </div>
    </PermissionSheet>
  );
}
