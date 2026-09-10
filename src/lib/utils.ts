import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Take the middle out of a string too long to show whole.
 *
 * The middle, because both ends of the strings this is used on carry meaning —
 * the front of an nsite id or an npub is what tells two of them apart at a
 * glance, and the tail of an address is the site's own name. A trailing
 * ellipsis would throw away the half that reads.
 */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}
