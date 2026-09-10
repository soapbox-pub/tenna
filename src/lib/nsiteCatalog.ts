/**
 * A list of sites to pick from, folded out of raw manifests.
 *
 * Two screens ask for one: the "Add app" dialog, which asks after everybody
 * Tenna knows to ask after, and a publisher's page, which asks after one
 * person. Both get back the same rows and draw them the same way, so the part
 * that turns manifests into rows lives here rather than in either of them.
 */
import { type NostrEvent, NSchema as n } from '@nostrify/nostrify';

import { isServableNsite } from '@/lib/nsiteFiles';
import { getNsiteName, getNsiteSubdomain } from '@/lib/nsiteSubdomain';

/** One site to pick from: the manifest, and what to call it in the list. */
export interface NsiteCatalogEntry {
  event: NostrEvent;
  /**
   * The site's own name, or its author's, or null when neither says — a
   * manifest with no `title` under a pubkey with no profile. The caller draws
   * that case; only it knows what it has room to say instead.
   */
  name: string | null;
}

/** The longest name that still fits in a row, from the manifest or a profile. */
const NAME_LIMIT = 48;

/** Collapse whitespace and refuse anything too long to sit in a row. */
function tidyName(value: string | undefined): string | null {
  const name = value?.replace(/\s+/g, ' ').trim();
  return name && name.length <= NAME_LIMIT ? name : null;
}

/** What each pubkey's profile calls it, for the sites that don't name themselves. */
function namesByAuthor(profiles: NostrEvent[]): Map<string, string> {
  const byAuthor = new Map<string, string>();

  // Oldest first, so a newer profile overwrites what an older one said.
  for (const event of [...profiles].sort((a, b) => a.created_at - b.created_at)) {
    try {
      const metadata = n.json().pipe(n.metadata()).parse(event.content);
      const name = tidyName(metadata.name ?? metadata.display_name);
      if (name) byAuthor.set(event.pubkey, name);
    } catch {
      // A profile that doesn't parse names nothing.
    }
  }

  return byAuthor;
}

/** One row per site, newest manifest wins, named and sorted for the list. */
export function buildCatalog(
  manifests: NostrEvent[],
  profiles: NostrEvent[],
): NsiteCatalogEntry[] {
  const latest = new Map<string, NostrEvent>();
  for (const event of manifests.filter(isServableNsite)) {
    const id = getNsiteSubdomain(event);
    const seen = latest.get(id);
    if (!seen || seen.created_at < event.created_at) latest.set(id, event);
  }

  const byAuthor = namesByAuthor(profiles);

  return [...latest.values()]
    .map((event) => ({ event, name: getNsiteName(event) ?? byAuthor.get(event.pubkey) ?? null }))
    .sort((a, b) => {
      // The nameless go last. They are the rows a person scanning the list
      // can do least with, so they are the ones to scroll past.
      if (!a.name || !b.name) return a.name ? -1 : b.name ? 1 : 0;
      return a.name.localeCompare(b.name);
    });
}
