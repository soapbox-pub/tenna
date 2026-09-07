import { type NostrEvent, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useCacheFirstSeedMany } from '@/hooks/useCacheFirstSeed';
import { useFollows } from '@/hooks/useFollows';
import { isServableNsite } from '@/lib/nsiteFiles';
import {
  getNsiteName,
  getNsiteSubdomain,
  NSITE_NAMED_KIND,
  NSITE_ROOT_KIND,
} from '@/lib/nsiteSubdomain';
import { NSITE_CATALOG_PUBKEYS, NSITE_RELAY } from '@/lib/tenna';

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
function buildCatalog(manifests: NostrEvent[], profiles: NostrEvent[]): NsiteCatalogEntry[] {
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

/**
 * The nsites Tenna offers to install — Team Soapbox's apps, the clients Nsite
 * Packagers puts on Nostr, and whatever the people the user follows publish.
 *
 * The first two are a catalog in the ordinary sense: someone packaged these to
 * be installed. Follows are not that, and are the better half of the list
 * anyway — the web a person already keeps up with is a far better guess at
 * which sites they want on their wall than anything a publisher could pick for
 * them, and it is a list nobody has to curate.
 *
 * Root sites are here as well as named ones, because a root site is what a
 * person publishing for themselves ends up with: one site at their npub, no
 * `d` tag, and often no `title` either. Those are named after their author, so
 * a follow's site reads as the follow.
 *
 * A list to pick from rather than a lineup: nothing here is on the wall until
 * someone puts it there. Sorted by name, because that is the only order a
 * person scanning a list for one app can follow, and it is the order the
 * search box narrows.
 */
export function useNsiteCatalog() {
  const { nostr } = useNostr();
  const { data: follows, isLoading: followsLoading } = useFollows();

  const authors = useMemo(
    () => [...new Set([...NSITE_CATALOG_PUBKEYS, ...(follows ?? [])])],
    [follows],
  );

  const queryKey = useMemo(() => ['nsite-catalog', authors], [authors]);

  // Two round trips deep — the follow list, then the catalog, then the
  // profiles — this is the slowest list in the app to arrive, and almost all
  // of it was the same last time. Both halves come off disk at once: the
  // manifests, and every profile that might name one of them.
  useCacheFirstSeedMany<NsiteCatalogEntry[]>({
    queryKey: authors.length > 0 ? queryKey : undefined,
    filters: [
      { kinds: [NSITE_ROOT_KIND, NSITE_NAMED_KIND], authors, limit: 500 },
      { kinds: [0], authors },
    ],
    toData: (events) => {
      const manifests = events.filter((e) => e.kind !== 0);
      return manifests.length > 0
        ? buildCatalog(manifests, events.filter((e) => e.kind === 0))
        : undefined;
    },
  });

  return useQuery({
    // Waits for the follow list rather than running twice: a catalog that
    // arrives short and then reshuffles under the finger is worse than one
    // that arrives a moment later whole.
    enabled: !followsLoading,
    queryKey,
    queryFn: async (c): Promise<NsiteCatalogEntry[]> => {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.relay(NSITE_RELAY).query(
        [{ kinds: [NSITE_ROOT_KIND, NSITE_NAMED_KIND], authors, limit: 500 }],
        { signal },
      );

      const sites = events.filter(isServableNsite);

      // Only the sites that don't name themselves send us looking for their
      // author, and one query covers all of them.
      const anonymous = [...new Set(sites.filter((e) => !getNsiteName(e)).map((e) => e.pubkey))];

      const profiles = anonymous.length
        ? await nostr
            .query([{ kinds: [0], authors: anonymous, limit: anonymous.length }], { signal })
            .catch(() => [] as NostrEvent[])
        : [];

      return buildCatalog(sites, profiles);
    },
    staleTime: 60_000,
  });
}
