import { useSeoMeta } from '@unhead/react';
import { ArrowLeft } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { NsiteTile } from '@/components/NsiteTile';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthor } from '@/hooks/useAuthor';
import { useAuthorNsites } from '@/hooks/useAuthorNsites';
import { useProfileTheme } from '@/hooks/useProfileTheme';
import { useWall } from '@/hooks/useWall';
import { useWearTheme } from '@/hooks/useWearTheme';
import { notificationSuccess } from '@/lib/haptics';
import { getNsiteSubdomain } from '@/lib/nsiteSubdomain';
import { cn, middleEllipsis } from '@/lib/utils';
import { nsiteUri, parseWallUri } from '@/lib/wallUri';

/**
 * The lineup, laid out as the wall lays one out: columns that fit at 68px and
 * share out what's left, capped so a wide screen gets more apps across rather
 * than bigger ones. Written once for the tiles and the skeletons that stand in
 * for them, so the page doesn't change shape when they arrive.
 */
const GRID =
  'grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] justify-items-center gap-x-4 gap-y-7 sm:gap-x-6 sm:gap-y-8 [&>*]:max-w-24';

interface ProfilePageProps {
  /** Whose page this is. Hex, already decoded from whatever named them. */
  pubkey: string;
}

/**
 * A picture from somebody's profile, or nothing.
 *
 * `https:` only. A profile is a document a stranger wrote, its `picture` and
 * `banner` are whatever they put there, and both end up as a URL the app
 * fetches — so `javascript:` and `data:` are refused here rather than trusted
 * to be harmless in an `img`. Stricter than that isn't needed: React sets
 * these as DOM properties, so neither is ever parsed as CSS. See
 * `safeHttpsUrl` for the ones that are.
 */
function safeImage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The key itself, for a page that has to name somebody either way. */
function encodeNpub(pubkey: string): string | undefined {
  try {
    return nip19.npubEncode(pubkey);
  } catch {
    return undefined;
  }
}

/**
 * A publisher, and everything they publish.
 *
 * Reached by pressing whose an app is, on the App info screen of an app
 * already on the wall — the question that leads here is "who made this?", and
 * the answer worth giving is "them, and here is what else they make." So the
 * page is a face and a name over a list of sites, and the list behaves exactly
 * as the "Add app" list does: a press puts one on the wall, and one already
 * there says so instead.
 *
 * Nothing about a person is claimed that they didn't sign. The name and the
 * pictures are their own profile, and under them is the key itself, which is
 * the only thing here that is true whatever anybody published.
 *
 * The page is in their colours too, where they have published a theme —
 * Tenna spends the whole rest of its life in the logged-in user's, and this
 * one screen is about somebody else. It is the same theme Ditto shows a
 * visitor to their profile, read off the same event; see `useProfileTheme`.
 */
export function ProfilePage({ pubkey }: ProfilePageProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;

  const { data: sites, isLoading, error } = useAuthorNsites(pubkey);

  // Their theme, for as long as this page is up. Nothing is worn until the
  // question has been answered: `undefined` leaves the app in the user's own
  // colours meanwhile, where a premature `null` would strip them off for the
  // half second before the relay replies. See `useWearTheme`.
  const theirTheme = useProfileTheme(pubkey);
  useWearTheme(theirTheme.isFetched ? (theirTheme.data ?? null) : undefined);

  // Safe to hold here: `Routes` draws one route at a time, so the wall is
  // unmounted while this page is up and there is no second copy of the list
  // to disagree with. See `useWall`.
  const wall = useWall();

  const name = metadata?.display_name || metadata?.name || null;
  const fullNpub = useMemo(() => encodeNpub(pubkey), [pubkey]);
  const npub = fullNpub ? middleEllipsis(fullNpub, 21) : 'Unknown publisher';
  const picture = safeImage(metadata?.picture);
  const banner = safeImage(metadata?.banner);
  const about = metadata?.about?.trim();

  useSeoMeta({
    title: name ? `${name} on Tenna` : 'Publisher on Tenna',
    description: about || `The Nostr sites published by ${name ?? npub}.`,
  });

  // By subdomain rather than by URI, as in the picker: the same site added by
  // two different addresses carries two different relay hints and is one site.
  const added = useMemo(
    () =>
      new Set(
        wall.uris
          .map(parseWallUri)
          .filter((entry) => entry?.kind === 'nsite')
          .map((entry) => entry.id),
      ),
    [wall.uris],
  );

  // Back to wherever this was opened from, which is nearly always the wall.
  // A page opened cold — a link, a deep link — has nothing behind it, and
  // going back from one of those should still land somewhere rather than
  // leaving the app.
  const goBack = () => {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  return (
    // No background of its own, so a theme's wallpaper shows through here as
    // it does on the wall. See `ThemeBackground`.
    <main className="relative min-h-screen text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-background/80 px-4 pb-3 pt-safe-offset-3 backdrop-blur">
        <button
          type="button"
          onClick={goBack}
          aria-label="Back"
          className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/90 outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeft aria-hidden="true" className="size-6" />
        </button>

        <h1 className="text-xl font-semibold">Publisher</h1>
      </header>

      {/* The gap at the top is the bar's: the header is translucent and the
          page scrolls under it, so without it the banner starts where the
          title ends and the two read as one block. */}
      <div className="mx-auto max-w-2xl px-5 pb-safe-offset-16 pt-4 sm:px-8">
        {banner && (
          <img
            src={banner}
            alt=""
            className="h-32 w-full rounded-2xl object-cover sm:h-44"
          />
        )}

        <div className="flex flex-col items-center gap-4 px-1 pb-8 pt-4">
          {author.isPending ? (
            <Skeleton className="size-24 rounded-full bg-foreground/10" />
          ) : (
            <Avatar className="size-24 ring-4 ring-background/60">
              <AvatarImage src={picture} alt="" />
              <AvatarFallback className="bg-foreground/10 text-3xl text-foreground/80">
                {(name ?? npub).slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}

          {author.isPending ? (
            <Skeleton className="h-8 w-48 bg-foreground/10" />
          ) : (
            <h2 className="w-full break-words text-center text-3xl font-semibold leading-tight">
              {name ?? npub}
            </h2>
          )}

          {/* The key, under whatever the profile called itself. A name is a
              claim anybody could make and reuse; this is the thing that was
              signed, and the only line on the page nobody can borrow. It is
              left off where there is no name, since then the heading above is
              already this. */}
          {name && (
            <p title={fullNpub} className="-mt-2 max-w-full truncate font-mono text-sm text-foreground/50">
              {npub}
            </p>
          )}

          {/* `w-full` before the cap, or there isn't one: a bare `max-w-md` is
              448px, which is wider than the phone this is being read on, and
              a centred paragraph too wide for its column hangs off both edges
              of the screen at once. Everything else in this column is given
              its width for the same reason, from the other end — text left to
              size itself here is measured at its narrowest and breaks a line
              early. */}
          {about && (
            <p className="w-full max-w-md whitespace-pre-wrap break-words text-center text-base leading-relaxed text-foreground/75">
              {about}
            </p>
          )}
        </div>

        {/* Their apps, laid out as apps. The grid is the wall's own — as many
            columns as fit at 68px, so a tile here is the size and shape of the
            tile it becomes when it is pressed.

            A real surface rather than the 6% wash the other panels use, because
            this one is the only place on the page where small text sits over
            somebody else's wallpaper: a tile's name is 12px, and eight of them
            over a photograph is where a page in a stranger's theme stops being
            readable. Frosted rather than opaque, so their picture still shows
            through the thing it is being read against. */}
        <section className="rounded-2xl border border-border bg-card/70 px-4 py-5 backdrop-blur-md">
          <h3 className="px-1 pb-5 text-lg font-medium text-foreground">Apps</h3>

          {isLoading && (
            <>
              <span className="sr-only">Looking</span>
              <div className={cn(GRID, 'pb-1')} aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex w-full flex-col items-center gap-2">
                    <Skeleton className="app-squircle aspect-square w-full bg-foreground/10" />
                    <Skeleton className="h-3 w-3/4 bg-foreground/10" />
                  </div>
                ))}
              </div>
            </>
          )}

          {!isLoading && error && (
            <p role="alert" className="px-1 pb-2 text-base text-destructive">
              Could not reach the relay. Check your connection and try again.
            </p>
          )}

          {!isLoading && !error && sites?.length === 0 && (
            <p className="px-1 pb-2 text-base text-foreground/55">
              Nothing published under this key yet. Sites they put on Nostr will be listed here.
            </p>
          )}

          {!isLoading && !error && sites && sites.length > 0 && (
            <div className={cn(GRID, 'pb-1')}>
              {sites.map((entry) => (
                <NsiteTile
                  key={entry.event.id}
                  entry={entry}
                  added={added.has(getNsiteSubdomain(entry.event))}
                  onSelect={() => {
                    notificationSuccess();
                    wall.add(nsiteUri(getNsiteSubdomain(entry.event)));
                  }}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
