import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface CrtTvProps {
  /** Screen content (static, video, icons...). */
  children: ReactNode;
  className?: string;
  /** Extra classes for the screen area (e.g. an aspect ratio). */
  screenClassName?: string;
  /** Scanline pitch in px — vary it per set so the wall doesn't repeat. */
  scanlineGap?: number;
}

/**
 * A little television set: V antennae with ball tips, an aged-plastic lilac
 * shell, a curved glass screen with scanlines, a control strip, and feet.
 */
export function CrtTv({ children, className, screenClassName, scanlineGap = 3 }: CrtTvProps) {
  return (
    <div className={cn('relative', className)}>
      {/* Antennae */}
      <svg
        viewBox="0 0 120 40"
        aria-hidden="true"
        className="mx-auto w-1/2 translate-y-[3px]"
      >
        <line x1="60" y1="40" x2="22" y2="10" stroke="#2D2D33" strokeWidth="5" strokeLinecap="round" />
        <line x1="60" y1="40" x2="98" y2="10" stroke="#2D2D33" strokeWidth="5" strokeLinecap="round" />
        <circle cx="20" cy="8" r="7" fill="#A193ED" stroke="#2D2D33" strokeWidth="2.5" />
        <circle cx="100" cy="8" r="7" fill="#A193ED" stroke="#2D2D33" strokeWidth="2.5" />
      </svg>

      {/* Shell */}
      <div className="relative rounded-2xl border-2 border-black/60 bg-gradient-to-b from-[#E3CCFB] via-[#A193ED] to-[#5D5FA4] p-2.5 pb-1 shadow-[0_10px_30px_rgba(0,0,0,0.55)]">
        {/* Screen */}
        <div
          className={cn(
            'relative overflow-hidden rounded-[8%/11%] bg-black ring-2 ring-black/70',
            screenClassName,
          )}
        >
          {children}
          <div className="crt-rgb pointer-events-none absolute inset-0" />
          <div
            className="crt-scanlines pointer-events-none absolute inset-0 opacity-40"
            style={{ '--scanline-gap': `${scanlineGap}px` } as CSSProperties}
          />
          <div className="crt-vignette pointer-events-none absolute inset-0" />
          <div className="crt-glare pointer-events-none absolute inset-0" />
        </div>

        {/* Control strip: knobs + speaker slits */}
        <div className="flex items-center justify-between px-1.5 pb-1 pt-1.5">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full border border-black/50 bg-[#FEF960]" />
            <span className="size-2.5 rounded-full border border-black/50 bg-[#DA1F52]" />
          </div>
          <div className="flex gap-[3px]">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-2.5 w-[3px] rounded-full bg-black/30" />
            ))}
          </div>
        </div>
      </div>

      {/* Feet */}
      <div className="mx-auto flex w-3/4 justify-between px-2">
        <span className="h-2 w-4 rounded-b-md bg-[#2D2D33]" />
        <span className="h-2 w-4 rounded-b-md bg-[#2D2D33]" />
      </div>
    </div>
  );
}
