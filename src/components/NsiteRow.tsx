import { Check } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuthor } from '@/hooks/useAuthor';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useSeen } from '@/hooks/useSeen';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import type { NsiteCatalogEntry } from '@/lib/nsiteCatalog';
import { cn } from '@/lib/utils';

/** A profile's name as one line of it, or null where it says nothing. */
function tidyName(value: string | undefined): string | null {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

/**
 * One site in a list of sites to add: its icon, its name, its publisher, and
 * whether it is already up.
 *
 * The same row wherever a site is offered — the "Add app" dialog and a
 * publisher's page — because in both it is the same offer, and a person who
 * has learned to press one has learned to press the other.
 */
export function NsiteRow({
  entry,
  added,
  highlighted = false,
  onSelect,
  publisher: showPublisher = true,
}: {
  entry: NsiteCatalogEntry;
  added: boolean;
  /** Whether the keyboard is on this row. See `WallSearch`. */
  highlighted?: boolean;
  onSelect: () => void;
  /**
   * Whether to name whose site it is. False on a page that is already about
   * one person: every row would carry the same face and the same name, which
   * says nothing and takes the room the site's own name needs.
   */
  publisher?: boolean;
}) {
  const { event } = entry;
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const { data: app } = useNsiteApp(event, { enabled: seen });

  // Fetched on the same terms as the artwork beside it: when the row is
  // looked at, and once per publisher however many of their sites are listed.
  const { data: author } = useAuthor(event.pubkey, { enabled: seen && showPublisher });
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
  const publisher = showPublisher ? tidyName(metadata?.display_name || metadata?.name) : null;
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
        highlighted && !added && 'bg-foreground/10',
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
