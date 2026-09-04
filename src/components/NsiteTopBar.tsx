import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import type { NsiteApp } from '@/hooks/useNsiteApp';
import { getTileGradient, getTileInitial } from '@/lib/iconTile';
import { cn } from '@/lib/utils';

interface NsiteTopBarProps {
  /** What to call the site. */
  title: string;
  /** The site's own artwork, as resolved for its tile on the wall. */
  app?: NsiteApp;
  /** Leave the site. */
  onBack: () => void;
  /** The trailing slot — the permissions shield, when there is a signer. */
  children?: ReactNode;
}

/**
 * The bar above an nsite: the way out, and whose site this is.
 *
 * A strip of its own rather than a control floating over the picture, because
 * anything floating sits on top of a layout the site chose and Tenna can't
 * see. The way out has to be somewhere the site was never given.
 *
 * It also stands in for the status bar inset. The bar is what runs under the
 * clock, so the site below it starts inside the safe area with nothing to pad.
 */
export function NsiteTopBar({ title, app, onBack, children }: NsiteTopBarProps) {
  return (
    <div className="shrink-0 border-b border-white/10 bg-black px-safe pt-safe">
      <div className="flex h-12 items-center gap-1 px-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          title="Back"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-white/90 outline-none transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-[#FEF960]"
        >
          <ChevronLeft className="size-6" />
        </button>

        {/* The identity, centred between two slots of the same width so that
            it is centred on the bar and not merely on what's left of it. */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          <span
            aria-hidden="true"
            className="size-5 shrink-0 overflow-hidden rounded-md"
            style={{ background: app?.background ?? getTileGradient(title) }}
          >
            {app?.iconUrl ? (
              <img
                src={app.iconUrl}
                alt=""
                className={cn(
                  'h-full w-full',
                  app.fit === 'cover' ? 'object-cover' : 'p-0.5 object-contain',
                )}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold leading-none text-white">
                {getTileInitial(title)}
              </span>
            )}
          </span>

          <span className="truncate text-sm font-medium text-white">{title}</span>
        </div>

        <div className="flex size-10 shrink-0 items-center justify-center">{children}</div>
      </div>
    </div>
  );
}
