import { Check, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { useAuthor } from '@/hooks/useAuthor';
import { useNsiteAddress } from '@/hooks/useNsiteAddress';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useNsiteCatalog, type NsiteCatalogEntry } from '@/hooks/useNsiteCatalog';
import { useSeen } from '@/hooks/useSeen';
import { notificationSuccess } from '@/lib/haptics';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { getNsiteName, getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { nsiteUri, parseWallUri } from '@/lib/wallUri';
import { cn } from '@/lib/utils';

interface NsitePickerProps {
  /** Everything on the wall, of which the sites are shown as already there. */
  addedUris: string[];
  onAdd: (uri: string) => void;
}

/** A profile's name as one line of it, or null where it says nothing. */
function tidyName(value: string | undefined): string | null {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

/** One site in the list: its icon, its name, its publisher, and whether it is already up. */
function NsiteRow({
  entry,
  added,
  onSelect,
}: {
  entry: NsiteCatalogEntry;
  added: boolean;
  onSelect: () => void;
}) {
  const { event } = entry;
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const { data: app } = useNsiteApp(event, { enabled: seen });

  // Fetched on the same terms as the artwork beside it: when the row is
  // looked at, and once per publisher however many of their sites are listed.
  const { data: author } = useAuthor(event.pubkey, { enabled: seen });
  const metadata = author?.metadata;

  // What the site says of itself once it has been fetched beats what its
  // manifest or its author's profile could say before that.
  const name = app?.label ?? entry.name ?? '???';

  // Who signed the manifest, where they have ever said. A publisher with no
  // profile is left unsaid rather than written out as an npub: a row is one
  // line, and 63 characters of base32 would crowd out the name it belongs to.
  //
  // A site that doesn't name itself is named after its publisher, and those
  // rows would otherwise read "Alex by Alex".
  const publisher = tidyName(metadata?.display_name || metadata?.name);
  const by = publisher && publisher.toLowerCase() !== name.toLowerCase() ? publisher : null;

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      disabled={added}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        added ? 'cursor-default opacity-50' : 'hover:bg-foreground/10 active:bg-foreground/15',
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

      {/* What it is and whose it is, read as one line. Both names are cut to
          fit, the publisher's first: an app is picked here by its own name,
          and the publisher is what tells two of the same name apart. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        <span className="min-w-0 truncate text-base font-medium text-foreground/95">{name}</span>

        {by && (
          <>
            <span className="shrink-0 text-sm text-foreground/45">by</span>

            <Avatar className="size-5 shrink-0">
              <AvatarImage src={metadata?.picture} alt="" />
              <AvatarFallback className="bg-foreground/10 text-[0.625rem] text-foreground/80">
                {by.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <span className="min-w-0 shrink-[3] truncate text-sm text-foreground/55">{by}</span>
          </>
        )}
      </span>

      {added && <Check aria-hidden="true" className="size-5 shrink-0 text-foreground/50" />}
    </button>
  );
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
