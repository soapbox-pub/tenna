import type { NostrEvent } from '@nostrify/nostrify';
import { Check, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Input } from '@/components/ui/input';
import type { AddedNsite } from '@/hooks/useAddedNsites';
import { useNsiteAddress } from '@/hooks/useNsiteAddress';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useNsiteCatalog } from '@/hooks/useNsiteCatalog';
import { useSeen } from '@/hooks/useSeen';
import { notificationSuccess } from '@/lib/haptics';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { getNsiteName, getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { cn } from '@/lib/utils';

interface NsitePickerProps {
  /** Sites already on the wall, shown as such rather than offered again. */
  addedIds: string[];
  onAdd: (site: AddedNsite) => void;
}

/** One site in the list: its icon, its name, and whether it is already up. */
function NsiteRow({
  event,
  added,
  onSelect,
}: {
  event: NostrEvent;
  added: boolean;
  onSelect: () => void;
}) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const { data: app } = useNsiteApp(event, { enabled: seen });

  const name = app?.label ?? getNsiteName(event) ?? '???';

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      disabled={added}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEF960]',
        added ? 'cursor-default opacity-50' : 'hover:bg-white/10 active:bg-white/15',
      )}
    >
      {/* The site's tile, at the size of a row — the same squircle, the same
          colour behind it, and the same choice between artwork that fills it
          and a glyph inset on it. See `TileArtwork`. */}
      <span
        className="app-squircle relative flex size-11 shrink-0 items-center justify-center overflow-hidden text-lg font-semibold text-white/95"
        style={{ background: app?.background ?? getTileGradient(name) }}
      >
        {app?.iconUrl ? (
          <img
            src={app.iconUrl}
            alt=""
            decoding="async"
            className={cn(
              'absolute',
              app.fit === 'cover'
                ? 'inset-0 size-full object-cover'
                : 'inset-[18%] size-[64%] object-contain',
            )}
          />
        ) : (
          getTileInitial(name)
        )}
      </span>

      <span className="min-w-0 flex-1 truncate text-base text-white/95">{name}</span>

      {added && <Check aria-hidden="true" className="size-5 shrink-0 text-white/50" />}
    </button>
  );
}

/**
 * Pick a Nostr site to put on the wall.
 *
 * The list is the catalog — the apps Tenna's own publisher ships and the
 * clients Nsite Packagers puts on Nostr — narrowed as the user types, the same
 * way the device's own apps are picked next door. A site already on the wall
 * stays in the list and says it is there, rather than going missing.
 *
 * The box does double duty: a name filters the catalog, and an address fetches
 * the site it names and offers it in the same list, as the one result. A site
 * nobody has packaged is still a site, and pasting its address is how it gets
 * here — but that is a thing to reach for, not the way in, so it is the same
 * control rather than a form of its own.
 */
export function NsitePicker({ addedIds, onAdd }: NsitePickerProps) {
  const { data: catalog, isLoading, error } = useNsiteCatalog();
  const [search, setSearch] = useState('');
  const address = useNsiteAddress(search);

  const added = useMemo(() => new Set(addedIds), [addedIds]);

  const results = useMemo(() => {
    if (address.isAddress) return address.event ? [address.event] : [];
    if (!catalog) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return catalog;
    return catalog.filter((event) => (getNsiteName(event) ?? '').toLowerCase().includes(needle));
  }, [catalog, search, address.isAddress, address.event]);

  const loading = address.isAddress ? address.isLoading : isLoading;
  const failed = address.isAddress ? address.error : error;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40"
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
          className="border-white/15 bg-black/40 pl-9 text-white placeholder:text-white/40"
        />
      </div>

      <div className="h-[46vh] min-h-56 overflow-y-auto overscroll-contain">
        {loading && (
          <div className="flex h-full items-center justify-center text-white/60">
            <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            <span className="sr-only">Looking</span>
          </div>
        )}

        {!loading && failed && (
          <p role="alert" className="px-3 py-8 text-center text-sm text-[#F96C91]">
            Could not reach the relay. Check your connection and try again.
          </p>
        )}

        {!loading && !failed && results.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-white/60">
            {address.isAddress
              ? 'No site was found at that address.'
              : catalog?.length
                ? 'No app by that name.'
                : 'No apps to add.'}
          </p>
        )}

        <div className="space-y-1">
          {!loading &&
            results.map((event) => (
              <NsiteRow
                key={event.id}
                event={event}
                added={added.has(getNsiteSubdomain(event))}
                onSelect={() => {
                  notificationSuccess();
                  onAdd({
                    id: getNsiteSubdomain(event),
                    relays: address.relays.length > 0 ? address.relays : undefined,
                  });
                }}
              />
            ))}
        </div>
      </div>
    </div>
  );
}
