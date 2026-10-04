import { ArrowLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

interface NsiteInfoPageProps {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A screen one level deeper than an app's App info.
 *
 * Drawn as the App info page is — a page, not a card, with the way back at the
 * top — because it is a page of that page. It slides in from the side rather
 * than the bottom, as a step further in rather than a new thing arriving.
 *
 * Back is answered by App info, which owns the gesture while any of its screens
 * is up. See `NsiteAppInfo`.
 */
export function NsiteInfoPage({ title, open, onOpenChange, children }: NsiteInfoPageProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className={cn(
          'inset-0 max-h-none w-full max-w-none translate-x-0 translate-y-0 sm:max-w-none',
          'flex flex-col gap-0 overflow-y-auto overscroll-contain rounded-none border-0 p-0',
          'bg-card text-card-foreground',
          // As App info. Fields that have to take a caret opt back in.
          'select-none',
          'data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100',
          'data-[state=open]:slide-in-from-right-4 data-[state=closed]:slide-out-to-right-4',
        )}
      >
        <header className="sticky top-0 z-10 flex items-center gap-3 bg-card/95 px-4 pb-3 pt-safe-offset-3 backdrop-blur">
          <DialogClose
            aria-label="Back"
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/90 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ArrowLeft aria-hidden="true" className="size-6" />
          </DialogClose>

          <DialogTitle className="text-xl font-semibold">{title}</DialogTitle>
        </header>

        <div className="flex flex-col gap-2 px-4 pb-safe-offset-8 pt-2">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A row on App info that is a door rather than a control: its name, a line
 * saying what is behind it, and the chevron that says there is more.
 */
export function NsiteInfoRow({
  label,
  summary,
  onClick,
}: {
  label: string;
  summary: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 px-5 py-4 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-lg font-medium text-foreground">{label}</span>
        <span className="truncate text-base text-foreground/55">{summary}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-foreground/50" />
    </button>
  );
}
