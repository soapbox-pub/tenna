import { type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import {
  AtSign,
  Ban,
  Bot,
  FileText,
  Film,
  Globe,
  Heart,
  Image as ImageIcon,
  Link2,
  Lock,
  Music,
  Quote,
  Radio,
  Repeat2,
  Server,
  Settings2,
  ShieldAlert,
  ThumbsDown,
  Trash2,
  UserRound,
  Users,
  Zap,
} from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { ComponentType, ReactNode } from 'react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthor } from '@/hooks/useAuthor';
import { useEvent } from '@/hooks/useEvent';
import {
  type DraftEvent,
  HEX64,
  parseDraftEvent,
  parseImeta,
  safeHttpsUrl,
  tagRows,
  tagValue,
  tagValues,
  truncate,
} from '@/lib/draftEvent';
import { getKindLabel } from '@/lib/kindLabels';
import { cn, middleEllipsis } from '@/lib/utils';

/**
 * How much of an event's text is worth putting in front of somebody deciding
 * whether to sign it.
 *
 * Generous rather than tight — this is the thing being agreed to, and an
 * article with its first paragraphs cut off is still recognisably the article
 * the writer meant to publish. The clamp below is what keeps the card short;
 * this only stops a 300 KB content field from being laid out at all.
 */
const MAX_CONTENT = 2000;

/** How many thumbnails a post gets before the rest are counted instead. */
const MAX_IMAGES = 4;

/** How many names, relays, or hashtags a list shows before it counts them. */
const MAX_ENTRIES = 8;

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** A profile's name as one line of it, or null where it says nothing. */
function tidyName(value: string | undefined): string | null {
  return value?.replace(/\s+/g, ' ').trim() || null;
}

/** A pubkey as something short enough to print, when nothing nicer is known. */
function shortNpub(pubkey: string): string {
  try {
    return middleEllipsis(nip19.npubEncode(pubkey), 15);
  } catch {
    return middleEllipsis(pubkey, 15);
  }
}

/** An event id as something short enough to print. */
function shortNote(id: string): string {
  try {
    return middleEllipsis(nip19.noteEncode(id), 15);
  } catch {
    return middleEllipsis(id, 15);
  }
}

/** A URL as the site it points at, for when the whole of it won't fit. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return middleEllipsis(url, 32);
  }
}

/**
 * Somebody named, by their profile where the app has one.
 *
 * An npub otherwise, and never nothing: "to" with a blank after it reads as a
 * missing recipient rather than an unfamiliar one, and the difference matters
 * when the question is who a message is being sent to.
 */
function PersonName({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = tidyName(data?.metadata?.display_name || data?.metadata?.name);

  return (
    <span className={cn('text-foreground', !name && 'font-mono')}>
      {name ?? shortNpub(pubkey)}
    </span>
  );
}

/** A line of aside above or below an event's own words. */
function Meta({ icon: Icon, children }: { icon: ComponentType<{ className?: string }>; children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

/**
 * How many lines each kind of text gets.
 *
 * Written out rather than interpolated, because Tailwind reads this file as
 * text to decide which utilities to generate and a class built at runtime is
 * one it never sees.
 */
const CLAMP = {
  3: 'line-clamp-3',
  4: 'line-clamp-4',
  6: 'line-clamp-6',
  8: 'line-clamp-8',
} as const;

/** What an event says, as it says it. */
function Prose({ text, clamp = 8 }: { text: string; clamp?: keyof typeof CLAMP }) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  return (
    <p className={cn('whitespace-pre-wrap break-words text-sm text-foreground', CLAMP[clamp])}>
      {truncate(trimmed, MAX_CONTENT)}
    </p>
  );
}

/** A heading an event gave itself: a subject, a title, a name. */
function Subject({ children }: { children: ReactNode }) {
  return <p className="break-words text-sm font-semibold text-foreground">{children}</p>;
}

/** Short strings in a row, each in its own box: relays, hashtags, kinds. */
function Pills({ items, mono = false }: { items: string[]; mono?: boolean }) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {items.slice(0, MAX_ENTRIES).map((item, i) => (
        <span
          key={i}
          className={cn(
            'max-w-full truncate rounded-md bg-foreground/10 px-1.5 py-0.5 text-xs text-foreground/80',
            mono && 'font-mono',
          )}
        >
          {truncate(item, 48)}
        </span>
      ))}
      {items.length > MAX_ENTRIES && (
        <span className="px-1 py-0.5 text-xs text-muted-foreground">
          +{items.length - MAX_ENTRIES}
        </span>
      )}
    </div>
  );
}

/** One face in a stack of them. */
function StackedFace({ pubkey }: { pubkey: string }) {
  const { data } = useAuthor(pubkey);
  const name = tidyName(data?.metadata?.display_name || data?.metadata?.name);

  return (
    <Avatar className="size-7 ring-2 ring-background">
      <AvatarImage src={safeHttpsUrl(data?.metadata?.picture)} alt="" />
      <AvatarFallback className="bg-foreground/10 text-[0.625rem] text-foreground/80">
        {(name ?? '?').slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * Who an event is about, as faces rather than keys.
 *
 * A follow list, a mute list, and a zap all name people in `p` tags, and 64
 * characters of hex says nothing about whether they are the people the user
 * meant. A handful of faces does, and the count carries the rest.
 */
function People({ pubkeys }: { pubkeys: string[] }) {
  if (pubkeys.length === 0) return null;

  const shown = pubkeys.slice(0, MAX_ENTRIES);

  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {shown.map((pubkey) => (
          <StackedFace key={pubkey} pubkey={pubkey} />
        ))}
      </div>
      {pubkeys.length > shown.length && (
        <span className="text-xs text-muted-foreground">+{pubkeys.length - shown.length}</span>
      )}
    </div>
  );
}

/**
 * The pictures a post is carrying.
 *
 * `https:` only, and loaded here — on the reasoning that these are files the
 * app has already uploaded somewhere public on the user's behalf, and the one
 * moment when seeing them is worth anything at all is before the post goes
 * out.
 */
function Images({ urls }: { urls: string[] }) {
  const safe = urls.map(safeHttpsUrl).filter((url): url is string => Boolean(url));
  if (safe.length === 0) return null;

  const shown = safe.slice(0, MAX_IMAGES);

  return (
    <div className={cn('grid gap-1', shown.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {shown.map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn(
            'w-full rounded-lg bg-foreground/5 object-cover',
            shown.length === 1 ? 'max-h-44' : 'aspect-square',
          )}
        />
      ))}
      {safe.length > shown.length && (
        <span className="col-span-full text-xs text-muted-foreground">
          and {safe.length - shown.length} more
        </span>
      )}
    </div>
  );
}

/**
 * Somebody else's note, fetched, because the event being signed is a sentence
 * about it.
 *
 * Reactions, reposts, and replies are all of that shape: the event itself is
 * almost empty and the note it points at is the whole of what is being agreed
 * to. Where the note cannot be found the id stands in — an honest "this one,
 * and Tenna could not fetch it" rather than a card that quietly omits what the
 * signature is about.
 */
function ReferencedEvent({ id, label }: { id: string; label: string }) {
  const { data: event, isLoading } = useEvent(id);

  return (
    <div className="space-y-1 rounded-lg border border-border/60 bg-background/40 p-2">
      <Meta icon={Quote}>{label}</Meta>

      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ) : event ? (
        <div className="space-y-1">
          <p className="truncate text-xs">
            <PersonName pubkey={event.pubkey} />
            <span className="text-muted-foreground"> · {getKindLabel(event.kind)}</span>
          </p>
          {event.content.trim() ? (
            <Prose text={event.content} clamp={3} />
          ) : (
            <p className="font-mono text-xs text-muted-foreground">{shortNote(id)}</p>
          )}
        </div>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">{shortNote(id)}</p>
      )}
    </div>
  );
}

/**
 * What an event points at, where that is the point of it.
 *
 * Prefers a `q` tag (a quote), then the reply marker, then the last `e` tag —
 * which is where NIP-10's positional form put the note being replied to, and
 * what clients that never adopted markers still write.
 */
function referencedId(event: DraftEvent): string | undefined {
  const rows = tagRows(event, 'e').filter(([, id]) => id && HEX64.test(id));
  const quote = tagValues(event, 'q').find((id) => HEX64.test(id));
  if (quote) return quote;

  const reply = rows.find((row) => row[3] === 'reply') ?? rows.find((row) => row[3] === 'root');
  return reply?.[1] ?? rows.at(-1)?.[1];
}

/** What a URL looks like when nothing has said what it is. */
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]|$)/i;

/**
 * Every picture a post carries, from its `imeta` tags and its `url` tags.
 *
 * Only the ones that are pictures. An `imeta` describing a video has a URL in
 * exactly the same place, and putting that in an `img` gets a broken frame
 * where the post's own thumbnail belongs — so a video's `image` or `thumb` is
 * taken instead, and a file that says nothing about itself is only believed
 * when its name ends in something an image ends in.
 */
function imageUrls(event: DraftEvent): string[] {
  const urls: string[] = [];

  const add = (url: string | undefined) => {
    if (url && !urls.includes(url)) urls.push(url);
  };

  const looksLikeImage = (url: string, mime: string | undefined) =>
    mime ? mime.startsWith('image/') : IMAGE_EXTENSION.test(url);

  for (const tag of tagRows(event, 'imeta')) {
    const fields = parseImeta(tag);
    const url = fields.get('url');

    if (url && looksLikeImage(url, fields.get('m'))) add(url);
    else add(fields.get('image') ?? fields.get('thumb'));
  }

  // The bare forms, for the kinds that carry one file rather than a list of
  // them: `url` with an `m` beside it (NIP-94), and `image`, which is a
  // thumbnail wherever it appears and so is always taken.
  const mime = tagValue(event, 'm');
  for (const url of tagValues(event, 'url')) {
    if (looksLikeImage(url, mime)) add(url);
  }
  for (const url of tagValues(event, 'image')) add(url);

  return urls;
}

// ---------------------------------------------------------------------------
// One renderer per thing an event can be
// ---------------------------------------------------------------------------

/** Kind 0: the profile itself, rather than the JSON it is written in. */
function ProfileBody({ event }: { event: DraftEvent }) {
  let metadata: NostrMetadata | undefined;
  try {
    metadata = n.json().pipe(n.metadata()).parse(event.content);
  } catch {
    metadata = undefined;
  }

  // Unparseable content in a kind 0 is worth saying plainly: it is the one
  // kind where the content *is* the structure, and an app about to replace a
  // profile with something malformed is a thing to notice before signing.
  if (!metadata) {
    return (
      <>
        <Meta icon={UserRound}>Profile details Tenna could not read</Meta>
        <Prose text={event.content} clamp={4} />
      </>
    );
  }

  const name = tidyName(metadata.display_name || metadata.name);

  return (
    <>
      <div className="flex items-center gap-3">
        <Avatar className="size-12">
          <AvatarImage src={safeHttpsUrl(metadata.picture)} alt="" />
          <AvatarFallback className="bg-foreground/10">
            {(name ?? '?').slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{name ?? 'No name'}</p>
          {metadata.nip05 && (
            <p className="truncate text-xs text-muted-foreground">{metadata.nip05}</p>
          )}
        </div>
      </div>

      {metadata.about && <Prose text={metadata.about} clamp={4} />}

      <Pills
        items={[metadata.website, metadata.lud16].filter((v): v is string => Boolean(v))}
      />
    </>
  );
}

/** Kinds 1, 11, 1111 and the rest of the things a person writes in words. */
function NoteBody({ event }: { event: DraftEvent }) {
  const subject = tagValue(event, 'title') ?? tagValue(event, 'subject');
  const target = referencedId(event);
  const quoted = tagValues(event, 'q').some((id) => HEX64.test(id));
  const images = imageUrls(event);
  const hashtags = tagValues(event, 't');
  const mentions = tagValues(event, 'p').filter((p) => HEX64.test(p));

  return (
    <>
      {subject && <Subject>{truncate(subject, 140)}</Subject>}
      <Prose text={event.content} />
      <Images urls={images} />

      {target && <ReferencedEvent id={target} label={quoted ? 'Quoting' : 'Replying to'} />}

      {hashtags.length > 0 && <Pills items={hashtags.map((tag) => `#${tag}`)} />}

      {/* Who the note addresses, which is not always who wrote it to. A `p`
          tag is what puts a post in somebody's notifications, and a post
          tagging people the writer never mentioned is the oldest trick in
          Nostr spam. */}
      {mentions.length > 0 && (
        <div className="flex items-center gap-2">
          <AtSign aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <People pubkeys={mentions} />
        </div>
      )}
    </>
  );
}

/** Kinds 20, 21, 22, 1063: a post whose point is the file attached to it. */
function MediaBody({ event }: { event: DraftEvent }) {
  const title = tagValue(event, 'title');
  const images = imageUrls(event);
  const video = event.kind === 21 || event.kind === 22;
  const mime = tagValue(event, 'm') ?? '';
  const audio = mime.startsWith('audio/');

  const icon = video ? Film : audio ? Music : ImageIcon;
  const files = tagRows(event, 'imeta')
    .map((tag) => parseImeta(tag).get('url'))
    .filter((url): url is string => Boolean(url));

  return (
    <>
      {title && <Subject>{truncate(title, 140)}</Subject>}
      <Prose text={event.content} clamp={4} />
      <Images urls={images} />

      {images.length === 0 && (
        <Meta icon={icon}>
          {files.length > 0
            ? files.map((url) => hostOf(url)).join(', ')
            : getKindLabel(event.kind)}
        </Meta>
      )}
    </>
  );
}

/** Kinds 6 and 16: somebody else's event, passed on under the user's name. */
function RepostBody({ event }: { event: DraftEvent }) {
  // Clients put the whole reposted event in `content`, which makes this the
  // one case where the thing being endorsed needs no relay at all.
  const inner = parseDraftEvent(event.content);
  const target = referencedId(event);

  return (
    <>
      <Meta icon={Repeat2}>Reposting</Meta>
      {inner ? (
        <NestedEvent event={inner} />
      ) : target ? (
        <ReferencedEvent id={target} label="Reposting" />
      ) : (
        <Prose text={event.content} clamp={3} />
      )}
    </>
  );
}

/** Kinds 7 and 17: a reaction, which is one character about something else. */
function ReactionBody({ event }: { event: DraftEvent }) {
  const content = event.content.trim();
  const target = referencedId(event);
  const website = tagValues(event, 'r')[0];

  // A NIP-30 custom emoji is a shortcode in the content and a URL in a tag;
  // without the tag the content reads as `:shrug:`, which is not what the user
  // pressed.
  const shortcode = /^:([a-zA-Z0-9_-]+):$/.exec(content)?.[1];
  const emojiUrl = shortcode
    ? safeHttpsUrl(tagRows(event, 'emoji').find(([, code]) => code === shortcode)?.[2])
    : undefined;

  const glyph = emojiUrl ? (
    <img src={emojiUrl} alt={content} className="size-7 object-contain" />
  ) : content === '+' || content === '' ? (
    <Heart aria-hidden="true" className="size-6 fill-rose-500 text-rose-500" />
  ) : content === '-' ? (
    <ThumbsDown aria-hidden="true" className="size-6 text-muted-foreground" />
  ) : (
    <span className="text-2xl leading-none">{truncate(content, 8)}</span>
  );

  return (
    <>
      <div className="flex items-center gap-2">
        {glyph}
        <span className="text-xs text-muted-foreground">Reacting</span>
      </div>

      {website && <Meta icon={Globe}>{hostOf(website)}</Meta>}
      {target && <ReferencedEvent id={target} label="To" />}
    </>
  );
}

/** Kind 5: a request that relays forget something the user already signed. */
function DeletionBody({ event }: { event: DraftEvent }) {
  const ids = tagValues(event, 'e').filter((id) => HEX64.test(id));
  const addresses = tagValues(event, 'a');
  const kinds = tagValues(event, 'k').map((k) => getKindLabel(Number(k)));
  const count = ids.length + addresses.length;

  return (
    <>
      <Meta icon={Trash2}>
        Asking relays to delete {count === 1 ? 'one event' : `${count} events`}
      </Meta>

      {kinds.length > 0 && <Pills items={kinds} />}
      {ids.length > 0 && <Pills items={ids.map(shortNote)} mono />}
      {addresses.length > 0 && <Pills items={addresses} mono />}

      {/* Deletion requests carry a reason, and it is the author's own words. */}
      <Prose text={event.content} clamp={3} />

      {/* Worth stating outright, because it is the part people are surprised
          by: a deletion is a request, not an erasure, and the events are
          already on relays that may ignore it. */}
      <p className="text-xs text-muted-foreground">
        Relays are asked, not told. Copies may remain.
      </p>
    </>
  );
}

/** Kind 3: who the user follows — the whole list, every time. */
function FollowsBody({ event }: { event: DraftEvent }) {
  const pubkeys = tagValues(event, 'p').filter((p) => HEX64.test(p));

  return (
    <>
      <Meta icon={Users}>
        {pubkeys.length === 1 ? 'Following 1 account' : `Following ${pubkeys.length} accounts`}
      </Meta>
      <People pubkeys={pubkeys} />

      {/* A contact list replaces the old one outright, so an app that sends a
          short one is about to unfollow everybody missing from it. The number
          above is the only warning of that there can be. */}
      {pubkeys.length === 0 && (
        <p className="text-xs text-muted-foreground">
          This would replace your follow list with an empty one.
        </p>
      )}
    </>
  );
}

/** The kinds whose content is ciphertext, and so is not shown at all. */
function EncryptedBody({ event }: { event: DraftEvent }) {
  const recipients = tagValues(event, 'p').filter((p) => HEX64.test(p));

  return (
    <>
      <Meta icon={Lock}>{getKindLabel(event.kind)} · encrypted</Meta>

      {recipients.length > 0 && (
        <p className="truncate text-xs text-muted-foreground">
          To{' '}
          {recipients.map((pubkey, i) => (
            <span key={pubkey}>
              {i > 0 && ', '}
              <PersonName pubkey={pubkey} />
            </span>
          ))}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Tenna cannot read this, and neither can anyone but its recipients.
      </p>
    </>
  );
}

/** Kind 9734: the part of a zap the user signs, which is the amount. */
function ZapRequestBody({ event }: { event: DraftEvent }) {
  const millisats = Number(tagValue(event, 'amount'));
  const sats = Number.isFinite(millisats) ? Math.round(millisats / 1000) : null;
  const recipients = tagValues(event, 'p').filter((p) => HEX64.test(p));
  const target = referencedId(event);

  return (
    <>
      <div className="flex items-baseline gap-1.5">
        <Zap aria-hidden="true" className="size-5 shrink-0 self-center text-amber-500" />
        <span className="text-lg font-semibold text-foreground">
          {sats === null ? 'Zap' : `${sats.toLocaleString()} sats`}
        </span>
        {recipients[0] && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            to <PersonName pubkey={recipients[0]} />
          </span>
        )}
      </div>

      <Prose text={event.content} clamp={3} />
      {target && <ReferencedEvent id={target} label="For" />}
    </>
  );
}

/** Kinds 10002 and its relatives: a list of relays, with what each is for. */
function RelayListBody({ event }: { event: DraftEvent }) {
  const rows = [...tagRows(event, 'r'), ...tagRows(event, 'relay')];

  const relays = rows
    .filter(([, url]) => Boolean(url))
    .map(([, url, marker]) => {
      const suffix = marker === 'read' ? ' · read' : marker === 'write' ? ' · write' : '';
      return `${url.replace(/^wss:\/\//, '')}${suffix}`;
    });

  return (
    <>
      <Meta icon={Server}>
        {relays.length === 1 ? '1 relay' : `${relays.length} relays`}
      </Meta>
      <Pills items={relays} mono />
    </>
  );
}

/** Kind 22242: proving to one relay, right now, that the key is the user's. */
function AuthBody({ event }: { event: DraftEvent }) {
  const relay = tagValue(event, 'relay');

  return (
    <>
      <Meta icon={Radio}>{relay ? relay.replace(/^wss:\/\//, '') : 'A relay'}</Meta>
      <p className="text-sm text-foreground">
        Proving to this relay that the account is yours.
      </p>
      {/* The one signature that is never published. Worth saying, because it
          is what makes this the least consequential of the signing requests
          and people should be able to tell those apart. */}
      <p className="text-xs text-muted-foreground">
        Used once, by that relay only. Nothing is posted.
      </p>
    </>
  );
}

/** Kind 27235: the same, for an HTTP request. */
function HttpAuthBody({ event }: { event: DraftEvent }) {
  const url = tagValue(event, 'u');
  const method = tagValue(event, 'method') ?? 'GET';

  return (
    <>
      <Meta icon={Link2}>
        {method} {url ? hostOf(url) : 'a server'}
      </Meta>
      {url && <p className="break-all font-mono text-xs text-muted-foreground">{truncate(url, 160)}</p>}
      <p className="text-xs text-muted-foreground">
        Proves the account is yours to whoever receives the request.
      </p>
    </>
  );
}

/** Kinds 30023 and 30024: long-form writing, as its cover and its opening. */
function ArticleBody({ event }: { event: DraftEvent }) {
  const title = tagValue(event, 'title');
  const summary = tagValue(event, 'summary');
  const image = safeHttpsUrl(tagValue(event, 'image'));
  const hashtags = tagValues(event, 't');

  return (
    <>
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          className="max-h-32 w-full rounded-lg bg-foreground/5 object-cover"
        />
      )}
      <Subject>{title ? truncate(title, 160) : 'Untitled'}</Subject>
      {summary && <Prose text={summary} clamp={3} />}
      {!summary && <Prose text={event.content} clamp={4} />}
      {hashtags.length > 0 && <Pills items={hashtags.map((tag) => `#${tag}`)} />}
      {event.kind === 30024 && <Meta icon={FileText}>Draft — not published publicly</Meta>}
    </>
  );
}

/** Kind 1984: a report, which is an accusation with the user's name on it. */
function ReportBody({ event }: { event: DraftEvent }) {
  const type = tagRows(event, 'p')[0]?.[2] ?? tagRows(event, 'e')[0]?.[2];
  const reported = tagValues(event, 'p').filter((p) => HEX64.test(p))[0];
  const target = referencedId(event);

  return (
    <>
      <Meta icon={ShieldAlert}>Reporting{type ? ` · ${type}` : ''}</Meta>
      {reported && (
        <p className="truncate text-sm">
          <PersonName pubkey={reported} />
        </p>
      )}
      <Prose text={event.content} clamp={3} />
      {target && <ReferencedEvent id={target} label="About" />}
    </>
  );
}

/** Kinds 5128 and up: a file of a website, published to Nostr. */
function NsiteBody({ event }: { event: DraftEvent }) {
  const path = tagValue(event, 'd');
  const hash = tagValue(event, 'x') ?? tagValue(event, 'sha256');
  const name = tagValue(event, 'name') ?? tagValue(event, 'title');

  return (
    <>
      {name && <Subject>{truncate(name, 140)}</Subject>}
      <Meta icon={Globe}>{path ?? getKindLabel(event.kind)}</Meta>
      {hash && <p className="break-all font-mono text-xs text-muted-foreground">{hash}</p>}
    </>
  );
}

/** Kind 30078 and friends: an app's own storage, kept under the user's key. */
function AppDataBody({ event }: { event: DraftEvent }) {
  const identifier = tagValue(event, 'd');

  return (
    <>
      <Meta icon={Settings2}>{identifier ? `Settings · ${identifier}` : 'App settings'}</Meta>
      <p className="text-xs text-muted-foreground">
        {event.content.length > 0
          ? `${event.content.length.toLocaleString()} characters of app data.`
          : 'No data.'}
      </p>
    </>
  );
}

/** Kinds 5000–7999: work handed to, or returned from, a paid machine. */
function JobBody({ event }: { event: DraftEvent }) {
  const inputs = tagRows(event, 'i').map(([, value]) => value).filter(Boolean);
  const providers = tagValues(event, 'p').filter((p) => HEX64.test(p));

  return (
    <>
      <Meta icon={Bot}>{getKindLabel(event.kind)}</Meta>
      {inputs.length > 0 && <Pills items={inputs} />}
      <Prose text={event.content} clamp={3} />
      {providers.length > 0 && <People pubkeys={providers} />}
    </>
  );
}

/**
 * The NIP-51 lists and sets: what is in one, and how much of it.
 *
 * All of these put their substance in tags — a mute list has nothing in its
 * content, and an app that sends a short one is replacing a long one. So the
 * counts come first, and the entries themselves in whatever form reads: faces
 * for people, text for everything else.
 */
function ListBody({ event }: { event: DraftEvent }) {
  const title = tagValue(event, 'title') ?? tagValue(event, 'name');
  const identifier = tagValue(event, 'd');
  const people = tagValues(event, 'p').filter((p) => HEX64.test(p));
  const hashtags = tagValues(event, 't');
  const events = tagValues(event, 'e').filter((id) => HEX64.test(id));
  const addresses = tagValues(event, 'a');
  const relays = [...tagValues(event, 'relay'), ...tagValues(event, 'r')];
  const emoji = tagRows(event, 'emoji').map(([, code]) => code).filter(Boolean);
  const kinds = tagValues(event, 'k').map((k) => getKindLabel(Number(k)));

  const total = people.length + hashtags.length + events.length + addresses.length +
    relays.length + emoji.length + kinds.length;

  return (
    <>
      {title && <Subject>{truncate(title, 140)}</Subject>}

      <Meta icon={Users}>
        {identifier && identifier !== title ? `${identifier} · ` : ''}
        {total === 1 ? '1 entry' : `${total} entries`}
      </Meta>

      {people.length > 0 && <People pubkeys={people} />}
      {hashtags.length > 0 && <Pills items={hashtags.map((tag) => `#${tag}`)} />}
      {emoji.length > 0 && <Pills items={emoji.map((code) => `:${code}:`)} />}
      {kinds.length > 0 && <Pills items={kinds} />}
      {relays.length > 0 && <Pills items={relays.map((url) => url.replace(/^wss:\/\//, ''))} mono />}
      {events.length > 0 && <Pills items={events.map(shortNote)} mono />}
      {addresses.length > 0 && <Pills items={addresses} mono />}

      {/* A list event replaces the previous one wholesale, and the private
          half of a NIP-51 list lives in encrypted content that nothing here
          can count. Both are reasons the number above may not be the whole
          list. */}
      {event.content.length > 0 && (
        <p className="text-xs text-muted-foreground">Plus private entries Tenna cannot read.</p>
      )}
    </>
  );
}

/**
 * Anything addressable that gave itself a title.
 *
 * Classifieds, calendar events, live streams, wikis, feeds, and whatever is
 * published next: a kind this app has never heard of still gets a card with
 * its name on it as long as it follows the convention every one of those
 * follows.
 */
function TitledBody({ event }: { event: DraftEvent }) {
  const title = tagValue(event, 'title') ?? tagValue(event, 'name');
  const summary = tagValue(event, 'summary') ?? tagValue(event, 'description');
  const image = safeHttpsUrl(tagValue(event, 'image') ?? tagValue(event, 'picture'));
  const price = tagRows(event, 'price')[0];
  const hashtags = tagValues(event, 't');

  return (
    <>
      {image && (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          className="max-h-32 w-full rounded-lg bg-foreground/5 object-cover"
        />
      )}
      <Subject>{truncate(title ?? getKindLabel(event.kind), 160)}</Subject>
      {price && (
        <p className="text-sm text-foreground">
          {price[1]} {price[2] ?? ''}
        </p>
      )}
      {summary ? <Prose text={summary} clamp={3} /> : <Prose text={event.content} clamp={4} />}
      {hashtags.length > 0 && <Pills items={hashtags.map((tag) => `#${tag}`)} />}
    </>
  );
}

/**
 * A kind nothing here knows, shown as plainly as possible.
 *
 * Which means the tags, in full. They are where an event of an unfamiliar kind
 * keeps everything a reader would want to know — who is addressed, what is
 * referenced, what is being replaced — and a card that showed only `content`
 * for an event whose content is empty would be a card that said nothing while
 * appearing to explain. The `alt` tag goes first, because NIP-31 exists for
 * exactly this moment: it is the author's own one-line answer to "what is
 * this?".
 */
function GenericBody({ event }: { event: DraftEvent }) {
  const alt = tagValue(event, 'alt');
  const rest = event.tags.filter(([name]) => name !== 'alt');

  return (
    <>
      {alt && <Prose text={alt} clamp={3} />}
      <Prose text={event.content} clamp={6} />

      {rest.length > 0 && (
        <ul className="space-y-1">
          {rest.slice(0, 12).map(([name, ...values], i) => (
            <li key={i} className="flex gap-2 text-xs">
              <span className="shrink-0 font-mono font-medium text-muted-foreground">
                {truncate(name, 16)}
              </span>
              <span className="min-w-0 break-all font-mono">{truncate(values.join(' '), 120)}</span>
            </li>
          ))}
          {rest.length > 12 && (
            <li className="text-xs text-muted-foreground">and {rest.length - 12} more</li>
          )}
        </ul>
      )}

      {!alt && !event.content.trim() && rest.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing in it but its kind.</p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/** Kinds whose content is ciphertext: seals, wraps, DMs, wallet traffic. */
const ENCRYPTED_KINDS = new Set([4, 13, 1059, 1060, 17375, 7375, 7376, 23194, 23195, 24133]);

/** NIP-51 lists and sets — the ones whose substance is a pile of tags. */
const LIST_KINDS = new Set([
  10000, 10001, 10003, 10004, 10005, 10006, 10007, 10009, 10012, 10015, 10020, 10030, 10050,
  30000, 30001, 30002, 30003, 30004, 30005, 30006, 30007, 30015, 30030, 39089, 39092,
]);

/**
 * What kind of thing this is, drawn as that thing.
 *
 * The one place in Tenna that knows what a Nostr event looks like, because it
 * is the one place that has to: a person being asked to sign something is
 * being asked about its meaning, and "kind 7, one tag" is not a meaning. Every
 * branch below exists because the generic card said nothing useful about that
 * kind — a reaction with no note, a follow list with no names, a profile shown
 * as its own JSON.
 *
 * Unknown kinds are the normal case rather than the failure case. Nostr gets
 * new ones faster than any client can follow, so the last three branches are
 * the load-bearing ones: a title, a tag pile, or the honest generic card.
 */
function EventBody({ event }: { event: DraftEvent }) {
  switch (event.kind) {
    // The profile, and the follow list: the two replaceable events every
    // client writes, and the two whose replacement is destructive.
    case 0:
      return <ProfileBody event={event} />;
    case 3:
      return <FollowsBody event={event} />;

    // Things written in words.
    case 1:
    case 9:
    case 11:
    case 12:
    case 24:
    case 42:
    case 1111:
    case 1222:
    case 1244:
    case 1311:
    case 1337:
    case 9802:
      return <NoteBody event={event} />;

    // Things whose point is the file attached.
    case 20:
    case 21:
    case 22:
    case 1063:
      return <MediaBody event={event} />;

    case 5:
      return <DeletionBody event={event} />;

    case 6:
    case 16:
      return <RepostBody event={event} />;

    case 7:
    case 17:
      return <ReactionBody event={event} />;

    case 9734:
      return <ZapRequestBody event={event} />;

    case 1984:
      return <ReportBody event={event} />;

    // The relay lists. Different kinds, same single question: which relays.
    case 10002:
    case 10006:
    case 10007:
    case 10013:
    case 10051:
    case 30166:
      return <RelayListBody event={event} />;

    // The two signatures that are never published, and so are the two that
    // matter least. Drawn so they can be told apart from the ones that are.
    case 22242:
      return <AuthBody event={event} />;
    case 27235:
      return <HttpAuthBody event={event} />;

    case 30023:
    case 30024:
      return <ArticleBody event={event} />;

    // An nsite's own files — the kind Tenna is a browser for.
    case 5128:
    case 15128:
    case 34128:
    case 35128:
      return <NsiteBody event={event} />;

    case 30078:
      return <AppDataBody event={event} />;

    default:
      // Ciphertext first, because two of the kinds that carry it — the Cashu
      // wallet's — sit inside the job range below and are not jobs.
      if (ENCRYPTED_KINDS.has(event.kind)) return <EncryptedBody event={event} />;

      // Ranges, which a switch cannot say. NIP-90's job kinds run 5000–7999,
      // and NIP-51's lists are scattered across two replaceable ranges.
      if (event.kind >= 5000 && event.kind < 8000) return <JobBody event={event} />;
      if (LIST_KINDS.has(event.kind)) return <ListBody event={event} />;

      // Anything addressable that named itself gets a card with its name on
      // it, known kind or not.
      if (tagValue(event, 'title') ?? tagValue(event, 'name')) {
        return <TitledBody event={event} />;
      }

      return <GenericBody event={event} />;
  }
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * Who is about to have signed it.
 *
 * The key goes under the name by default, and that is the point of the line: a
 * display name is a string anybody may write in their own profile, and the
 * question this whole window exists to ask is which account is being used. It
 * is also what the sheet used to say in a footnote reading "Signing as Alex
 * Gleason" — the same fact, in the place a person already reads it, since this
 * is where every other client puts the author of a post.
 */
function Byline({ pubkey, subtitle }: { pubkey: string | undefined; subtitle?: string }) {
  const { data } = useAuthor(pubkey);
  const metadata = data?.metadata;
  const name = tidyName(metadata?.display_name || metadata?.name);

  // Not written twice when the profile has no name: the npub is then already
  // the headline, and repeating it under itself says nothing.
  const under = subtitle ?? (name && pubkey ? shortNpub(pubkey) : undefined);

  return (
    <div className="flex items-center gap-2.5">
      <Avatar className="size-9 shrink-0">
        <AvatarImage src={safeHttpsUrl(metadata?.picture)} alt="" />
        <AvatarFallback className="bg-foreground/10 text-xs text-foreground/80">
          {(name ?? '?').slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">
          {name ?? (pubkey ? shortNpub(pubkey) : 'Your account')}
        </p>
        {under && (
          <p className="truncate font-mono text-xs text-muted-foreground">{under}</p>
        )}
      </div>
    </div>
  );
}

/**
 * An event inside another event: a repost's subject, and nothing deeper.
 *
 * Named by kind rather than by key, because here the question has changed —
 * whose account is signing is settled by the card around this one, and what is
 * being passed on under their name is not.
 */
function NestedEvent({ event }: { event: DraftEvent }) {
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 p-2">
      <Byline pubkey={event.pubkey} subtitle={getKindLabel(event.kind)} />
      <EventBody event={event} />
    </div>
  );
}

/**
 * An event as the post it is about to become.
 *
 * The whole of what a signing request is asking, in the shape the user will
 * see it in once it is out: their face and their name over the thing, because
 * the signature puts both there. That is also why nothing else in the prompt
 * has to say who is signing — this says it, in the place where a person
 * already reads it.
 *
 * It is drawn from the draft alone. Nothing here is fetched except the
 * profiles of the people named in it and, where an event is a sentence about
 * another event, that other event — see `ReferencedEvent`.
 */
export function EmbeddedEvent({
  event,
  pubkey,
  className,
}: {
  event: DraftEvent;
  /**
   * Who would sign it, when the draft does not say.
   *
   * Most do not: a `pubkey` is one of the three fields signing adds, and an
   * app that sends a template without one is the normal case rather than a
   * suspicious one. What it must not do is disagree — a draft naming somebody
   * else is shown as naming them, because that is what would be signed.
   */
  pubkey?: string;
  className?: string;
}) {
  const author = event.pubkey ?? pubkey;

  // Kind 0 is the exception: the card *is* a person, drawn from the profile
  // being published rather than from the one on relays now. A byline above it
  // would be the same face twice, once out of date.
  const byline = event.kind !== 0;

  return (
    <div className={cn('space-y-2.5 rounded-xl border bg-muted/30 p-3', className)}>
      {byline && <Byline pubkey={author} />}
      <EventBody event={event} />
    </div>
  );
}

/** What the prompt shows when there is no event to show. */
export function UnreadableEvent({ kind }: { kind: number | null }) {
  return (
    <div className="space-y-1 rounded-xl border border-dashed p-3">
      <Meta icon={Ban}>{kind === null ? 'Unreadable event' : getKindLabel(kind)}</Meta>
      <p className="text-xs text-muted-foreground">
        Tenna could not read what this app sent, so there is nothing to show but the request
        itself. Deny it unless you know what it is.
      </p>
    </div>
  );
}
