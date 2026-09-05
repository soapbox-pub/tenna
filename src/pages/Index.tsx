import type { NostrEvent } from '@nostrify/nostrify';
import { useSeoMeta } from '@unhead/react';
import { useState } from 'react';

import { AddNsiteDialog } from '@/components/AddNsiteDialog';
import { AddAppTile, AppIcon, AppIconSkeleton } from '@/components/AppIcon';
import { NsiteViewer } from '@/components/NsiteViewer';
import { useAddedNsites } from '@/hooks/useAddedNsites';
import { useNsites } from '@/hooks/useNsites';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';

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

  const { data: nsites, isLoading } = useNsites();
  const added = useAddedNsites();

  // The site tuned in over the wall, where a site can't be given a window of
  // its own. On Android pressing a tile launches one instead and nothing here
  // ever fills — see `useNsiteWindow`.
  const [active, setActive] = useState<{ event: NostrEvent; channel: number } | null>(null);
  const [adding, setAdding] = useState(false);

  // The curator's lineup first, then whatever the user added, so a site keeps
  // the channel it was on when the next one is added after it. A site already
  // in the lineup is not a second tile: the curator got there first, and the
  // wall shows one tile per site.
  const curated = nsites ?? [];
  const curatedIds = new Set(curated.map(getNsiteSubdomain));
  const own = (added.events ?? []).filter((event) => !curatedIds.has(getNsiteSubdomain(event)));

  const lineup = [...curated, ...own];
  const loading = isLoading || added.isLoading;
  const empty = !loading && lineup.length === 0;

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
        Four across on a phone, the way a home screen is, widening to six on a
        large display rather than blowing the icons up to fill it. The
        container stops well short of the viewport for the same reason: past a
        certain size a grid of app icons stops reading as a home screen and
        starts reading as a poster.
      */}
      <div className="relative mx-auto max-w-2xl px-5 pb-safe-offset-20 pt-safe-offset-10 sm:px-8 sm:pt-safe-offset-16">
        <div className="grid grid-cols-4 gap-x-4 gap-y-7 sm:grid-cols-5 sm:gap-x-6 sm:gap-y-9 lg:grid-cols-6">
          {loading &&
            Array.from({ length: 6 }).map((_, i) => <AppIconSkeleton key={i} />)}

          {lineup.map((event, i) => (
            <AppIcon
              key={event.id}
              event={event}
              channel={i + 1}
              onSelect={() => setActive({ event, channel: i + 1 })}
              onRemove={
                i >= curated.length ? () => added.remove(getNsiteSubdomain(event)) : undefined
              }
            />
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

      <AddNsiteDialog
        open={adding}
        onOpenChange={setAdding}
        addedIds={[...curatedIds, ...added.stored.map((site) => site.id)]}
        onAdd={added.add}
      />

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
