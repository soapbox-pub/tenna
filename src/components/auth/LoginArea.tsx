import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import AuthDialog from './AuthDialog';
import { QuickLoginDialog } from './QuickLoginDialog';
import { useLoggedInAccounts } from '@/hooks/useLoggedInAccounts';
import { AccountSwitcher } from './AccountSwitcher';
import { cn } from '@/lib/utils';

/** Minimal shape of the NIP-07 provider injected at `window.nostr`. */
interface Nip07Provider {
  getPublicKey(): Promise<string>;
}

function getNip07Provider(): Nip07Provider | undefined {
  if (typeof window === 'undefined' || !('nostr' in window)) return undefined;
  const provider = (window as { nostr?: unknown }).nostr;
  if (
    provider &&
    typeof (provider as Nip07Provider).getPublicKey === 'function'
  ) {
    return provider as Nip07Provider;
  }
  return undefined;
}

export interface LoginAreaProps {
  className?: string;
}

export function LoginArea({ className }: LoginAreaProps) {
  const { currentUser } = useLoggedInAccounts();
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const [quickLoginPubkey, setQuickLoginPubkey] = useState<string | null>(null);

  const handleJoin = async () => {
    const provider = getNip07Provider();
    if (provider) {
      try {
        const pubkey = await provider.getPublicKey();
        if (pubkey) {
          setQuickLoginPubkey(pubkey);
          return;
        }
      } catch {
        // Extension declined or errored — fall through to the full dialog.
      }
    }
    setAuthDialogOpen(true);
  };

  return (
    <div className={cn('inline-flex items-center justify-center', className)}>
      {currentUser ? (
        <AccountSwitcher onAddAccountClick={() => setAuthDialogOpen(true)} />
      ) : (
        /*
          The theme's accent rather than a surface colour — Tenna's own is the
          yellow of the sun in the logo, and under somebody's theme it is
          whatever their `primary` is. Either way it is the brightest thing on
          the screen, which is what the one way in should be, and the text on
          it is whichever of the theme's other two colours reads there. The
          focus ring is the ink, so it stays visible against the fill rather
          than blending into it.
        */
        <Button
          onClick={handleJoin}
          className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground font-semibold transition-all hover:brightness-110 focus-visible:ring-foreground/80 focus-visible:border-foreground animate-scale-in"
        >
          <span className="truncate">Join</span>
        </Button>
      )}

      {quickLoginPubkey && (
        <QuickLoginDialog
          isOpen={quickLoginPubkey !== null}
          pubkey={quickLoginPubkey}
          onClose={() => setQuickLoginPubkey(null)}
          onOtherLogin={() => {
            setQuickLoginPubkey(null);
            setAuthDialogOpen(true);
          }}
        />
      )}

      <AuthDialog
        isOpen={authDialogOpen}
        onClose={() => setAuthDialogOpen(false)}
      />
    </div>
  );
}
