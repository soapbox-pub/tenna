import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import type { NostrEvent } from '@nostrify/nostrify';
import { Loader2, Search, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { NativeAppRow } from '@/components/NativeAppRow';
import { NsiteRow } from '@/components/NsiteRow';
import { useInstalledApps, useLaunchNativeApp } from '@/hooks/useNativeApps';
import { useNsiteAddress } from '@/hooks/useNsiteAddress';
import { useNsiteCatalog } from '@/hooks/useNsiteCatalog';
import { useNsiteOpener } from '@/hooks/useNsiteWindow';
import { useRecents } from '@/hooks/useRecents';
import { impactLight } from '@/lib/haptics';
import type { NativeApp } from '@/lib/nativeAppsPlugin';
import { getNsiteName, getNsiteSubdomain, nameFromSubdomain } from '@/lib/nsiteSubdomain';
import { appKey, recordLaunch, siteKey } from '@/lib/recents';
import { readTileSnapshot } from '@/lib/tileSnapshot';
import { cn } from '@/lib/utils';
import { parseWallUri } from '@/lib/wallUri';

interface WallSearchProps {
  /** Everything on the wall, in wall order. */
  uris: string[];
  /** The wall sites' manifests, by subdomain, as far as they have arrived. */
  events: Map<string, NostrEvent>;
  /**
   * Tune a site in over the wall, for the platforms where a site can't be
   * given a window of its own. See `useNsiteWindow`.
   */
  onTuneIn: (event: NostrEvent, channel?: number) => void;
  className?: string;
}

/**
 * Where a suggestion came from, which is also the order it falls in when
 * nothing better separates two of them.
 */
type Origin = 'wall' | 'device' | 'follows';

interface SiteSuggestion {
  kind: 'site';
  key: string;
  name: string;
  origin: Origin;
  event: NostrEvent;
  /** Its channel, where it is on the wall. A site off the wall has none. */
  channel?: number;
}

interface AppSuggestion {
  kind: 'app';
  key: string;
  name: string;
  origin: Origin;
  app: NativeApp;
}

type Suggestion = SiteSuggestion | AppSuggestion;

/** How far above everything else a thing opened lately sits. */
const RECENT_BONUS = 4000;

/** What a name beginning with what was typed is worth against one merely containing it. */
const PREFIX_BONUS = 400;

const ORIGIN_BONUS: Record<Origin, number> = { wall: 200, device: 100, follows: 0 };

/** As many rows as are worth scrolling before the box should have been narrowed. */
const MAX_RESULTS = 12;

/**
 * What to call a site in a list, before any of it has been fetched.
 *
 * The name it went by the last time it was drawn is the best of these: it is
 * the site's own word for itself, read out of the document it serves. What the
 * manifest says comes next, then whoever is offering the row has usually got
 * the publisher's name, and last is the address with nothing else to say.
 *
 * This is what the box filters on. A row may end up drawn under a better name
 * once its document arrives — `NsiteRow` prefers what the site says — so a
 * site never opened before can be findable under one name and drawn under
 * another. The alternative is fetching a document per row to type against,
 * which is a Blossom round trip for every site in the catalog.
 */
function siteName(event: NostrEvent, offered: string | null): string {
  const id = getNsiteSubdomain(event);
  return readTileSnapshot(id)?.name ?? offered ?? getNsiteName(event) ?? nameFromSubdomain(id);
}

function siteSuggestion(
  event: NostrEvent,
  origin: Origin,
  offered: string | null,
  channel?: number,
): SiteSuggestion {
  return {
    kind: 'site',
    key: siteKey(getNsiteSubdomain(event)),
    name: siteName(event, offered),
    origin,
    event,
    channel,
  };
}

/**
 * How high a suggestion sits: what was opened lately, then what the typing
 * points straight at, then whose list it is on.
 *
 * Recency outweighs everything that isn't recency, deliberately. The apps a
 * person actually uses are a handful, they use them over and over, and a bar
 * that answers three letters with last night's app is the one they stop
 * reading before pressing.
 */
function score(suggestion: Suggestion, needle: string, recency: Map<string, number>): number {
  const rank = recency.get(suggestion.key);
  const name = suggestion.name.toLowerCase();

  return (
    (rank === undefined ? 0 : RECENT_BONUS + rank) +
    (needle && name.startsWith(needle) ? PREFIX_BONUS : 0) +
    ORIGIN_BONUS[suggestion.origin]
  );
}

/**
 * The bar across the top of the wall: type a name, press the app.
 *
 * It is a browser's address bar, and it answers the two things one answers.
 * Most of what is typed into it is the beginning of a name, and the answer is
 * something the person already has — what is on their wall, the apps on the
 * device, and whatever they opened lately, which is nearly always what they
 * are reaching for now. The rest of the time it is an address, and the answer
 * is the site at it.
 *
 * Between those sit the sites published by the people they follow, fetched the
 * same way the "Add app" dialog fetches them. Nostr has no directory to search
 * and no index to rank, but a person's follows are a list they curated
 * themselves, and a site published by somebody they read is a better guess at
 * what they meant than anything a publisher could rank for them.
 *
 * Pressing a row opens the app; it does not add it to the wall. The wall is a
 * list a person arranges on purpose, and typing a name is not asking to
 * rearrange it — this is the way in for the thing you want *now*, and the plus
 * is still how something moves in for good. What is opened this way is
 * remembered, so the second time it is at the top of the list before the
 * letter finishes.
 *
 * Nothing here is asked for until the box is looked in: the catalog and the
 * device's app drawer are the two slowest lists in the app, and a wall that
 * fetched both on every cold start would pay for a search nobody ran.
 */
export function WallSearch({ uris, events, onTuneIn, className }: WallSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const recents = useRecents();
  const opener = useNsiteOpener();
  const launchApp = useLaunchNativeApp();

  const { data: catalog, isLoading: catalogLoading } = useNsiteCatalog({ enabled: open });
  const { data: installed, isLoading: installedLoading } = useInstalledApps({ enabled: open });
  const address = useNsiteAddress(query);

  const needle = query.trim().toLowerCase();

  // The wall as suggestions, in wall order, with each site's channel counted
  // the way the wall counts it — including the sites still waiting on a
  // manifest, so a number here is the number under the tile.
  //
  // A site whose manifest hasn't arrived is left out: its tile can't be
  // pressed either, and there is nothing to open.
  const wall = useMemo(() => {
    const out: Suggestion[] = [];
    let channel = 0;

    for (const uri of uris) {
      const parsed = parseWallUri(uri);
      if (!parsed) continue;

      if (parsed.kind === 'app') {
        const label = parsed.label ?? parsed.packageName;
        out.push({
          kind: 'app',
          key: appKey(parsed),
          name: label,
          origin: 'wall',
          app: {
            id: `${parsed.packageName}/${parsed.activityName}`,
            packageName: parsed.packageName,
            activityName: parsed.activityName,
            label,
          },
        });
      } else {
        const tuned = ++channel;
        const event = events.get(parsed.id);
        if (event) out.push(siteSuggestion(event, 'wall', null, tuned));
      }
    }

    return out;
  }, [uris, events]);

  const onWall = useMemo(() => new Set(wall.map(({ key }) => key)), [wall]);

  const device = useMemo(
    (): Suggestion[] =>
      (installed ?? [])
        .map((app): Suggestion => ({
          kind: 'app',
          key: appKey(app),
          name: app.label,
          origin: 'device',
          app,
        }))
        .filter(({ key }) => !onWall.has(key)),
    [installed, onWall],
  );

  const follows = useMemo(
    (): Suggestion[] =>
      (catalog ?? [])
        .map((entry): Suggestion => siteSuggestion(entry.event, 'follows', entry.name))
        .filter(({ key }) => !onWall.has(key)),
    [catalog, onWall],
  );

  const recency = useMemo(
    () => new Map(recents.map((key, i) => [key, recents.length - i])),
    [recents],
  );

  const results = useMemo((): Suggestion[] => {
    // An address names one site. Nothing else it could have been a substring
    // of is what the person meant.
    if (address.isAddress) {
      return address.event ? [siteSuggestion(address.event, 'follows', null)] : [];
    }

    const pool = [...wall, ...device, ...follows];

    // With nothing typed the box is a shortlist rather than a directory: what
    // was opened lately, and then the rest of what is already on the wall.
    const matched = needle
      ? pool.filter(({ name }) => name.toLowerCase().includes(needle))
      : pool.filter(({ key, origin }) => origin === 'wall' || recency.has(key));

    return matched
      .sort(
        (a, b) =>
          score(b, needle, recency) - score(a, needle, recency) || a.name.localeCompare(b.name),
      )
      .slice(0, MAX_RESULTS);
  }, [address.isAddress, address.event, wall, device, follows, needle, recency]);

  // Clamped rather than reset, so a list that shrinks under the finger leaves
  // the keyboard somewhere real.
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0));

  const loading = address.isAddress
    ? address.isLoading
    : results.length === 0 && (catalogLoading || installedLoading);

  const close = useCallback(() => {
    setOpen(false);
    inputRef.current?.blur();
  }, []);

  const select = useCallback(
    (suggestion: Suggestion) => {
      setOpen(false);
      setQuery('');
      inputRef.current?.blur();
      impactLight();

      // The device's own apps are handed to the OS, which also writes the
      // launch down — and only if the app was still there to open.
      if (suggestion.kind === 'app') {
        launchApp(suggestion.app);
        return;
      }

      recordLaunch(suggestion.key);

      // Off the wall as much as on it: a site opened from here gets a window
      // of its own wherever one can be had, the same as a tile. What it hasn't
      // got is the site's document — that is fetched per row and may not have
      // arrived — and nothing about opening a window needs it.
      if (opener.available) opener.open(suggestion.event, suggestion.name, undefined, suggestion.channel);
      else onTuneIn(suggestion.event, suggestion.channel);
    },
    [launchApp, opener, onTuneIn],
  );

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({
      block: 'nearest',
    });
  }, [open, activeIndex]);

  // A press anywhere else is a press on the wall, and the box should be out of
  // the way before it lands. Pointer-down rather than blur: a finger going for
  // a row would blur the box first, and a list that closed on that would be
  // gone before the press it was closing for arrived.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Back closes the list, the way it closes anything laid over the wall. Left
  // to the system it would close Tenna, which is not what "go back from the
  // search box" has ever meant.
  useEffect(() => {
    if (!open) return;

    let handle: PluginListenerHandle | undefined;
    let disposed = false;

    App.addListener('backButton', close)
      .then((listener) => {
        if (disposed) void listener.remove();
        else handle = listener;
      })
      .catch(() => {
        // No native shell to ask.
      });

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, [open, close]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {/* Everything behind the list is dimmed while it is up — the wall is a
          grid of things to press, and a list of things to press hanging over
          it needs to be the only one that reads as pressable. */}
      {open && (
        <div
          aria-hidden="true"
          onPointerDown={close}
          className="fixed inset-0 z-40 bg-background/70 backdrop-blur-[2px]"
        />
      )}

      <div className="relative z-50">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-foreground/45"
        />

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(changed) => {
            setQuery(changed.target.value);
            setOpen(true);
            // Another letter is another list. The keyboard goes back to the
            // top of it, which is where the answer usually is.
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(pressed) => {
            if (pressed.key === 'ArrowDown') {
              pressed.preventDefault();
              setOpen(true);
              setActive((current) => Math.min(current + 1, results.length - 1));
            } else if (pressed.key === 'ArrowUp') {
              pressed.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (pressed.key === 'Enter') {
              const picked = results[activeIndex];
              if (picked) {
                pressed.preventDefault();
                select(picked);
              }
            } else if (pressed.key === 'Escape') {
              pressed.preventDefault();
              close();
            }
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && results[activeIndex] ? `${listId}-${activeIndex}` : undefined
          }
          aria-label="Search your apps, or paste an address"
          placeholder="Search apps"
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={cn(
            'h-10 w-full rounded-full border border-foreground/15 bg-foreground/8 pl-10 pr-9',
            'text-base text-foreground outline-none transition-colors',
            'placeholder:text-foreground/45',
            'focus:border-primary/70 focus:bg-foreground/12',
          )}
        />

        {query && (
          <button
            type="button"
            aria-label="Clear"
            // The box keeps the caret: clearing is a thing done in the middle
            // of typing, not instead of it.
            onMouseDown={(pressed) => pressed.preventDefault()}
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-foreground/50 outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>

      {open && (
        <div
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Apps"
          // A press on a row must not take the caret out of the box first: the
          // row is drawn as highlighted because the box is where the keyboard
          // is, and it should still be there when the press lands.
          onMouseDown={(pressed) => pressed.preventDefault()}
          className={cn(
            // Wider than the box it hangs off, and anchored to its left edge:
            // the box shares the top of the screen with the way in, and a list
            // of apps narrowed to what is left over would cut every name in it
            // short. Half the screen at the outside, so the list stays above
            // whatever keyboard opened it.
            'absolute left-0 top-full z-50 mt-2 w-[calc(100vw-2.5rem)] max-w-[36rem]',
            'max-h-[min(26rem,50vh)] overflow-y-auto overscroll-contain',
            'rounded-2xl border border-foreground/12 bg-popover p-1 text-popover-foreground',
            'shadow-[0_16px_40px_rgba(0,0,0,0.55)]',
          )}
        >
          {loading && (
            <div className="flex items-center justify-center py-8 text-foreground/60">
              <Loader2 aria-hidden="true" className="size-5 animate-spin" />
              <span className="sr-only">Looking</span>
            </div>
          )}

          {!loading && address.isAddress && address.error && (
            <p role="alert" className="px-3 py-8 text-center text-sm text-destructive">
              Could not reach the relay. Check your connection and try again.
            </p>
          )}

          {!loading && results.length === 0 && !(address.isAddress && address.error) && (
            <p className="px-3 py-8 text-center text-sm text-foreground/60">
              {address.isAddress
                ? 'No site was found at that address.'
                : needle
                  ? 'No app by that name.'
                  : 'Nothing here yet. Press the plus to add an app.'}
            </p>
          )}

          {results.map((suggestion, i) => (
            <div
              key={suggestion.key}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === activeIndex}
            >
              {suggestion.kind === 'site' ? (
                <NsiteRow
                  entry={{ event: suggestion.event, name: suggestion.name }}
                  added={false}
                  highlighted={i === activeIndex}
                  // Whose site it is, for the ones that aren't the user's own
                  // already. On the wall it is a line of the same answer every
                  // time, in the room the site's own name wants.
                  publisher={suggestion.origin !== 'wall'}
                  onSelect={() => select(suggestion)}
                />
              ) : (
                <NativeAppRow
                  app={suggestion.app}
                  highlighted={i === activeIndex}
                  onSelect={() => select(suggestion)}
                />
              )}
            </div>
          ))}

          {/* The other half of what the box does, said once, where somebody
              who has just opened it will read it. */}
          {!needle && !loading && (
            <p className="px-3 py-2 text-center text-xs text-foreground/45">
              Or paste an naddr, an npub, or a site&rsquo;s address.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
