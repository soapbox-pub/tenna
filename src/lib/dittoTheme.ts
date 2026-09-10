import type { NostrEvent } from '@nostrify/nostrify';
import { z } from 'zod';

/**
 * The theme a person is already wearing, worn by Tenna.
 *
 * Ditto lets a user publish a theme for their own profile — a replaceable
 * kind 16767 carrying three colours, up to two font files, and a picture for
 * the background. Visitors to that profile see it. Tenna is not a profile, but
 * it is the thing standing between its user and every site they open, and it
 * has no reason to insist on its own colours over the ones that person has
 * already chosen and published. So when the logged-in user has a theme, the
 * browser wears it.
 *
 * The event is specified in Ditto's `NIP.md`, under "Kind 16767: Active
 * Profile Theme". What is read here:
 *
 * | Tag     | What it carries                                              |
 * | ------- | ------------------------------------------------------------ |
 * | `c`     | `#rrggbb` with a marker: `background`, `text`, or `primary`.  |
 * | `f`     | A font file's URL and a role: `body` or `title`.              |
 * | `bg`    | An `imeta`-style background: `url`, `mode`, `m`.              |
 * | `title` | What the theme is called. Not drawn anywhere; kept for logs.  |
 *
 * All three colours are required, and a theme missing any of them is no theme
 * — half a palette applied over the other half of Tenna's is worse than
 * either.
 *
 * **Everything here came off a relay.** A theme is the one feature in this app
 * that takes strings from a stranger's event and puts them into CSS, so
 * nothing below trusts a tag: colours must match `#rrggbb` exactly, URLs must
 * be plain `https:` with no character that could close a string or a `url()`,
 * and the font *family names* are Tenna's own constants rather than anything
 * the event declares — the declared family is only useful for a font already
 * installed, which this kind cannot describe, and dropping it means no
 * event-controlled identifier reaches a stylesheet at all.
 */

export const DITTO_THEME_KIND = 16767;

/** Six lowercase hex digits behind a `#`, which is all the kind allows. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/**
 * A URL from an event, allowed through only as plain `https:` and only when it
 * holds nothing that could end a CSS string or a `url()` early.
 *
 * `https:` alone rules out `javascript:` and `data:`; the character check
 * rules out breaking out of the declaration these end up inside. Both matter
 * — the URL reaches CSSOM as a background image and reaches `fetch` as a font.
 */
export function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value || /["'()\\\s;]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    // Parsing can re-encode; the result is what gets used, so it is the thing
    // that has to be clean.
    return /["'()\\\s;]/.test(url.href) ? undefined : url.href;
  } catch {
    return undefined;
  }
}

const Colour = z.string().regex(HEX_COLOUR);
const Url = z.string().refine((value) => safeHttpsUrl(value) === value);

/**
 * The schema both ways in: what {@link parseDittoTheme} produces out of an
 * event, and what `AppProvider` demands of the copy it reads back out of local
 * storage. One definition, so the second reading is a real check rather than a
 * cast.
 */
export const DittoThemeSchema = z.object({
  /** The theme's own name, if it gave one. */
  title: z.string().max(200).optional(),
  background: Colour,
  text: Colour,
  primary: Colour,
  /** Font file for everything the app writes. */
  bodyFont: Url.optional(),
  /** Font file for headings. */
  titleFont: Url.optional(),
  /** The picture behind the wall. */
  media: z
    .object({
      url: Url,
      mode: z.enum(['cover', 'tile']),
      /** Whether to draw it with `<video>` rather than as an image. */
      video: z.boolean(),
    })
    .optional(),
});

export type DittoTheme = z.infer<typeof DittoThemeSchema>;

/** The first `c` tag carrying a valid colour for a role. */
function colour(event: NostrEvent, marker: string): string | undefined {
  for (const [name, value, role] of event.tags) {
    if (name !== 'c' || role !== marker) continue;
    const hex = value?.toLowerCase();
    if (hex && HEX_COLOUR.test(hex)) return hex;
  }
  return undefined;
}

/**
 * The font file for a role.
 *
 * An `f` tag with no role at all is a legacy body font, which the kind says to
 * read as one.
 */
function font(event: NostrEvent, role: 'body' | 'title'): string | undefined {
  for (const [name, , url, declared] of event.tags) {
    if (name !== 'f') continue;
    if ((declared ?? 'body') !== role) continue;
    const safe = safeHttpsUrl(url);
    if (safe) return safe;
  }
  return undefined;
}

/**
 * The `bg` tag, which is variadic in the style of NIP-92 `imeta`: every entry
 * after the tag name is one space-delimited key and value. Unknown keys are
 * ignored, and a repeated key keeps its first value.
 */
function media(event: NostrEvent): DittoTheme['media'] {
  const tag = event.tags.find(([name]) => name === 'bg');
  if (!tag) return undefined;

  const fields = new Map<string, string>();
  for (const entry of tag.slice(1)) {
    const space = entry.indexOf(' ');
    if (space < 1) continue;
    const key = entry.slice(0, space);
    if (!fields.has(key)) fields.set(key, entry.slice(space + 1).trim());
  }

  const url = safeHttpsUrl(fields.get('url'));
  if (!url) return undefined;

  // `m` is required by the kind, but only one bit of it is load-bearing here
  // — whether this goes in a `<video>` or not — so a missing or unreadable
  // type is taken as a picture, which is what all but a handful of these are.
  return {
    url,
    mode: fields.get('mode') === 'tile' ? 'tile' : 'cover',
    video: fields.get('m')?.startsWith('video/') ?? false,
  };
}

/** A kind 16767 event as a theme, or null if it isn't one. */
export function parseDittoTheme(event: NostrEvent): DittoTheme | null {
  if (event.kind !== DITTO_THEME_KIND) return null;

  const parsed = DittoThemeSchema.safeParse({
    title: event.tags.find(([name]) => name === 'title')?.[1] || undefined,
    background: colour(event, 'background'),
    text: colour(event, 'text'),
    primary: colour(event, 'primary'),
    bodyFont: font(event, 'body'),
    titleFont: font(event, 'title'),
    media: media(event),
  });

  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channel = (index: number) => {
    const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Whether the theme reads as a dark one.
 *
 * Asked of the theme rather than of the background alone, because the theme
 * already answered it: a palette whose text is lighter than its background is
 * light-on-dark, whatever the two colours happen to be. That is the same
 * question the status bar asks when it picks black or white icons.
 */
export function themeIsDark(theme: DittoTheme): boolean {
  return luminance(theme.text) > luminance(theme.background);
}

/** Whichever of the theme's other two colours reads on its primary. */
function onPrimary(theme: DittoTheme): string {
  return contrast(theme.primary, theme.background) >= contrast(theme.primary, theme.text)
    ? theme.background
    : theme.text;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * The properties a theme owns. Everything else in `index.css` is derived from
 * these, so this list is also the whole of what has to be cleared to put Tenna
 * back in its own colours.
 */
const THEME_PROPERTIES = [
  '--theme-background',
  '--theme-text',
  '--theme-primary',
  '--theme-on-primary',
  '--osd',
] as const;

/**
 * The family names the theme's fonts are registered under.
 *
 * Constants, never anything out of the event — see the note at the top of this
 * file. A theme replacing another theme's font reuses the same name, so the
 * stylesheet never has to change to follow it.
 */
const FAMILY = { body: 'Tenna theme body', title: 'Tenna theme title' } as const;

/**
 * Write a theme onto the document, or clear it.
 *
 * Every value goes through `setProperty`, which is CSSOM rather than parsed
 * text: a value the property will not accept is dropped on the floor instead
 * of ending the declaration and starting a new one. The colours were validated
 * against `#rrggbb` on the way in as well, so this is the second of two locks
 * on the one door in this app that opens onto a stylesheet.
 */
export function applyDittoTheme(theme: DittoTheme | null): void {
  const root = document.documentElement.style;

  for (const property of THEME_PROPERTIES) root.removeProperty(property);
  if (!theme) return;

  root.setProperty('--theme-background', theme.background);
  root.setProperty('--theme-text', theme.text);
  root.setProperty('--theme-primary', theme.primary);
  root.setProperty('--theme-on-primary', onPrimary(theme));
  root.setProperty('--osd', theme.primary);

  // The font families are only named here once their files have actually been
  // registered — see `loadThemeFonts`. Naming a family nothing has loaded
  // would leave the app in the fallback anyway, and would leave it there
  // permanently if the fetch failed.
}

/**
 * Fetch a theme's fonts and put the document into them.
 *
 * The bytes are fetched and handed to `FontFace` as an `ArrayBuffer` rather
 * than left to `@font-face` to load. Three things come of that. The font
 * never appears in a stylesheet, so no URL from an event is ever parsed as
 * CSS. The bytes go through `connect-src`, which already allows `https:`, so
 * `font-src` in the app's CSP stays closed at `'self'`. And a file that is
 * absurdly large, or that isn't a font at all, is caught here rather than
 * halfway down the font stack.
 *
 * A font that fails to arrive is simply not applied, which the kind asks for:
 * fall back gracefully. Resolves when there is nothing left to wait for.
 */
export async function loadThemeFonts(theme: DittoTheme | null): Promise<void> {
  if (!supportsFontLoading()) return;

  await Promise.all([
    install('body', theme?.bodyFont),
    install('title', theme?.titleFont),
  ]);
}

/** Whether this environment can register a font at runtime. jsdom cannot. */
function supportsFontLoading(): boolean {
  const fonts: FontFaceSet | undefined = document.fonts;
  return typeof FontFace === 'function' && typeof fonts?.add === 'function';
}

/** Roughly a large variable TTF. Anything past it is not a webfont. */
const MAX_FONT_BYTES = 5 * 1024 * 1024;

/** The property each role's family name is written to. */
const FONT_PROPERTY = {
  body: '--theme-font-body',
  title: '--theme-font-title',
} as const;

/** What is currently registered for each role, by the URL it came from. */
const installed = new Map<string, { url: string; face: FontFace }>();

/**
 * Which request owns each role.
 *
 * A fetch that finishes after a newer one started has to drop what it got —
 * otherwise switching accounts twice in a second leaves whichever font
 * happened to be slowest. Counting the requests is the only ordering
 * available, since neither the map nor the CSS property records who is
 * mid-flight.
 */
const inFlight = new Map<string, number>();

async function install(role: 'body' | 'title', url: string | undefined): Promise<void> {
  const family = FAMILY[role];
  const property = FONT_PROPERTY[role];

  const current = installed.get(role);
  if (current?.url === url) return;

  const mine = (inFlight.get(role) ?? 0) + 1;
  inFlight.set(role, mine);

  if (current) {
    document.fonts.delete(current.face);
    installed.delete(role);
    document.documentElement.style.removeProperty(property);
  }

  if (!url) return;

  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return;

    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_FONT_BYTES) return;

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FONT_BYTES) return;

    const face = new FontFace(family, bytes);
    await face.load();

    if (inFlight.get(role) !== mine) return;

    document.fonts.add(face);
    installed.set(role, { url, face });

    // Named ahead of the stack rather than instead of it: a glyph the theme's
    // font hasn't got still gets drawn.
    document.documentElement.style.setProperty(
      property,
      role === 'body'
        ? `"${family}", var(--theme-font-stack)`
        : `"${family}", var(--theme-font-body)`,
    );
  } catch {
    // No font. The stack underneath it was always going to be readable.
  }
}
