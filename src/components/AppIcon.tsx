import type { NostrEvent } from '@nostrify/nostrify';

import { useNsiteIcon } from '@/hooks/useNsiteIcon';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { cn } from '@/lib/utils';

interface AppIconProps {
  event: NostrEvent;
  onSelect: () => void;
}

/**
 * One app on the home screen: a rounded tile with the site's own icon on it
 * and its name underneath.
 *
 * The tile is always filled — its gradient shows through a glyph icon, backs a
 * transparent one, and stands in with the site's initial while the icon
 * resolves or when there is none. An empty square would flash on every tile at
 * load and stay on the ones that never answer.
 *
 * The shadow and the focus halo are both cast outside the tile, so neither can
 * live on the tile itself: the mask that cuts its corners would cut them off
 * with them. The shadow is a `drop-shadow` filter on the wrapper, which reads
 * the alpha of what it wraps and so follows the squircle, and the halo is a
 * second squircle sitting a few pixels proud behind it.
 */
export function AppIcon({ event, onSelect }: AppIconProps) {
  const name = event.tags.find(([n]) => n === 'd')?.[1] ?? '???';
  const { data: icon } = useNsiteIcon(event);

  const background = icon?.background ?? getTileGradient(name);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={name}
      className="group flex w-full flex-col items-center gap-2 outline-none"
    >
      <span className="relative block aspect-square w-full drop-shadow-[0_6px_12px_rgba(0,0,0,0.55)] motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:-translate-y-1">
        <span
          aria-hidden="true"
          className="app-squircle absolute -inset-[3px] bg-[#FEF960] opacity-0 transition-opacity group-focus-visible:opacity-100"
        />
        <span className="app-squircle absolute inset-0 overflow-hidden" style={{ background }}>
          {icon ? (
            <img
              src={icon.url}
              alt=""
              decoding="async"
              loading="lazy"
              className={cn(
                'absolute',
                icon.fit === 'cover'
                  ? 'inset-0 h-full w-full object-cover'
                  : 'inset-[18%] h-[64%] w-[64%] object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]',
              )}
            />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center text-3xl font-semibold leading-none text-white/95 sm:text-4xl">
              {getTileInitial(name)}
            </span>
          )}
          {/* The sheen of light across glass. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.22),transparent_45%)]"
          />
        </span>
      </span>

      <span className="w-full truncate px-0.5 text-center text-xs text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] sm:text-sm">
        {name}
      </span>
    </button>
  );
}
