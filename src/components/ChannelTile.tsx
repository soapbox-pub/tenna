import type { NostrEvent } from '@nostrify/nostrify';

import { CrtTv } from '@/components/CrtTv';
import { WhiteNoise } from '@/components/WhiteNoise';
import { useNsiteIcon } from '@/hooks/useNsiteIcon';

interface ChannelTileProps {
  event: NostrEvent;
  /** 1-based channel number. */
  channel: number;
  onSelect: () => void;
}

/**
 * One television on the channel wall. The screen plays static with the site's
 * icon floating in it like a channel ident; clicking tunes in.
 */
export function ChannelTile({ event, channel, onSelect }: ChannelTileProps) {
  const name = event.tags.find(([n]) => n === 'd')?.[1] ?? '???';
  const { data: icon } = useNsiteIcon(event);
  const ch = String(channel).padStart(2, '0');

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Channel ${ch}: ${name}`}
      className="group flex flex-col items-center outline-none motion-safe:transition-transform motion-safe:duration-200 hover:-translate-y-1.5 hover:-rotate-1 focus-visible:-translate-y-1.5"
    >
      <CrtTv
        className="w-full transition-[filter] duration-200 group-hover:drop-shadow-[0_0_18px_rgba(218,31,82,0.6)] group-focus-visible:drop-shadow-[0_0_18px_rgba(254,249,96,0.75)]"
        screenClassName="aspect-[4/3]"
      >
        <WhiteNoise className="absolute inset-0" />
        {icon && (
          <img
            src={icon}
            alt=""
            decoding="async"
            className="absolute inset-0 m-auto h-1/2 w-1/2 rounded-lg object-contain opacity-95 drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]"
          />
        )}
        <span className="crt-osd absolute right-1.5 top-1 font-crt text-base leading-none text-[#7CFC9B] sm:text-lg">
          CH {ch}
        </span>
      </CrtTv>
      <span className="crt-osd mt-1 font-crt text-xl uppercase tracking-wider text-[#FEF960] group-hover:motion-safe:animate-[blink_0.6s_steps(2)_2]">
        {name}
      </span>
    </button>
  );
}
