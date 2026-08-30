import type { CSSProperties, ReactNode } from 'react';

import type { ScreenDesign } from '@/lib/screenDesign';
import { cn } from '@/lib/utils';

interface CrtScreenProps {
  /** How this particular tube behaves — scanline pitch, roll, flicker. */
  design: ScreenDesign;
  /** Screen content (static, pictures, OSD text...). */
  children: ReactNode;
  className?: string;
}

/**
 * A bare tube face: no cabinet, no antenna, no plastic — just the picture,
 * masked to the bowed silhouette of a CRT and hanging a good distance off the
 * page. The glass throws no light of its own; the only halo is the one a
 * `.group` ancestor lights up to mark focus.
 *
 * Both are `drop-shadow` filters rather than `box-shadow`, because a mask
 * clips an element's own shadow away with it. A filter reads the alpha of what
 * it wraps, so the cast shadow and the focus halo both follow the curve
 * instead of a rectangle behind it. They sit on separate elements because the
 * `.crt-cast` filter is unlayered CSS and would otherwise win over the
 * focus-visible utility outright.
 */
export function CrtScreen({ design, children, className }: CrtScreenProps) {
  return (
    <div
      className={cn('crt-cast relative aspect-[4/3]', className)}
      style={{
        '--flicker-duration': `${design.flickerDuration}s`,
        '--flicker-delay': `${design.flickerDelay}s`,
      } as CSSProperties}
    >
      <div className="absolute inset-0 motion-safe:transition-[filter] motion-safe:duration-200 group-focus-visible:drop-shadow-[0_0_18px_rgba(254,249,96,0.8)]">
        <div className="crt-shape absolute inset-0 overflow-hidden bg-black">
          {/*
            The picture, which a `.group` ancestor knocks out of alignment for
            a moment when the pointer arrives. Only the picture moves — the
            mask is on the element above, so the tube holds still and the
            disturbance is clipped at the glass, the way a real one would be.
          */}
          <div className="absolute inset-0 motion-safe:group-hover:animate-[crt-glitch_420ms_linear_1]">
            {children}
            <div className="crt-rgb pointer-events-none absolute inset-0" />
            <div
              className="crt-scanlines pointer-events-none absolute inset-0 opacity-40"
              style={{ '--scanline-gap': `${design.scanlineGap}px` } as CSSProperties}
            />
            {design.roll && (
              <div
                className="crt-rollbar pointer-events-none absolute inset-0"
                style={{
                  '--roll-duration': `${design.rollDuration}s`,
                  '--roll-delay': `${design.rollDelay}s`,
                } as CSSProperties}
              />
            )}
            <div className="crt-flicker-veil pointer-events-none absolute inset-0" />
            <div className="crt-vignette pointer-events-none absolute inset-0" />
            <div className="crt-glare pointer-events-none absolute inset-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
