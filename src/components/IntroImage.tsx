import { cn } from '@/lib/utils';

interface IntroImageProps {
  /**
   * The mask to draw.
   *
   * A literal, always. This value lands inside a CSS `url()`, so it is not
   * somewhere a string from an event may go — see the CSS note in `AGENTS.md`.
   * Every illustration in the set lives in `public/` and is named here in the
   * source of the screen that shows it.
   */
  src: string;
  /** How big, as a Tailwind width. Square either way. */
  size?: string;
  className?: string;
}

/**
 * One of the line drawings, in whatever colour the app is wearing.
 *
 * The PNG is not drawn — it is used as a stencil. The element is a block of
 * `bg-primary` clipped to the artwork's alpha channel, so a single white-on-
 * transparent file comes out in Tenna's yellow here and in somebody's own
 * accent colour anywhere a theme is on. Recolouring the file for each would
 * have meant a copy of every illustration per theme, which is not a thing a
 * theme can ship.
 */
export function IntroImage({ src, size = 'w-40', className }: IntroImageProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(size, 'shrink-0 bg-primary opacity-90', className)}
      style={{
        maskImage: `url(${src})`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskImage: `url(${src})`,
        WebkitMaskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        aspectRatio: '1 / 1',
      }}
    />
  );
}
