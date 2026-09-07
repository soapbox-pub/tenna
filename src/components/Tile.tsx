import type { ReactNode } from 'react';

import { WhiteNoise } from '@/components/WhiteNoise';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { cn } from '@/lib/utils';

/**
 * The pieces every tile on the wall is made of.
 *
 * A tile is a tile whatever is behind it — an nsite, an app already on the
 * device, or the empty slot that adds one. They are the same object to the
 * person looking at the screen, so they are the same drawing here, and only
 * what pressing one does is left to the components that use them.
 *
 * The classes for a tile's long-press menu live in `tile-variants.ts`, since
 * a module that exports components may export nothing else.
 */

/**
 * The face of a tile: the squircle, whatever is on it, and the sheen of light
 * across the glass.
 */
export function TileFace({ background, children }: { background: string; children?: ReactNode }) {
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
export function TileFrame({ children, className }: { children: ReactNode; className?: string }) {
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

/** Static, for a tile that has nothing tuned into it yet. */
export function TileStatic() {
  return (
    <TileFace background="#0A0A0A">
      <WhiteNoise className="absolute inset-0 opacity-90" />
    </TileFace>
  );
}

/**
 * An app's artwork on its tile, or its initial if it has none.
 *
 * Full-bleed artwork is left to fill the squircle and the mask cuts it — which
 * is what an Android adaptive icon is drawn expecting. A glyph is inset on its
 * own colour instead, because a small mark stretched to the edges of a tile
 * stops looking like an icon.
 */
export function TileArtwork({
  name,
  iconUrl,
  fit = 'contain',
  background,
}: {
  name: string;
  iconUrl?: string | null;
  fit?: 'cover' | 'contain';
  background?: string | null;
}) {
  return (
    <TileFace background={background ?? getTileGradient(name)}>
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          decoding="async"
          loading="lazy"
          className={cn(
            'absolute',
            fit === 'cover'
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
  );
}

/**
 * Artwork that is the whole tile, with nothing drawn behind it.
 *
 * For icons that arrive already shaped — the device's own apps, cut to the
 * outline their launcher gives them. There is no squircle, no colour and no
 * sheen, because all three would be Tenna redecorating something that was
 * finished before it got here: a circular icon would come back square, and
 * artwork drawn flat would be varnished. The frame's shadow still follows it,
 * since a `drop-shadow` filter reads alpha and so traces whatever shape the
 * icon turned out to be.
 */
export function TileImage({ src, name }: { src: string; name: string }) {
  return (
    <img
      src={src}
      alt=""
      title={name}
      decoding="async"
      loading="lazy"
      className="absolute inset-0 h-full w-full object-contain"
    />
  );
}

/**
 * A pressable tile with its name underneath.
 *
 * The shadow and the focus halo are both cast outside the tile, so neither can
 * live on the tile itself: the mask that cuts its corners would cut them off
 * with them. The shadow is a `drop-shadow` filter on the frame, which reads
 * the alpha of what it wraps and so follows the squircle, and the halo is a
 * second squircle sitting a few pixels proud behind it.
 */
export function TileButton({
  name,
  title,
  onSelect,
  children,
}: {
  /** Drawn under the tile. */
  name: string;
  /** The accessible name, when it should say more than the label does. */
  title?: string;
  onSelect: () => void;
  /** The face of the tile. */
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={title ?? name}
      className="group flex w-full flex-col items-center gap-2 outline-none"
    >
      <TileFrame className="motion-safe:transition-transform motion-safe:duration-200 group-hover:-translate-y-1 group-active:scale-95 group-focus-visible:-translate-y-1">
        <span
          aria-hidden="true"
          className="app-squircle absolute -inset-[3px] bg-[#FEF960] opacity-0 transition-opacity group-focus-visible:opacity-100"
        />
        {children}
      </TileFrame>

      <span className="w-full truncate px-0.5 text-center text-xs text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] sm:text-sm">
        {name}
      </span>
    </button>
  );
}
