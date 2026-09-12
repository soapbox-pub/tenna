import { Check } from 'lucide-react';

import { useNativeAppIcon } from '@/hooks/useNativeApps';
import { useSeen } from '@/hooks/useSeen';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import type { NativeApp } from '@/lib/nativeAppsPlugin';
import { cn } from '@/lib/utils';

/**
 * One of the device's own apps in a list: its icon, its name, and whether it
 * is already on the wall.
 *
 * The counterpart of `NsiteRow`, and the same row wherever an app is offered —
 * the "Add app" dialog, where pressing it puts the app on the wall, and the
 * wall's search bar, where pressing it opens the app. Same shape, same size,
 * same artwork, because in both it is the same app.
 */
export function NativeAppRow({
  app,
  added = false,
  highlighted = false,
  onSelect,
}: {
  app: NativeApp;
  /** Whether it is already on the wall, which is said rather than hidden. */
  added?: boolean;
  /** Whether the keyboard is on this row. See `WallSearch`. */
  highlighted?: boolean;
  onSelect: () => void;
}) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const { data: icon } = useNativeAppIcon(seen ? app : undefined);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      disabled={added}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        added ? 'cursor-default opacity-50' : 'hover:bg-foreground/10 active:bg-foreground/15',
        highlighted && !added && 'bg-foreground/10',
      )}
    >
      {/* The tile this row stands for, at the size of a row: an adaptive icon
          cut to Tenna's squircle, a legacy one left in the outline it came
          with. See `NativeAppIcon`. */}
      {icon?.adaptive ? (
        <img
          src={icon.url}
          alt=""
          decoding="async"
          className="app-squircle size-11 shrink-0 object-cover"
        />
      ) : icon ? (
        <img src={icon.url} alt="" decoding="async" className="size-11 shrink-0 object-contain" />
      ) : (
        <span
          className="app-squircle flex size-11 shrink-0 items-center justify-center text-lg font-semibold text-white/95"
          style={{ background: getTileGradient(app.label) }}
        >
          {getTileInitial(app.label)}
        </span>
      )}

      <span className="min-w-0 flex-1 truncate text-base text-foreground/95">{app.label}</span>

      {added && <Check aria-hidden="true" className="size-5 shrink-0 text-foreground/50" />}
    </button>
  );
}
