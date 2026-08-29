import type { NostrEvent } from '@nostrify/nostrify';

import { CrtTv } from '@/components/CrtTv';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteAppearance } from '@/hooks/useNsiteAppearance';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { getTvDesign } from '@/lib/tvDesign';

interface ChannelTileProps {
  event: NostrEvent;
  /** 1-based channel number. */
  channel: number;
  onSelect: () => void;
}

/**
 * One television on the channel wall. The set is built from the site's own
 * identity and colors; its screen shows the site's og:image as the running
 * picture, falling back to static. Clicking tunes in.
 */
export function ChannelTile({ event, channel, onSelect }: ChannelTileProps) {
  const name = event.tags.find(([n]) => n === 'd')?.[1] ?? '???';
  const { data: appearance } = useNsiteAppearance(event);
  const design = getTvDesign(getNsiteSubdomain(event), appearance?.themeColor);
  const ch = String(channel).padStart(2, '0');

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Channel ${ch}: ${name}`}
      className="group flex h-full flex-col items-center justify-end outline-none motion-safe:transition-transform motion-safe:duration-200 hover:-translate-y-1.5 hover:-rotate-1 focus-visible:-translate-y-1.5"
    >
      <CrtTv
        design={design}
        className="w-full transition-[filter] duration-200 group-hover:drop-shadow-[0_0_18px_rgba(218,31,82,0.6)] group-focus-visible:drop-shadow-[0_0_18px_rgba(254,249,96,0.75)]"
        screenClassName="aspect-[4/3]"
      >
        {appearance?.cover ? (
          <img
            src={appearance.cover}
            alt=""
            decoding="async"
            loading="lazy"
            className="crt-filter absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <WhiteNoise className="absolute inset-0" />
        )}
        <span className="crt-osd absolute right-1.5 top-1 font-crt text-base leading-none text-[#7CFC9B] sm:text-lg">
          CH {ch}
        </span>
      </CrtTv>
    </button>
  );
}
