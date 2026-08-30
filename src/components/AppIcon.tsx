import type { NostrEvent } from '@nostrify/nostrify';
import type { ReactNode } from 'react';

import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteApp } from '@/hooks/useNsiteApp';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { cn } from '@/lib/utils';

interface AppIconProps {
  event: NostrEvent;
  onSelect: () => void;
}

/**
 * The face of a tile: the squircle, whatever is on it, and the sheen of light
 * across the glass.
 */
function TileFace({ background, children }: { background: string; children: ReactNode }) {
  return (
    <span className="app-squircle absolute inset-0 overflow-hidden" style={{ background }}>
      {children}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(160deg,rgba(255,255,255,0.22),transparent_45%)]"
      />
    </span>
  );
}

/** The tile, its shadow, and the halo that marks focus. */
function TileFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'relative block aspect-square w-full drop-shadow-[0_6px_12px_rgba(0,0,0,0.55)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A tile with nothing tuned into it yet, for the wait before the lineup itself
 * arrives — there is no site to name, so the label is a bar.
 */
export function AppIconSkeleton() {
  return (
    <div className="flex w-full flex-col items-center gap-2">
      <TileFrame>
        <TileFace background="#0A0A0A">
          <WhiteNoise className="absolute inset-0 opacity-90" />
        </TileFace>
      </TileFrame>
      <span className="h-3 w-3/4 rounded-full bg-white/15 motion-safe:animate-pulse" />
    </div>
  );
}

/**
 * One app on the home screen: a rounded tile with the site's own icon on it
 * and its name underneath.
 *
 * The tile is never empty. Static plays on it while the icon is being resolved
 * — the site is known by then, so its name is already under the tile — and a
 * site that turns out to have no icon at all keeps a tile in its own color
 * with its initial on it.
 *
 * The shadow and the focus halo are both cast outside the tile, so neither can
 * live on the tile itself: the mask that cuts its corners would cut them off
 * with them. The shadow is a `drop-shadow` filter on the frame, which reads
 * the alpha of what it wraps and so follows the squircle, and the halo is a
 * second squircle sitting a few pixels proud behind it.
 */
export function AppIcon({ event, onSelect }: AppIconProps) {
  const { data: app, isPending } = useNsiteApp(event);

  // The nsite's own name until the site says what it calls itself.
  const name = app?.label ?? event.tags.find(([n]) => n === 'd')?.[1] ?? '???';

  return (
    <button
      type="button"
      onClick={onSelect}
      title={name}
      className="group flex w-full flex-col items-center gap-2 outline-none"
    >
      <TileFrame className="motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:-translate-y-1">
        <span
          aria-hidden="true"
          className="app-squircle absolute -inset-[3px] bg-[#FEF960] opacity-0 transition-opacity group-focus-visible:opacity-100"
        />
        {isPending ? (
          <TileFace background="#0A0A0A">
            <WhiteNoise className="absolute inset-0 opacity-90" />
          </TileFace>
        ) : (
          <TileFace background={app?.background ?? getTileGradient(name)}>
            {app?.iconUrl ? (
              <img
                src={app.iconUrl}
                alt=""
                decoding="async"
                loading="lazy"
                className={cn(
                  'absolute',
                  app.fit === 'cover'
                    ? 'inset-0 h-full w-full object-cover'
                    : 'inset-[18%] h-[64%] w-[64%] object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]',
                )}
              />
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-3xl font-semibold leading-none text-white/95 sm:text-4xl">
                {getTileInitial(name)}
              </span>
            )}
          </TileFace>
        )}
      </TileFrame>

      <span className="w-full truncate px-0.5 text-center text-xs text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] sm:text-sm">
        {name}
      </span>
    </button>
  );
}
