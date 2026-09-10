import { Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { NsiteRow } from '@/components/NsiteRow';
import { Input } from '@/components/ui/input';
import { useNsiteAddress } from '@/hooks/useNsiteAddress';
import { useNsiteCatalog } from '@/hooks/useNsiteCatalog';
import { notificationSuccess } from '@/lib/haptics';
import type { NsiteCatalogEntry } from '@/lib/nsiteCatalog';
import { getNsiteName, getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { nsiteUri, parseWallUri } from '@/lib/wallUri';

interface NsitePickerProps {
  /** Everything on the wall, of which the sites are shown as already there. */
  addedUris: string[];
  onAdd: (uri: string) => void;
}

/**
 * Pick a Nostr site to put on the wall.
 *
 * The list is the catalog — the apps Tenna's own publisher ships, the clients
 * Nsite Packagers puts on Nostr, and the sites published by the people the
 * user follows — narrowed as the user types, the same way the device's own
 * apps are picked next door. A site already on the wall stays in the list and
 * says it is there, rather than going missing.
 *
 * The box does double duty: a name filters the catalog, and an address fetches
 * the site it names and offers it in the same list, as the one result. A site
 * nobody has packaged is still a site, and pasting its address is how it gets
 * here — but that is a thing to reach for, not the way in, so it is the same
 * control rather than a form of its own.
 */
export function NsitePicker({ addedUris, onAdd }: NsitePickerProps) {
  const { data: catalog, isLoading, error } = useNsiteCatalog();
  const [search, setSearch] = useState('');
  const address = useNsiteAddress(search);

  // By subdomain rather than by URI: the same site added by two different
  // naddrs carries two different relay hints and is still the same site.
  const added = useMemo(
    () =>
      new Set(
        addedUris
          .map(parseWallUri)
          .filter((entry) => entry?.kind === 'nsite')
          .map((entry) => entry.id),
      ),
    [addedUris],
  );

  const results = useMemo((): NsiteCatalogEntry[] => {
    if (address.isAddress) {
      if (!address.event) return [];
      return [{ event: address.event, name: getNsiteName(address.event) }];
    }
    if (!catalog) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((entry) => (entry.name ?? '').toLowerCase().includes(needle));
  }, [catalog, search, address.isAddress, address.event]);

  const loading = address.isAddress ? address.isLoading : isLoading;
  const failed = address.isAddress ? address.error : error;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground/40"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps, or paste an address"
          aria-label="Search apps, or paste an address"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="pl-9 placeholder:text-foreground/40"
        />
      </div>

      <div className="h-[46vh] min-h-56 overflow-y-auto overscroll-contain">
        {loading && (
          <div className="flex h-full items-center justify-center text-foreground/60">
            <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            <span className="sr-only">Looking</span>
          </div>
        )}

        {!loading && failed && (
          <p role="alert" className="px-3 py-8 text-center text-sm text-destructive">
            Could not reach the relay. Check your connection and try again.
          </p>
        )}

        {!loading && !failed && results.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-foreground/60">
            {address.isAddress
              ? 'No site was found at that address.'
              : catalog?.length
                ? 'No app by that name.'
                : 'No apps to add.'}
          </p>
        )}

        <div className="space-y-1">
          {!loading &&
            results.map((entry) => (
              <NsiteRow
                key={entry.event.id}
                entry={entry}
                added={added.has(getNsiteSubdomain(entry.event))}
                onSelect={() => {
                  notificationSuccess();
                  onAdd(nsiteUri(getNsiteSubdomain(entry.event), address.relays));
                }}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
