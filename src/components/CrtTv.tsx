import type { CSSProperties, ReactNode } from 'react';

import { TvAntenna } from '@/components/TvAntenna';
import type { TvDesign } from '@/lib/tvDesign';
import { cn } from '@/lib/utils';

interface CrtTvProps {
  /** The set to build — body, antenna, and palette. */
  design: TvDesign;
  /** Screen content (static, pictures, OSD text...). */
  children: ReactNode;
  className?: string;
  /** Extra classes for the screen area (e.g. an aspect ratio). */
  screenClassName?: string;
  /**
   * Picture to throw as light onto the wall behind the set. Pass whatever is
   * playing on the screen; without it the set glows its own phosphor color.
   */
  glowSrc?: string;
}

const SHELL_SHADOW = 'shadow-[0_10px_30px_rgba(0,0,0,0.55)]';

/**
 * A little television set, assembled from its design: an antenna (or not), a
 * molded shell in the site's colors, and a curved tube behind glass.
 */
export function CrtTv({ design, children, className, screenClassName, glowSrc }: CrtTvProps) {
  const { palette } = design;

  const shellStyle: CSSProperties = {
    backgroundImage: `linear-gradient(to bottom, ${palette.shellLight}, ${palette.shellMid} 58%, ${palette.shellDark})`,
  };

  const screen = (
    <Screen design={design} className={screenClassName}>
      {children}
    </Screen>
  );

  return (
    <div
      className={cn('relative isolate', className)}
      style={{
        '--flicker-duration': `${design.flickerDuration}s`,
        '--flicker-delay': `${design.flickerDelay}s`,
      } as CSSProperties}
    >
      {/*
        Light off the tube, landing on the wall behind the set. It sits in its
        own layer at z-0 with the television at z-10: the bodies paint in normal
        flow, so without the explicit order this positioned layer would cover
        them. A negative z-index would fall behind the page background instead.
      */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0">
        {glowSrc ? (
          <img
            src={glowSrc}
            alt=""
            decoding="async"
            className="crt-bloom h-full w-full scale-110 object-cover opacity-50 blur-2xl saturate-[1.6]"
          />
        ) : (
          <div className="crt-bloom h-full w-full scale-105 bg-[radial-gradient(ellipse_at_center,rgba(196,228,255,0.5),transparent_68%)] opacity-50 blur-xl" />
        )}
      </div>

      <div className="relative z-10">
        <TvAntenna design={design} className="mx-auto w-1/2 translate-y-[3px]" />

        {design.body === 'classic' && <ClassicBody design={design} shellStyle={shellStyle} screen={screen} />}
        {design.body === 'console' && <ConsoleBody design={design} shellStyle={shellStyle} screen={screen} />}
        {design.body === 'portable' && <PortableBody design={design} shellStyle={shellStyle} screen={screen} />}
        {design.body === 'slab' && <SlabBody design={design} shellStyle={shellStyle} screen={screen} />}
      </div>
    </div>
  );
}

interface BodyProps {
  design: TvDesign;
  shellStyle: CSSProperties;
  screen: ReactNode;
}

/** The everyday set: knobs and a speaker under the picture, up on two feet. */
function ClassicBody({ design, shellStyle, screen }: BodyProps) {
  const { knobs, trim } = design.palette;

  return (
    <>
      <div
        className={cn('relative rounded-2xl border-2 border-black/60 p-2.5 pb-1', SHELL_SHADOW)}
        style={shellStyle}
      >
        {screen}
        <div className="flex items-center justify-between px-1.5 pb-1 pt-1.5">
          <div className="flex gap-1.5">
            <Knob color={knobs[0]} className="size-2.5" />
            <Knob color={knobs[1]} className="size-2.5" />
          </div>
          <Slits count={4} className="h-2.5" />
        </div>
      </div>
      <div className="mx-auto flex w-3/4 justify-between px-2">
        <span className="h-2 w-4 rounded-b-md" style={{ background: trim }} />
        <span className="h-2 w-4 rounded-b-md" style={{ background: trim }} />
      </div>
    </>
  );
}

/** A floor cabinet: speaker panel beside the picture, splayed legs beneath. */
function ConsoleBody({ design, shellStyle, screen }: BodyProps) {
  const { knobs, trim } = design.palette;

  return (
    <>
      <div
        className={cn('relative flex gap-2 rounded-md border-2 border-black/60 p-2', SHELL_SHADOW)}
        style={shellStyle}
      >
        <div className="min-w-0 flex-1">{screen}</div>
        <div className="flex w-[15%] min-w-6 flex-col items-center">
          <div className="flex w-full flex-1 items-stretch justify-center gap-[3px] rounded-sm bg-black/15 px-1 py-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="w-[3px] rounded-full bg-black/35" />
            ))}
          </div>
          <div className="flex gap-1 pt-1.5">
            <Knob color={knobs[0]} className="size-2" />
            <Knob color={knobs[1]} className="size-2" />
          </div>
        </div>
      </div>
      <div className="mx-auto flex w-2/3 justify-between">
        <span className="h-3 w-1.5 origin-top -rotate-12 rounded-b-sm" style={{ background: trim }} />
        <span className="h-3 w-1.5 origin-top rotate-12 rounded-b-sm" style={{ background: trim }} />
      </div>
    </>
  );
}

/** A small round-cornered portable: pinhole speaker and one fat tuning dial. */
function PortableBody({ design, shellStyle, screen }: BodyProps) {
  const { knobs, trim } = design.palette;

  return (
    <>
      <div
        className={cn('relative rounded-3xl border-2 border-black/60 p-3 pb-1.5', SHELL_SHADOW)}
        style={shellStyle}
      >
        {screen}
        <div className="flex items-center justify-between px-1 pt-2">
          <div className="flex gap-[3px]">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <span key={i} className="size-1 rounded-full bg-black/25" />
            ))}
          </div>
          <span
            className="flex size-4 items-start justify-center rounded-full border-2 border-black/50"
            style={{ background: knobs[0] }}
          >
            <span className="mt-px h-1.5 w-px bg-black/60" />
          </span>
        </div>
      </div>
      <div className="mx-auto flex w-1/2 justify-between">
        <span className="h-1.5 w-5 rounded-b-sm" style={{ background: trim }} />
        <span className="h-1.5 w-5 rounded-b-sm" style={{ background: trim }} />
      </div>
    </>
  );
}

/** A squared-off set with almost no bezel, sitting flat on a plinth. */
function SlabBody({ design, shellStyle, screen }: BodyProps) {
  const { knobs, trim } = design.palette;

  return (
    <>
      <div
        className={cn('relative rounded-md border-2 border-black/60 p-1.5 pb-1', SHELL_SHADOW)}
        style={shellStyle}
      >
        {screen}
        <div className="flex items-center justify-between px-1 pt-1">
          <div className="flex gap-1">
            <Knob color={knobs[0]} className="size-1.5" />
            <Knob color={knobs[1]} className="size-1.5" />
            <Knob color={knobs[0]} className="size-1.5" />
          </div>
          <span
            className="size-1.5 rounded-full"
            style={{ background: knobs[1], boxShadow: `0 0 6px ${knobs[1]}` }}
          />
        </div>
      </div>
      <div className="mx-auto h-1.5 w-[70%] rounded-b-md" style={{ background: trim }} />
    </>
  );
}

interface ScreenProps {
  design: TvDesign;
  className?: string;
  children: ReactNode;
}

/** The tube: curved glass, shadow mask, scanlines, vignette, and glare. */
function Screen({ design, className, children }: ScreenProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[8%/11%] bg-black ring-2 ring-black/70',
        className,
      )}
    >
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
  );
}

function Knob({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn('rounded-full border border-black/50', className)}
      style={{ background: color }}
    />
  );
}

function Slits({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn('flex items-stretch gap-[3px]', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="w-[3px] rounded-full bg-black/30" />
      ))}
    </div>
  );
}
