import type { NostrEvent } from '@nostrify/nostrify';
import { useMemo, useState } from 'react';

import type { IconFit, NsiteApp } from '@/hooks/useNsiteApp';
import { getNsiteName, getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { readTileSnapshot } from '@/lib/tileSnapshot';

/** What a site is called and what it looks like, as the wall would draw it. */
export interface NsiteIdentity {
  name: string;
  /** A data URL, a blob, or an https URL — whatever there is. */
  iconUrl: string | null;
  fit: IconFit;
  background: string | null;
}

/**
 * Who a site is, before anyone has asked the site.
 *
 * The real answer — the name and artwork out of its web app manifest — costs
 * a Blossom round trip, and the places that have to say who a site is are
 * places where nobody can be kept waiting: the bar over a site as it tunes in,
 * and the sheet that comes up the moment it asks to sign something. So the
 * tile the wall drew last time stands in, read off the disk on the first
 * frame, exactly as it does on the wall itself.
 *
 * `label` is the name the window was opened under, where the caller knows it —
 * what the site is called in the recents switcher. It is only reached for when
 * the wall has never drawn this site a tile, and it is ignored when it is
 * nothing but the site's address, which is what the launcher falls back to.
 *
 * Last of all comes the manifest event's own name, which is a `title` tag or
 * else a `d` tag: an address, near enough, and not what the user has ever seen
 * this app called.
 */
export function useNsiteTile(event: NostrEvent, label?: string): NsiteIdentity {
  const siteId = getNsiteSubdomain(event);

  // Read once, on the first frame. The record is written by the wall, which
  // in a window of its own is another task entirely, and a site whose picture
  // changed mid-session should not have it change under a question the user is
  // halfway through answering.
  const [snapshot] = useState(() => readTileSnapshot(siteId));

  return useMemo(() => {
    const fallback =
      (label && label !== siteId ? label : null) ?? getNsiteName(event) ?? 'nsite';

    if (snapshot) {
      return {
        name: snapshot.name,
        iconUrl: snapshot.icon,
        fit: snapshot.fit,
        background: snapshot.background,
      };
    }

    return { name: fallback, iconUrl: null, fit: 'cover', background: null };
  }, [snapshot, event, label, siteId]);
}

/**
 * The site's own answer for itself, once its manifest has been read, and the
 * tile until then.
 *
 * Whole records rather than field by field. A snapshot's icon belongs with a
 * snapshot's colour, and pairing today's artwork with yesterday's background
 * would produce a mark that has never been drawn anywhere.
 */
export function nsiteIdentity(app: NsiteApp | undefined, tile: NsiteIdentity): NsiteIdentity {
  if (!app) return tile;

  return {
    // A site that ships a manifest without naming itself in it keeps the name
    // it is already known by.
    name: app.label ?? tile.name,
    iconUrl: app.iconUrl,
    fit: app.fit,
    background: app.background,
  };
}
