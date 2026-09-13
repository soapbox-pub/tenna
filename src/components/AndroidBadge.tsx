import { cn } from '@/lib/utils';

/**
 * The robot, drawn small enough to survive being a fifth of an inch across.
 *
 * The viewBox is the ink and nothing else — no margin of its own — so that
 * whatever centres it is centring the shape rather than the box around it.
 */
function AndroidMark({ className }: { className?: string }) {
  return (
    <svg viewBox="3.5 1.6 17 12.4" aria-hidden="true" className={className}>
      <path
        d="M7.4 2.4 9.3 6.1M16.6 2.4 14.7 6.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M3.5 14a8.5 8.5 0 0 1 17 0z" fill="currentColor" />
      <circle cx="8.7" cy="9.3" r="1.05" fill="#fff" />
      <circle cx="15.3" cy="9.3" r="1.05" fill="#fff" />
    </svg>
  );
}

/**
 * The mark in the corner of a device app's icon.
 *
 * Every other thing Tenna draws an icon for opens inside Tenna; these leave
 * it. Android says the same thing the same way about a shortcut a browser put
 * on its home screen — a small badge of whoever is really behind the icon,
 * clipped to the corner — and a person who has seen one of those knows what
 * this one means without being told.
 *
 * A white disc with a ring of whatever is behind it, so it reads against a
 * dark icon and a bright one alike, and set a little proud of the tile so the
 * artwork keeps its own corner. The ring is the wallpaper on the wall and the
 * surface of a list elsewhere, which is what `className` is for: the badge has
 * to be the same badge in all three places, and the colour it is cut out of is
 * the one thing about it that is not.
 *
 * Expects a positioned parent, the same as the artwork it sits on.
 */
export function AndroidBadge({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute -bottom-[3%] -right-[3%] flex size-[32%] items-center justify-center rounded-full bg-white ring-2 ring-background',
        className,
      )}
    >
      <AndroidMark className="h-auto w-[58%] text-[#3DDC84]" />
    </span>
  );
}
