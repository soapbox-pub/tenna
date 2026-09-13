/**
 * An event on its way to being signed, and the small vocabulary for reading
 * one.
 *
 * What arrives at a permission prompt is not a `NostrEvent`: it has no `id`,
 * no `sig`, and often no `pubkey` either — those are the three things signing
 * would add. It also arrives from somewhere untrusted, as JSON text from
 * another application or as a bare object over an nsite's provider channel, so
 * nothing in it can be assumed to have the shape it claims. Everything below
 * treats the input as unknown and gives back only what it could confirm.
 */

/** A 32-byte key or id, as it is written in an event. */
export const HEX64 = /^[0-9a-f]{64}$/;

/** An unsigned event, once it has been read carefully enough to draw. */
export interface DraftEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
  /** Who will sign it, when the app that sent it says so. Often absent. */
  pubkey?: string;
}

/**
 * Read an event out of whatever the prompt was handed.
 *
 * Returns null when there is no event in it at all, or when the one that is
 * there has no kind — an event whose kind cannot be read is one nothing here
 * can describe, and saying so is better than drawing a card about "Kind NaN".
 */
export function parseDraftEvent(input: unknown): DraftEvent | null {
  let value = input;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      // An event that cannot be read is as opaque to us as it is to the person
      // being asked about it, and the prompt says that rather than hiding it.
      return null;
    }
  }

  if (typeof value !== 'object' || value === null) return null;

  const record = value as Record<string, unknown>;

  const kind = record.kind;
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0) return null;

  // Tags are filtered rather than trusted: one row of the wrong shape in the
  // middle of a list would otherwise throw while the card is being drawn, and
  // a malformed tag is exactly the kind of thing a hostile caller sends.
  const tags = Array.isArray(record.tags)
    ? (record.tags as unknown[]).filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((part) => typeof part === 'string'),
      )
    : [];

  const pubkey = typeof record.pubkey === 'string' && HEX64.test(record.pubkey)
    ? record.pubkey
    : undefined;

  return {
    kind,
    content: typeof record.content === 'string' ? record.content : '',
    tags,
    created_at: typeof record.created_at === 'number' ? record.created_at : undefined,
    pubkey,
  };
}

/**
 * The request as it arrived, laid out to be read.
 *
 * Pretty-printed where it is JSON, and verbatim where it is not — text that
 * would not parse is exactly the case where a reader most needs to see what
 * actually came in, and replacing it with `null` would hide the only evidence
 * there is. Everything the card above chose not to draw is in here.
 */
export function formatEventJson(input: unknown): string | null {
  if (input === null || input === undefined) return null;

  if (typeof input === 'string') {
    if (!input.trim()) return null;
    try {
      return JSON.stringify(JSON.parse(input) as unknown, null, 2);
    } catch {
      return input;
    }
  }

  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return null;
  }
}

/** The first value of the first tag with this name, if it has one. */
export function tagValue(event: DraftEvent, name: string): string | undefined {
  return event.tags.find(([tagName]) => tagName === name)?.[1] || undefined;
}

/** Every non-empty first value of the tags with this name. */
export function tagValues(event: DraftEvent, name: string): string[] {
  return event.tags
    .filter(([tagName]) => tagName === name)
    .map(([, value]) => value)
    .filter((value): value is string => Boolean(value));
}

/** Every whole tag with this name, values and all. */
export function tagRows(event: DraftEvent, name: string): string[][] {
  return event.tags.filter(([tagName]) => tagName === name);
}

/**
 * The parameters of a NIP-92 `imeta` tag, as a map.
 *
 * Each value after the tag name is `key value`, with the value free to contain
 * spaces of its own — so the split is on the first one only.
 */
export function parseImeta(tag: string[]): Map<string, string> {
  const fields = new Map<string, string>();

  for (const part of tag.slice(1)) {
    const space = part.indexOf(' ');
    if (space === -1) continue;
    const key = part.slice(0, space);
    const value = part.slice(space + 1).trim();
    if (key && value && !fields.has(key)) fields.set(key, value);
  }

  return fields;
}

/**
 * A URL from an event, if it is one this app is willing to fetch.
 *
 * `https:` only. Every URL reachable from here was written by whoever wrote
 * the event, and ends up as the `src` of an image the prompt loads — so
 * `javascript:` and `data:` are refused here rather than trusted to be
 * harmless further down. Mirrors `safeImage` on the profile page, and
 * `safeHttpsUrl` in `dittoTheme` for the ones that reach CSS.
 */
export function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Truncate a string to a maximum character length. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '\u2026';
}
