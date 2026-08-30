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
 * masked to the bowed silhouette of a CRT and lit from within.
 *
 * The glow is a `drop-shadow` on the outer element rather than a `box-shadow`
 * on the glass, because a mask clips the element's own shadow away with it.
 * A filter reads the alpha of what it wraps, so the light spills from the
 * curved edge instead of from a rectangle behind it.
 */
export function CrtScreen({ design, children, className }: CrtScreenProps) {
  return (
    <div
      className={cn(
        'relative aspect-[4/3] drop-shadow-[0_0_6px_rgba(198,232,255,0.35)]',
        className,
      )}
      style={{
        '--flicker-duration': `${design.flickerDuration}s`,
        '--flicker-delay': `${design.flickerDelay}s`,
      } as CSSProperties}
    >
      <div className="crt-shape absolute inset-0 overflow-hidden bg-black">
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
  );
}
