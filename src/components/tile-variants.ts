/**
 * The long-press menu on a tile, sized for the thumb that opened it.
 *
 * A pointer menu is a list of small targets because a mouse can hit them. This
 * one is opened by holding a finger on an icon, and what comes up under that
 * finger has to be hit by the same finger without moving the phone — so the
 * rows are a comfortable tap tall, the type is body-sized rather than caption-
 * sized, and the surface is a rounded sheet rather than a bordered box, the
 * way a launcher's own is.
 */
export const MENU =
  'w-60 rounded-3xl border-border bg-popover/95 p-2 text-popover-foreground shadow-2xl backdrop-blur-xl';

export const MENU_ITEM = [
  'h-14 gap-4 rounded-2xl px-4 text-base font-medium text-foreground/95',
  'focus:bg-accent focus:text-foreground',
  "[&_svg:not([class*='size-'])]:size-5 [&_svg:not([class*='text-'])]:text-foreground/60",
].join(' ');

export const MENU_ITEM_DESTRUCTIVE = [
  MENU_ITEM,
  'data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/15',
  'data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive!',
].join(' ');
