import type { IconFit } from '@/hooks/useNsiteApp';
import { APP_ID } from '@/lib/tenna';

/**
 * What a site's tile looked like the last time it was drawn.
 *
 * Everything a tile needs is three fields, and none of them can be had on the
 * first frame from where they come from: the name and colour are in a
 * document on Blossom and the artwork is a blob beside it. So the wall writes
 * them down once it has them, one small record per site in localStorage,
 * where they can be read back synchronously and drawn before anything has
 * been asked of a disk or a network. The site's own answer still replaces
 * this when it arrives; a snapshot is the first frame, not the truth.
 */
export interface TileSnapshot {
  name: string;
  /** A small data URL rendered from the artwork, or an https URL to it. */
  icon: string | null;
  fit: IconFit;
  background: string | null;
  /** The manifest event this was drawn from. */
  from: string;
}

const key = (siteId: string) => `${APP_ID}:tile:${siteId}`;

export function readTileSnapshot(siteId: string): TileSnapshot | null {
  try {
    const raw = localStorage.getItem(key(siteId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<TileSnapshot>;
    if (typeof value.name !== 'string' || typeof value.from !== 'string') return null;
    return {
      name: value.name,
      icon: typeof value.icon === 'string' ? value.icon : null,
      fit: value.fit === 'contain' ? 'contain' : 'cover',
      background: typeof value.background === 'string' ? value.background : null,
      from: value.from,
    };
  } catch {
    return null;
  }
}

export function writeTileSnapshot(siteId: string, snapshot: TileSnapshot): void {
  try {
    localStorage.setItem(key(siteId), JSON.stringify(snapshot));
  } catch {
    // Full or unavailable. The tile draws static next launch, as before.
  }
}

export function removeTileSnapshot(siteId: string): void {
  try {
    localStorage.removeItem(key(siteId));
  } catch {
    // Nothing to remove.
  }
}
