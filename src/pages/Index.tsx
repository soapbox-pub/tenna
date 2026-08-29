import type { NostrEvent } from '@nostrify/nostrify';
import { useSeoMeta } from '@unhead/react';
import { useState } from 'react';

import { ChannelTile } from '@/components/ChannelTile';
import { CrtTv } from '@/components/CrtTv';
import { NsiteViewer } from '@/components/NsiteViewer';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsites } from '@/hooks/useNsites';

/** Decorative star field scattered around the channel wall. */
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
    description: 'Pick a channel. Tenna is an nsite browser — your entrypoint to Nostr.',
  });

  const { data: nsites, isLoading } = useNsites();
  const [active, setActive] = useState<{ event: NostrEvent; channel: number } | null>(null);

  const empty = !isLoading && (!nsites || nsites.length === 0);

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#150609] text-white">
      {/* Stage glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-[radial-gradient(ellipse_at_top,rgba(250,43,56,0.22),transparent_70%)]"
      />

      {/* Stars */}
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

      <div className="relative mx-auto max-w-6xl px-6 pb-24 pt-10 sm:pt-14">
        <p className="crt-osd mb-10 text-center font-crt text-2xl uppercase tracking-widest text-[#7CFC9B]">
          Select a channel
          <span className="motion-safe:animate-[blink_1.2s_steps(2)_infinite]">▮</span>
        </p>

        <div className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {isLoading &&
            Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex flex-col items-center">
                <CrtTv className="w-full" screenClassName="aspect-[4/3]">
                  <WhiteNoise className="absolute inset-0" />
                </CrtTv>
                <span className="crt-osd mt-1 font-crt text-xl text-[#7CFC9B]/60">— — —</span>
              </div>
            ))}

          {nsites?.map((event, i) => (
            <ChannelTile
              key={event.id}
              event={event}
              channel={i + 1}
              onSelect={() => setActive({ event, channel: i + 1 })}
            />
          ))}
        </div>

        {empty && (
          <div className="mx-auto max-w-xs">
            <CrtTv screenClassName="aspect-[4/3]">
              <WhiteNoise className="absolute inset-0 opacity-60" />
              <span className="crt-osd absolute inset-0 flex items-center justify-center font-crt text-3xl uppercase tracking-widest text-[#7CFC9B]">
                No signal
              </span>
            </CrtTv>
          </div>
        )}
      </div>

      {/* Checkerboard trim */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-6 opacity-25 [background:repeating-conic-gradient(#fff_0%_25%,#000_0%_50%)_0_0/24px_24px]"
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
