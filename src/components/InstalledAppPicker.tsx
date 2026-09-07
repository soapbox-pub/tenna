import { Check, Loader2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Input } from '@/components/ui/input';
import { useNativeAppIcon, useInstalledApps } from '@/hooks/useNativeApps';
import { useSeen } from '@/hooks/useSeen';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { notificationSuccess } from '@/lib/haptics';
import type { NativeApp } from '@/lib/nativeAppsPlugin';
import { cn } from '@/lib/utils';

interface InstalledAppPickerProps {
  /** Apps already on the wall, shown as such rather than offered again. */
  addedIds: string[];
  onAdd: (app: NativeApp) => void;
}

/** One app in the list: its icon, its name, and whether it is already up. */
function InstalledAppRow({
  app,
  added,
  onSelect,
}: {
  app: NativeApp;
  added: boolean;
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FEF960]',
        added ? 'cursor-default opacity-50' : 'hover:bg-white/10 active:bg-white/15',
      )}
    >
      {/* The tile this row would put on the wall, at the size of a row: an
          adaptive icon cut to Tenna's squircle, a legacy one left in the
          outline it came with. See `NativeAppIcon`. */}
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

      <span className="min-w-0 flex-1 truncate text-base text-white/95">{app.label}</span>

      {added && <Check aria-hidden="true" className="size-5 shrink-0 text-white/50" />}
    </button>
  );
}

/**
 * Pick one of the device's own apps to put on the wall.
 *
 * The list is the launcher's: everything with an icon in the app drawer, by
 * name, filtered as the user types. An app already on the wall stays in the
 * list rather than disappearing from it — a person looking for something they
 * added last week should find it where they expect and be told it is already
 * there, not be left wondering why it is missing.
 */
export function InstalledAppPicker({ addedIds, onAdd }: InstalledAppPickerProps) {
  const { data: apps, isLoading, error } = useInstalledApps();
  const [search, setSearch] = useState('');

  const added = useMemo(() => new Set(addedIds), [addedIds]);

  const results = useMemo(() => {
    if (!apps) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter((app) => app.label.toLowerCase().includes(needle));
  }, [apps, search]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-white/40"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your apps"
          aria-label="Search your apps"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="border-white/15 bg-black/40 pl-9 text-white placeholder:text-white/40"
        />
      </div>

      <div className="h-[46vh] min-h-56 overflow-y-auto overscroll-contain">
        {isLoading && (
          <div className="flex h-full items-center justify-center text-white/60">
            <Loader2 aria-hidden="true" className="size-5 animate-spin" />
            <span className="sr-only">Loading your apps</span>
          </div>
        )}

        {error && (
          <p role="alert" className="px-3 py-8 text-center text-sm text-[#F96C91]">
            Could not read the apps on this device.
          </p>
        )}

        {!isLoading && !error && results.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-white/60">
            {apps?.length ? 'No app by that name.' : 'No apps to add.'}
          </p>
        )}

        <div className="space-y-1">
          {results.map((app) => (
            <InstalledAppRow
              key={app.id}
              app={app}
              added={added.has(app.id)}
              onSelect={() => {
                notificationSuccess();
                onAdd(app);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
