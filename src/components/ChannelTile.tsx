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
      className="group block w-full outline-none motion-safe:transition-transform motion-safe:duration-200 hover:scale-[1.04] focus-visible:scale-[1.04]"
    >
      <CrtScreen design={design} className="w-full">
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
        {/*
          Held clear of the corner the tube's curve cuts away. The inset is a
          percentage because the curve is one too — a fixed inset that clears
          the corner on a small screen sits outside the glass on a large one.
        */}
        <span className="crt-osd absolute right-[6%] top-[8%] font-crt text-[10px] leading-none text-[#7CFC9B] sm:text-base lg:text-xl">
          CH {ch}
        </span>
      </CrtScreen>
    </button>
  );
}
