import { useSyncExternalStore } from 'react';
import { Shield, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { NappPush, supportsNappPush } from '@/lib/nappPushPlugin';
import {
  clearNsitePermissions,
  getNsiteAllowance,
  getPermissionLabel,
  removeNsitePermission,
  type NsiteAllowance,
  type NsitePermission,
} from '@/lib/nsitePermissions';

// ---------------------------------------------------------------------------
// Subscribe to localStorage changes so the component re-renders when
// permissions are modified (e.g. by the prompt granting a new permission).
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'nostr:nsite-permissions';

function subscribe(callback: () => void): () => void {
  // Listen for changes from other tabs/windows.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener('storage', onStorage);

  // For same-tab mutations, we override the localStorage setter to also
  // dispatch a custom event. This is necessary because the `storage` event
  // only fires across tabs, not within the same tab.
  const onLocal = () => callback();
  window.addEventListener('nsite-permissions-changed', onLocal);

  return () => {
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('nsite-permissions-changed', onLocal);
  };
}

let _snapshotCache: string | null = null;

function getSnapshot(): string | null {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current !== _snapshotCache) {
    _snapshotCache = current;
  }
  return _snapshotCache;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface NsitePermissionManagerProps {
  /** Canonical nsite subdomain identifier. */
  siteId: string;
  /**
   * Controlled open state.
   *
   * The viewer takes control because the panel can also be asked for from
   * outside React entirely — the native Android chrome, which is drawn over
   * the site's own WebView and can't reach the trigger below it.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Popover triggered from the nsite preview nav bar that shows and manages
 * stored permissions for the current site.
 */
export function NsitePermissionManager({
  siteId,
  open,
  onOpenChange,
}: NsitePermissionManagerProps) {
  const { user } = useCurrentUser();

  // Subscribe to permission changes so the list stays in sync.
  useSyncExternalStore(subscribe, getSnapshot);
  const allowance: NsiteAllowance | undefined = user
    ? getNsiteAllowance(siteId, user.pubkey)
    : undefined;
  const permissions = allowance?.permissions ?? [];

  // Taking back "send notifications" has to reach further than the stored
  // decision: the subscriptions the site set are on disk on the native side,
  // and the push service would go on listening for them.
  const forgetSubscriptions = () => {
    if (!supportsNappPush()) return;
    void NappPush.set({ siteId, label: siteId, subscriptions: '[]' }).catch(() => {
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

  // Don't render the manager if no user is logged in.
  if (!user) return null;

  const hasPermissions = permissions.length > 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`h-7 w-7 p-0 shrink-0 ${hasPermissions ? 'text-primary' : ''}`}
          title="Site permissions"
        >
          <Shield className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <p className="text-sm font-medium truncate">Permissions</p>
          {hasPermissions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
              onClick={handleClearAll}
            >
              Revoke all
            </Button>
          )}
        </div>

        {/* Permission list */}
        <div className="max-h-64 overflow-y-auto">
          {!hasPermissions ? (
            <div className="px-4 py-6 text-center">
              <Shield className="size-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No permissions granted
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Permissions will appear here when the app requests them.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {permissions.map((perm) => (
                <div
                  key={`${perm.type}-${perm.kind}`}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  {/* Label */}
                  <span className="text-sm flex-1 min-w-0 truncate">
                    {getPermissionLabel(perm.type, perm.kind)}
                  </span>

                  {/* Remove */}
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                    onClick={() => handleRemove(perm)}
                    title="Remove"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}


