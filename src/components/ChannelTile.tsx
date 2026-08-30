import type { NostrEvent } from '@nostrify/nostrify';

import { CrtScreen } from '@/components/CrtScreen';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteCover } from '@/hooks/useNsiteCover';
import { getScreenDesign } from '@/lib/screenDesign';

interface ChannelTileProps {
  event: NostrEvent;
  /** 1-based channel number. */
  channel: number;
  onSelect: () => void;
}

/**
 * One screen on the channel wall. The tube belongs to the slot and is already
 * lit; this only tunes a channel into it, showing the site's og:image as the
 * running picture and static until it lands. Clicking tunes in.
 */
export function ChannelTile({ event, channel, onSelect }: ChannelTileProps) {
  const name = event.tags.find(([n]) => n === 'd')?.[1] ?? '???';
  const { data: cover } = useNsiteCover(event);
  const design = getScreenDesign(channel);
  const ch = String(channel).padStart(2, '0');

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Channel ${ch}: ${name}`}
      className="group block w-full outline-none motion-safe:transition-transform motion-safe:duration-200 hover:-translate-y-1.5 hover:-rotate-1 focus-visible:-translate-y-1.5"
    >
      <CrtScreen
        design={design}
        className="w-full transition-[filter] duration-200 group-hover:drop-shadow-[0_0_18px_rgba(218,31,82,0.6)] group-focus-visible:drop-shadow-[0_0_18px_rgba(254,249,96,0.75)]"
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            decoding="async"
            loading="lazy"
            className="crt-filter absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <WhiteNoise className="absolute inset-0" />
        )}
        {/* Held clear of the corner, which the tube's curve cuts away. */}
        <span className="crt-osd absolute right-3 top-3 font-crt text-base leading-none text-[#7CFC9B] sm:text-lg">
          CH {ch}
        </span>
      </CrtScreen>
    </button>
  );
}
