import type { NostrEvent } from '@nostrify/nostrify';
import { Shield, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNsiteAllowance } from '@/hooks/useNsiteAllowance';
import type { NsiteApp } from '@/hooks/useNsiteApp';
import { impactLight } from '@/lib/haptics';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import {
  clearNsitePermissions,
  getPermissionLabel,
  removeNsitePermission,
  type NsitePermission,
} from '@/lib/nsitePermissions';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
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
 * What an app on the wall has been given, and how to take it back.
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
}: NsiteAppInfoProps) {
  const { user } = useCurrentUser();
  const [copied, setCopied] = useState(false);

  const siteId = useMemo(() => getNsiteSubdomain(event), [event]);
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

  const handleCopyId = () => {
    void navigator.clipboard?.writeText(siteId).then(
      () => {
        impactLight();
        setCopied(true);
      },
      () => {
        // No clipboard to write to. The id is on screen either way.
      },
    );
  };

  // Back to the address after a moment, so the next press has something to
  // confirm again.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  // Reopening should not still be showing the last press's confirmation.
  const handleOpenChange = (next: boolean) => {
    if (!next) setCopied(false);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // Nothing here describes the app in a sentence; the title is the name
        // and everything under it is a control.
        aria-describedby={undefined}
        className="border-white/10 bg-[#1B080C] text-white sm:max-w-md"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="size-11 shrink-0 overflow-hidden rounded-xl"
              style={{ background: app?.background ?? getTileGradient(name) }}
            >
              {app?.iconUrl ? (
                <img
                  src={app.iconUrl}
                  alt=""
                  className={cn(
                    'h-full w-full',
                    app.fit === 'cover' ? 'object-cover' : 'p-1.5 object-contain',
                  )}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-lg font-semibold leading-none text-white">
                  {getTileInitial(name)}
                </span>
              )}
            </span>

            <DialogTitle className="min-w-0 flex-1 truncate text-left">{name}</DialogTitle>
          </div>
        </DialogHeader>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-white/90">Permissions</h3>
            {hasPermissions && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-[#F96C91] hover:bg-white/10 hover:text-[#F96C91]"
                onClick={handleClearAll}
              >
                Revoke all
              </Button>
            )}
          </div>

          {!user ? (
            <div className="rounded-xl border border-dashed border-white/20 px-6 py-8 text-center">
              <p className="mx-auto max-w-xs text-sm text-white/70">
                Sign in to see what this app may do with your identity.
              </p>
            </div>
          ) : !hasPermissions ? (
            <div className="rounded-xl border border-dashed border-white/20 px-6 py-8 text-center">
              <Shield aria-hidden="true" className="mx-auto mb-2 size-8 text-white/25" />
              <p className="text-sm text-white/70">Nothing granted yet</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-white/50">
                What you allow this app to do will be listed here.
              </p>
            </div>
          ) : (
            <ul className="max-h-64 divide-y divide-white/10 overflow-y-auto rounded-xl border border-white/10">
              {permissions.map((perm) => (
                <li
                  key={`${perm.type}-${perm.kind}`}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-white/90">
                    {getPermissionLabel(perm.type, perm.kind)}
                  </span>

                  <button
                    type="button"
                    onClick={() => handleRemove(perm)}
                    aria-label={`Revoke ${getPermissionLabel(perm.type, perm.kind)}`}
                    title="Revoke"
                    className="shrink-0 rounded-full p-1 text-white/50 outline-none transition-colors hover:text-[#F96C91] focus-visible:ring-2 focus-visible:ring-[#FEF960]"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* The site's address, the way a bundle id sits at the foot of an app's
            info: there to identify the thing, and not to be read. Cut through
            the middle rather than wrapped, because the whole of it would be
            four lines of base32 and the ends are the parts that mean
            anything. */}
        <button
          type="button"
          onClick={handleCopyId}
          aria-label={`Copy the address ${siteId}`}
          className="mx-auto block max-w-full truncate rounded-lg px-3 py-1.5 font-mono text-[11px] text-white/40 outline-none transition-colors hover:bg-white/5 hover:text-white/60 focus-visible:ring-2 focus-visible:ring-[#FEF960]"
        >
          {copied ? 'Copied' : middleEllipsis(siteId, 32)}
        </button>
      </DialogContent>
    </Dialog>
  );
}
