import type { NostrEvent } from '@nostrify/nostrify';
import { useSeoMeta } from '@unhead/react';
import { useState } from 'react';

import { AppIcon } from '@/components/AppIcon';
import { NsiteViewer } from '@/components/NsiteViewer';
import { useNsites } from '@/hooks/useNsites';
import { getTileGradient } from '@/lib/iconTile';

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
  const [active, setActive] = useState<{ event: NostrEvent; channel: number } | null>(null);

  const empty = !isLoading && (!nsites || nsites.length === 0);

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
      <div className="relative mx-auto max-w-2xl px-5 pb-20 pt-10 sm:px-8 sm:pt-16">
        <div className="grid grid-cols-4 gap-x-4 gap-y-7 sm:grid-cols-5 sm:gap-x-6 sm:gap-y-9 lg:grid-cols-6">
          {isLoading &&
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex w-full flex-col items-center gap-2">
                <div
                  className="app-squircle aspect-square w-full opacity-40 motion-safe:animate-pulse"
                  style={{ background: getTileGradient(`slot-${i}`) }}
                />
                <div className="h-3 w-3/4 rounded-full bg-white/15 motion-safe:animate-pulse" />
              </div>
            ))}

          {nsites?.map((event, i) => (
            <AppIcon
              key={event.id}
              event={event}
              onSelect={() => setActive({ event, channel: i + 1 })}
            />
          ))}
        </div>

        {empty && (
          <div className="mx-auto max-w-md rounded-xl border border-dashed border-white/20 px-8 py-12 text-center">
            <p className="mx-auto max-w-sm text-white/70">
              No apps here yet. Check your relay connection, or give it a moment to load.
            </p>
          </div>
        )}
      </div>

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
