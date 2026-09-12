import type { NostrEvent } from '@nostrify/nostrify';
import { useSeoMeta } from '@unhead/react';
import { useState } from 'react';

import { AddAppDialog } from '@/components/AddAppDialog';
import { AddAppTile, AppIcon, AppIconPending } from '@/components/AppIcon';
import { LoginArea } from '@/components/auth/LoginArea';
import { NativeAppIcon } from '@/components/NativeAppIcon';
import { NsiteSharePicker } from '@/components/NsiteSharePicker';
import { NsiteViewer } from '@/components/NsiteViewer';
import { WallSearch } from '@/components/WallSearch';
import { useActiveTheme } from '@/hooks/useActiveTheme';
import { usePendingShare } from '@/hooks/useNsiteShare';
import { useWall } from '@/hooks/useWall';
import { useWallDrag } from '@/hooks/useWallDrag';
import { impactMedium } from '@/lib/haptics';
import { parseWallUri } from '@/lib/wallUri';

/**
 * Decorative star field scattered behind the apps.
 *
 * Literal colours, and deliberately: this is Tenna's own weather, drawn in
 * Tenna's own palette. It is not shown at all under somebody's theme — see
 * the wallpaper note below.
 */
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
  // and move and come off the same way. It is read off the device and drawn
  // as it is; nothing here waits for a relay.
  const wall = useWall();

  // The site tuned in over the wall, where a site can't be given a window of
  // its own. On Android pressing a tile launches one instead and nothing here
  // ever fills — see `useNsiteWindow`.
  const [active, setActive] = useState<{ event: NostrEvent; channel?: number } | null>(null);
  const [adding, setAdding] = useState(false);

  // Which tile is showing its menu. One at a time, and held here rather than
  // in the tile, because the hold that opens a menu is the first half of the
  // hold that picks a tile up — see `useWallDrag`.
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // Something the OS handed to Tenna rather than to one of the apps on it.
  const { share, dismiss, handOff } = usePendingShare();

  const { gridRef, handlers, styleFor } = useWallDrag({
    uris: wall.uris,
    onLongPress: (uri) => {
      impactMedium();
      setMenuFor(uri);
    },
    onDragStart: () => setMenuFor(null),
    onDrop: wall.move,
  });

  const empty = wall.uris.length === 0;

  // Whether the wall is wearing somebody's theme. Its background is theirs
  // then — a flat colour, or the picture `ThemeBackground` draws — and Tenna's
  // own red glow and star field stay off it. Three colours is all a theme has
  // to spend, and a decoration built out of two other hexes over the top of
  // them would be Tenna talking over it.
  const themed = !!useActiveTheme();

  // A site's channel is its place among the sites, counted down the wall.
  // Counted here, over the stored list, so that a site still loading holds
  // its number and the ones after it don't shift when it arrives.
  let channel = 0;

  return (
    // No background of its own: `body` paints the theme's, and anything opaque
    // here would cover the wallpaper a theme brings. See `ThemeBackground`.
    <main className="relative min-h-screen overflow-hidden text-foreground">
      {/* Wallpaper */}
      {!themed && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(250,43,56,0.28),transparent_60%),radial-gradient(ellipse_at_bottom_left,rgba(172,210,222,0.16),transparent_55%)]"
        />
      )}

      {!themed &&
        STARS.map((star, i) => (
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
          The two things on the wall that aren't apps, in the order a browser
          puts them: the way to whatever you were after, and whoever you are
          while you are there.

          Signing in belongs to Tenna rather than to any site on it — the
          identity the browser holds is the one every site it opens ends up
          asking to sign with — so the way in sits above the lineup instead of
          somewhere inside it. The box beside it is the other thing a browser
          keeps at the top, and it reaches past the lineup rather than into it.
        */}
        <header className="relative mb-7 flex items-center gap-3 sm:mb-10">
          <WallSearch
            uris={wall.uris}
            events={wall.events}
            onTuneIn={(event, channel) => setActive({ event, channel })}
            className="min-w-0 flex-1"
          />
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
          {wall.uris.map((uri, i) => {
            const address = parseWallUri(uri);
            if (!address) return null;

            const menu = {
              onRemove: () => wall.remove(uri),
              menuOpen: menuFor === uri,
              onMenuOpenChange: (open: boolean) => setMenuFor(open ? uri : null),
            };

            let tile;
            if (address.kind === 'app') {
              // Drawn from the address alone — package, activity, and the
              // name it was added under — with nothing asked of the device.
              tile = (
                <NativeAppIcon
                  app={{
                    id: `${address.packageName}/${address.activityName}`,
                    packageName: address.packageName,
                    activityName: address.activityName,
                    label: address.label ?? address.packageName,
                  }}
                  {...menu}
                />
              );
            } else {
              const tuned = ++channel;
              const event = wall.events.get(address.id);
              tile = event ? (
                <AppIcon
                  event={event}
                  channel={tuned}
                  onSelect={() => setActive({ event, channel: tuned })}
                  {...menu}
                />
              ) : (
                <AppIconPending siteId={address.id} {...menu} />
              );
            }

            return (
              // The slot a tile sits in, which is a different thing from the
              // tile: during a drag the tiles are transformed out of their
              // slots and back into other ones, and the grid underneath never
              // moves.
              <div
                key={uri}
                data-wall-slot={i}
                style={styleFor(i)}
                {...handlers}
                className="relative w-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
              >
                {tile}
              </div>
            );
          })}

          <AddAppTile onSelect={() => setAdding(true)} />
        </div>

        {empty && (
          <div className="mx-auto max-w-md rounded-xl border border-dashed border-foreground/20 px-8 py-12 text-center">
            <p className="mx-auto max-w-sm text-foreground/70">
              No apps here yet. Press the plus to add one.
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
