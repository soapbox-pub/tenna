import type { NostrEvent } from '@nostrify/nostrify';
import { useSeoMeta } from '@unhead/react';
import { useState } from 'react';

import { AddAppDialog } from '@/components/AddAppDialog';
import { AddAppTile, AppIcon, AppIconSkeleton } from '@/components/AppIcon';
import { LoginArea } from '@/components/auth/LoginArea';
import { NativeAppIcon } from '@/components/NativeAppIcon';
import { NsiteSharePicker } from '@/components/NsiteSharePicker';
import { NsiteViewer } from '@/components/NsiteViewer';
import { usePendingShare } from '@/hooks/useNsiteShare';
import { useWall } from '@/hooks/useWall';
import { useWallDrag } from '@/hooks/useWallDrag';
import { impactMedium } from '@/lib/haptics';

/** Decorative star field scattered behind the apps. */
const STARS: Array<{ top: string; left: string; color: string; delay: string; size: string }> = [
  { top: '8%', left: '6%', color: '#FEF960', delay: '0s', size: 'text-xl' },
  { top: '14%', left: '88%', color: '#F96C91', delay: '0.7s', size: 'text-sm' },
  { top: '30%', left: '3%', color: '#E74470', delay: '1.4s', size: 'text-base' },
  { top: '46%', left: '94%', color: '#FEF960', delay: '0.3s', size: 'text-lg' },
  { top: '64%', left: '5%', color: '#ACD2DE', delay: '1.1s', size: 'text-sm' },
  { top: '78%', left: '91%', color: '#FEF960', delay: '1.8s', size: 'text-xl' },
  { top: '90%', left: '12%', color: '#F96C91', delay: '0.5s', size: 'text-base' },
  { top: '5%', left: '48%', color: '#ACD2DE', delay: '2.2s', size: 'text-sm' },
];

const Index = () => {
  useSeoMeta({
    title: 'Tenna',
    description: 'Pick an app. Tenna is an nsite browser — your entrypoint to Nostr.',
  });

  // One list, holding sites and the device's own apps in whatever order the
  // user has dragged them into. Nothing on it is Tenna's rather than theirs:
  // the three it ships with sit on the same list as everything added after,
  // and move and come off the same way.
  const wall = useWall();

  // The site tuned in over the wall, where a site can't be given a window of
  // its own. On Android pressing a tile launches one instead and nothing here
  // ever fills — see `useNsiteWindow`.
  const [active, setActive] = useState<{ event: NostrEvent; channel: number } | null>(null);
  const [adding, setAdding] = useState(false);

  // Which tile is showing its menu. One at a time, and held here rather than
  // in the tile, because the hold that opens a menu is the first half of the
  // hold that picks a tile up — see `useWallDrag`.
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // Something the OS handed to Tenna rather than to one of the apps on it.
  const { share, dismiss, handOff } = usePendingShare();

  const items = wall.items;

  const { gridRef, handlers, styleFor } = useWallDrag({
    uris: items.map((item) => item.uri),
    onLongPress: (uri) => {
      impactMedium();
      setMenuFor(uri);
    },
    onDragStart: () => setMenuFor(null),
    onDrop: wall.move,
  });

  const loading = wall.isLoading;
  const empty = !loading && items.length === 0;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#150609] text-white">
      {/* Wallpaper */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(250,43,56,0.28),transparent_60%),radial-gradient(ellipse_at_bottom_left,rgba(172,210,222,0.16),transparent_55%)]"
      />

      {STARS.map((star, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`pointer-events-none absolute select-none motion-safe:animate-[twinkle_2.4s_ease-in-out_infinite] ${star.size}`}
          style={{ top: star.top, left: star.left, color: star.color, animationDelay: star.delay }}
        >
          ✦
        </span>
      ))}

      {/*
        The container stops well short of the viewport, because past a certain
        size a grid of app icons stops reading as a home screen and starts
        reading as a poster.
      */}
      <div className="relative mx-auto max-w-2xl px-5 pb-safe-offset-20 pt-safe-offset-4 sm:px-8 sm:pt-safe-offset-8">
        {/*
          The one thing on the wall that isn't an app. Signing in belongs to
          Tenna rather than to any site on it: the identity the browser holds
          is the one every site it opens ends up asking to sign with, so the
          way in sits above the lineup instead of somewhere inside it.
        */}
        <header className="mb-7 flex items-center justify-end sm:mb-10">
          <LoginArea />
        </header>

        {/*
          An icon is a size before it is a count. The wall lays out as many
          columns as fit at 68px and lets them share out what's left, so a
          wider screen gets more apps across rather than bigger ones — four on
          a phone held upright, six turned on its side or on a desktop, and
          all of them about 80px either way. 68px is the floor because it is
          what four across comes to on the narrowest phone worth drawing for,
          and 96px the ceiling, for the narrow windows where a column can't be
          added and the icons would otherwise stretch to fill.
        */}
        <div
          ref={gridRef}
          className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] justify-items-center gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-9 [&>*]:max-w-24"
        >
          {/* One per address on the way, since the list of them is on the
              device and only what they resolve to is still coming. */}
          {loading && wall.uris.map((uri) => <AppIconSkeleton key={uri} />)}

          {items.map((item, i) => (
            // The slot a tile sits in, which is a different thing from the
            // tile: during a drag the tiles are transformed out of their slots
            // and back into other ones, and the grid underneath never moves.
            <div
              key={item.uri}
              data-wall-slot={i}
              style={styleFor(i)}
              {...handlers}
              className="relative w-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
            >
              {item.kind === 'nsite' ? (
                <AppIcon
                  event={item.event}
                  channel={item.channel}
                  onSelect={() => setActive({ event: item.event, channel: item.channel })}
                  onRemove={() => wall.remove(item.uri)}
                  menuOpen={menuFor === item.uri}
                  onMenuOpenChange={(open) => setMenuFor(open ? item.uri : null)}
                />
              ) : (
                <NativeAppIcon
                  app={item.app}
                  onRemove={() => wall.remove(item.uri)}
                  menuOpen={menuFor === item.uri}
                  onMenuOpenChange={(open) => setMenuFor(open ? item.uri : null)}
                />
              )}
            </div>
          ))}

          {!loading && <AddAppTile onSelect={() => setAdding(true)} />}
        </div>

        {empty && (
          <div className="mx-auto max-w-md rounded-xl border border-dashed border-white/20 px-8 py-12 text-center">
            <p className="mx-auto max-w-sm text-white/70">
              No apps here yet. Check your relay connection, or give it a moment to load.
            </p>
          </div>
        )}
      </div>

      <AddAppDialog
        open={adding}
        onOpenChange={setAdding}
        addedUris={wall.uris}
        onAdd={wall.add}
      />

      <NsiteSharePicker share={share} onDismiss={dismiss} onHandOff={handOff} />

      {active && (
        <NsiteViewer
          event={active.event}
          channel={active.channel}
          onClose={() => setActive(null)}
        />
      )}
    </main>
  );
};

export default Index;
