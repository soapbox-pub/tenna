import type { NostrEvent } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { AddedNsite } from '@/hooks/useAddedNsites';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { notificationError, notificationSuccess } from '@/lib/haptics';
import { parseNsiteAddress } from '@/lib/nsiteAddress';
import { isServableNsite } from '@/lib/nsiteFiles';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { NSITE_RELAY } from '@/lib/tenna';

interface AddNsiteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sites already on the wall, so the same one isn't added twice. */
  addedIds: string[];
  onAdd: (site: AddedNsite) => void;
}

/** Told to the user, so it says what to do about it. */
class AddressError extends Error {}

/**
 * Paste an address, get a site on the wall.
 *
 * The address is resolved before anything is stored: an address that names no
 * manifest, or names an event that isn't a site anyone can open, is a tile
 * that would sit on the wall showing static forever. Better to say so here,
 * while the user still has the thing they pasted in front of them.
 */
export function AddNsiteDialog({ open, onOpenChange, addedIds, onAdd }: AddNsiteDialogProps) {
  const { nostr } = useNostr();
  const [address, setAddress] = useState('');

  const { mutate: resolve, isPending, error, reset } = useMutation({
    mutationFn: async (input: string): Promise<AddedNsite> => {
      const parsed = parseNsiteAddress(input);
      if (!parsed) {
        throw new AddressError("That doesn't look like an nsite address.");
      }

      const { filter, relays } = parsed;
      const urls = [...new Set([NSITE_RELAY, ...relays])];

      let events: NostrEvent[];
      try {
        events = await nostr.group(urls).query([filter], {
          signal: AbortSignal.timeout(8000),
        });
      } catch {
        throw new AddressError('Could not reach the relay. Check your connection and try again.');
      }

      const event = events
        .filter(isServableNsite)
        .sort((a, b) => b.created_at - a.created_at)[0];

      if (!event) {
        throw new AddressError('No nsite was found at that address.');
      }

      const id = getNsiteSubdomain(event);
      if (addedIds.includes(id)) {
        throw new AddressError('That site is already on your home screen.');
      }

      return { id, relays: relays.length > 0 ? relays : undefined };
    },
    onSuccess: (site) => {
      notificationSuccess();
      onAdd(site);
      setAddress('');
      reset();
      onOpenChange(false);
    },
    onError: () => {
      notificationError();
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim() && !isPending) resolve(address);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setAddress('');
      reset();
    }
    onOpenChange(next);
  };

  const message =
    error instanceof AddressError
      ? error.message
      : error
        ? 'Something went wrong looking that up. Try again.'
        : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-white/10 bg-[#1B080C] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an app</DialogTitle>
          <DialogDescription className="text-white/70">
            Paste an nsite address — an <code className="text-white/90">naddr</code>, an{' '}
            <code className="text-white/90">npub</code>, or the site's web address.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="nsite-address" className="text-white/90">
              Address
            </Label>
            <Input
              id="nsite-address"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                if (error) reset();
              }}
              placeholder="naddr1…"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(message)}
              aria-describedby={message ? 'nsite-address-error' : undefined}
              className="border-white/15 bg-black/40 text-white placeholder:text-white/40"
            />
            {message && (
              <p id="nsite-address-error" role="alert" className="text-sm text-[#F96C91]">
                {message}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              className="text-white/80 hover:bg-white/10 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!address.trim() || isPending}
              className="bg-[#FA2B38] text-white hover:bg-[#E74470]"
            >
              {isPending && <Loader2 className="animate-spin" />}
              {isPending ? 'Looking…' : 'Add'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
