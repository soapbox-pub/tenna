import { Check } from 'lucide-react';

import { TileArtwork, TileButton, TileStatic } from '@/components/Tile';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { useSeen } from '@/hooks/useSeen';
import type { NsiteCatalogEntry } from '@/lib/nsiteCatalog';
import { cn } from '@/lib/utils';

/**
 * One site to add, drawn as the thing it would become.
 *
 * A publisher's page lists apps, and an app is a tile — the same squircle, the
 * same artwork, the same name underneath as on the wall. So the list is a grid
 * of them rather than rows: what somebody is being offered here is the icon
 * they will be pressing afterwards, and showing it as a line of text with a
 * thumbnail beside it describes that instead of showing it.
 *
 * A site already on the wall is dimmed and ticked rather than dropped from the
 * grid, for the same reason the row it replaces was: the answer to "have I got
 * this one?" is worth more than the space it takes, and a grid that reshuffled
 * as sites were added would move the next tile under the finger.
 *
 * The artwork is fetched when the tile is looked at — a site's icon is a
 * Blossom round trip, and a prolific publisher is a page of them.
 */
export function NsiteTile({
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
  const { data: app, isPending } = useNsiteApp(event, { enabled: seen });

  // What the site says of itself once it has been fetched beats what its
  // manifest or its author's profile could say before that.
  const name = app?.label ?? entry.name ?? '???';

  return (
    <TileButton
      ref={ref}
      name={name}
      title={added ? `${name} is already on your wall` : `Add ${name} to your wall`}
      onSelect={onSelect}
      disabled={added}
      className={cn(added && 'cursor-default')}
    >
      <span className={cn('absolute inset-0 transition-opacity', added && 'opacity-50')}>
        {app ? (
          <TileArtwork
            name={name}
            iconUrl={app.iconUrl}
            fit={app.fit}
            background={app.background}
          />
        ) : isPending ? (
          <TileStatic />
        ) : (
          <TileArtwork name={name} />
        )}
      </span>

      {/* Proud of the squircle's corner, where a badge goes, so it reads over
          artwork of any colour without a scrim over the icon itself. */}
      {added && (
        <span
          aria-hidden="true"
          className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background"
        >
          <Check className="size-4" strokeWidth={3} />
        </span>
      )}
    </TileButton>
  );
}
