import type { TvDesign } from '@/lib/tvDesign';

interface TvAntennaProps {
  design: TvDesign;
  className?: string;
}

/** Rod tips, in viewBox coordinates. The long rod leans left by default. */
const LONG_TIP = { x: 18, y: 8 };
const SHORT_TIP = { x: 94, y: 18 };
const BASE = { x: 60, y: 35 };

/**
 * The antenna on top of a set: nothing, one rod, or a pair.
 *
 * Rods are deliberately asymmetric — one longer and steeper than the other —
 * and the whole assembly can be mirrored, so a one-rod set leans either way and
 * a pair reads differently depending on which side the long one is on.
 *
 * The SVG renders even for a set with no antenna, so the empty slot keeps
 * screens aligned across a row of televisions.
 */
export function TvAntenna({ design, className }: TvAntennaProps) {
  const { antenna, antennaFlipped, antennaBalls, palette } = design;
  const pair = antenna === 'pair';

  return (
    <svg viewBox="0 0 120 40" aria-hidden="true" className={className}>
      {antenna !== 'none' && (
        <g transform={antennaFlipped ? 'translate(120, 0) scale(-1, 1)' : undefined}>
          {/* Mast base, tucked behind the top of the shell */}
          <rect x="54" y="32" width="12" height="8" rx="2.5" fill={palette.trim} />

          <line
            x1={BASE.x}
            y1={BASE.y}
            x2={LONG_TIP.x}
            y2={LONG_TIP.y}
            stroke={palette.trim}
            strokeWidth="5"
            strokeLinecap="round"
          />
          {pair && (
            <line
              x1={BASE.x}
              y1={BASE.y}
              x2={SHORT_TIP.x}
              y2={SHORT_TIP.y}
              stroke={palette.trim}
              strokeWidth="5"
              strokeLinecap="round"
            />
          )}

          {antennaBalls && (
            <>
              <circle
                cx={LONG_TIP.x}
                cy={LONG_TIP.y}
                r="6"
                fill={palette.shellMid}
                stroke={palette.trim}
                strokeWidth="2.5"
              />
              {pair && (
                <circle
                  cx={SHORT_TIP.x}
                  cy={SHORT_TIP.y}
                  r="6"
                  fill={palette.shellMid}
                  stroke={palette.trim}
                  strokeWidth="2.5"
                />
              )}
            </>
          )}
        </g>
      )}
    </svg>
  );
}
