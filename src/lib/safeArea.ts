/**
 * Safe-area insets for sandboxed nsites.
 *
 * A cross-origin iframe never sees the device's safe area: `env(safe-area-inset-*)`
 * resolves to `0px` inside it no matter what the top-level document declares.
 * (Verified on Chrome 152 / Android WebView.) So a site rendered edge to edge
 * inside the viewer ends up with its header under the status bar and its footer
 * under the gesture bar.
 *
 * Two kinds of site need two different fixes, and the web platform already has
 * a signal telling them apart: `viewport-fit=cover` on the viewport meta. That
 * is the only standard way a document opts into drawing under the system bars
 * — there is no equivalent web-app-manifest field — so its presence is exactly
 * the question "does this site handle insets itself?".
 *
 *   - **Declares `viewport-fit=cover`** — the site wants to be full bleed and
 *     pads itself with `env(safe-area-inset-*)`. Give it the whole screen and
 *     make those `env()` calls resolve to real numbers (`rewriteSafeAreaEnv`).
 *   - **Doesn't declare it** — the site assumes its viewport *is* the safe
 *     area. Shrink the iframe by the insets so that assumption holds.
 */
import { parseInertHtml } from '@/lib/trustedTypes';

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const SAFE_AREA_SIDES = ['top', 'right', 'bottom', 'left'] as const;

export const ZERO_SAFE_AREA_INSETS: SafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

/**
 * The custom property the insets are published as inside the sandbox.
 *
 * Not a name Tenna invented: Capacitor's `SystemBars` plugin publishes exactly
 * these four on Android when `insetsHandling: 'css'` is set, so apps built for
 * a Capacitor shell already read them — typically as
 * `var(--safe-area-inset-top, env(safe-area-inset-top, 0px))`, preferring the
 * host's value and falling back to the standard one.
 *
 * Reusing it rather than a private `--tenna-*` namespace means one mechanism
 * covers both conventions at once: sites written against bare `env()` are
 * served rewritten stylesheets pointing at this property, and sites written
 * against the property are satisfied directly — including the ones that set it
 * from JS at runtime, which no amount of rewriting served text could reach.
 */
const VAR_PREFIX = '--safe-area-inset-';

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

function parsePx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Measure the device's safe-area insets from the top-level document.
 *
 * `env()` is only readable through layout, so this pads a throwaway element
 * with it and reads back the computed padding. On WebViews older than
 * Chromium 140 `env()` reports 0; there the Capacitor SystemBars plugin
 * (`insetsHandling: 'css'`) publishes `--safe-area-inset-*` on the root
 * instead, so take whichever source reports more.
 */
export function readSafeAreaInsets(): SafeAreaInsets {
  if (typeof document === 'undefined') return ZERO_SAFE_AREA_INSETS;

  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;';
  for (const side of SAFE_AREA_SIDES) {
    probe.style.setProperty(`padding-${side}`, `env(safe-area-inset-${side})`);
  }
  document.documentElement.appendChild(probe);

  const probed = getComputedStyle(probe);
  const root = getComputedStyle(document.documentElement);

  const insets = { ...ZERO_SAFE_AREA_INSETS };
  for (const side of SAFE_AREA_SIDES) {
    insets[side] = Math.max(
      parsePx(probed.getPropertyValue(`padding-${side}`)),
      parsePx(root.getPropertyValue(`--safe-area-inset-${side}`)),
    );
  }

  probe.remove();
  return insets;
}

export function safeAreaInsetsEqual(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return SAFE_AREA_SIDES.every((side) => a[side] === b[side]);
}

// ---------------------------------------------------------------------------
// Reading the site's own declarations
// ---------------------------------------------------------------------------

/**
 * Parse an nsite's HTML for the viewer chrome it implies.
 *
 * Uses `DOMParser`, which builds an inert document — scripts don't run and
 * resources aren't fetched.
 */
export function readSiteChrome(html: string): {
  /** The site declares `viewport-fit=cover` and pads itself. */
  edgeToEdge: boolean;
  /** Validated `theme-color`, for the letterbox behind a non-edge-to-edge site. */
  themeColor: string | null;
} {
  const doc = parseInertHtml(html);

  const viewport = doc.querySelector('meta[name="viewport" i]')?.getAttribute('content') ?? '';
  const edgeToEdge = /viewport-fit\s*=\s*cover/i.test(viewport);

  // `theme-color` may be declared more than once, each keyed by a `media`
  // query, and the first declaration whose query matches is the one that
  // counts. An unconditional one matches everything, but only from where it
  // stands: a site that names a dark colour ahead of it is naming the dark one
  // for a dark device, and taking the unconditional one anyway would hand back
  // a colour the site declared for somebody else's screen.
  //
  // The queries are evaluated against this document, which shares a device and
  // a colour scheme with the frame — `matchMedia` inside a nested browsing
  // context answers no differently.
  const chosen = [...doc.querySelectorAll('meta[name="theme-color" i]')].find((el) => {
    const media = el.getAttribute('media');
    return !media || matchesMedia(media);
  });

  return {
    edgeToEdge,
    themeColor: sanitizeCssColor(chosen?.getAttribute('content') ?? null),
  };
}

/** Whether a media query from a site's markup holds here and now. */
function matchesMedia(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  // A query that doesn't parse is `not all`, which matches nothing — the same
  // answer as a query that parses and doesn't hold, and the right one either
  // way. No browser throws here, but this one runs on strings from a Nostr
  // event, so it is not the place to find out.
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * Allow a CSS color through only if it matches a known-safe syntax.
 *
 * The value comes from a Nostr event, so it reaches a `style` attribute as
 * attacker-controlled text. Anything containing `;`, `)`, `url(`, or a
 * closing brace could break out of the declaration, so match strictly rather
 * than blocklisting: hex, a numeric functional notation, or a bare keyword.
 */
export function sanitizeCssColor(value: string | null): string | null {
  if (!value) return null;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9a-z.,%/\s]{1,64}\)$/i.test(color)) return color;
  if (/^[a-z]{3,20}$/i.test(color)) return color;
  return null;
}

// ---------------------------------------------------------------------------
// Rewriting `env(safe-area-inset-*)`
// ---------------------------------------------------------------------------

/**
 * Matches an `env(safe-area-inset-<side>[, <fallback>])` call, tolerating one
 * level of parens in the fallback (`env(safe-area-inset-top, calc(1rem + 2px))`).
 *
 * Escaped occurrences inside Tailwind's generated class selectors — e.g.
 * `.top-\[calc\(1rem\+env\(safe-area-inset-top\)\)\]` — write the paren as
 * `\(` and so don't match, which is what we want: rewriting a selector would
 * stop it matching the element.
 */
const SAFE_AREA_ENV =
  /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g;

/** Cheap test for whether a rewrite could do anything. */
export function mentionsSafeArea(text: string): boolean {
  return text.includes('safe-area-inset');
}

/**
 * Matches a declaration of the inset custom property itself, capturing its
 * value. Used only to keep {@link rewriteSafeAreaEnvInCss} from rewriting a
 * site's own definition into a self-reference.
 */
const SAFE_AREA_CUSTOM_PROP =
  /(--safe-area-inset-(?:top|right|bottom|left)\s*:)([^;}]*)/g;

/** Same pattern as {@link SAFE_AREA_ENV}, kept separate to avoid `lastIndex` crosstalk. */
const SAFE_AREA_ENV_INNER =
  /env\(\s*safe-area-inset-(top|right|bottom|left)\s*(?:,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g;

/**
 * Substitute real inset values for `env(safe-area-inset-*)` in a stylesheet.
 *
 * `env()` can't be redefined from inside a document — there is no
 * `CSS.registerEnv`, no `document.env`, nothing — so the only way to give a
 * sandboxed site true insets is to rewrite the calls as they're served. Each
 * becomes `var(--safe-area-inset-<side>, <measured>px)`: the custom property
 * lets the values be updated live on rotation, and the literal fallback keeps
 * things correct even if nothing ever publishes the property.
 *
 * Any fallback the site supplied is dropped — it only existed for browsers
 * that don't define the inset at all, and we're now defining it.
 *
 * This also fixes libraries that indirect through their own variables, since
 * their definitions (`--twsa-safe-area-inset-top: env(safe-area-inset-top)`)
 * are themselves rewritten.
 *
 * **Only ever apply this to CSS.** The same call appears verbatim inside
 * Tailwind class names (`pt-[calc(1rem+env(safe-area-inset-top))]`), which are
 * strings in the site's HTML and JS bundles. Rewriting one there renames the
 * class so it stops matching its generated rule — which is why the HTML path
 * goes through {@link rewriteSafeAreaEnvInHtml} and JS is left alone entirely.
 * In a stylesheet the distinction is safe: the class name reaches the selector
 * escaped, as `env\(safe-area-inset-top\)`, and so doesn't match this pattern,
 * while the declaration it guards does.
 */
export function rewriteSafeAreaEnvInCss(css: string, insets: SafeAreaInsets): string {
  // A site that defines the property from the standard value —
  // `--safe-area-inset-top: env(safe-area-inset-top)` — would otherwise be
  // rewritten into `--safe-area-inset-top: var(--safe-area-inset-top, …)`.
  // That's a cycle, which makes the property guaranteed-invalid and takes
  // every rule reading it down with it. Give those declarations the literal.
  const guarded = css.replace(
    SAFE_AREA_CUSTOM_PROP,
    (_match, declaration: string, value: string) =>
      declaration + value.replace(
        SAFE_AREA_ENV_INNER,
        (_inner, side: keyof SafeAreaInsets) => `${insets[side]}px`,
      ),
  );

  return guarded.replace(SAFE_AREA_ENV, (_match, side: keyof SafeAreaInsets) =>
    `var(${VAR_PREFIX}${side}, ${insets[side]}px)`,
  );
}

/**
 * Prepare an HTML document for an edge-to-edge site.
 *
 * Two things happen here, both confined to CSS — `class` above all is left
 * alone, for the reason given on {@link rewriteSafeAreaEnvInCss}.
 *
 * 1. The insets are stamped onto `<html>` as an inline style. Inline beats any
 *    author rule, and it lands before a single byte of the site's own CSS or
 *    JS has run, so there is no race and no unpadded first paint. This is what
 *    reaches styles the site applies at runtime, which nothing served can.
 * 2. `<style>` elements and `style` attributes already in the document get the
 *    same `env()` substitution the stylesheets do.
 */
export function rewriteSafeAreaEnvInHtml(html: string, insets: SafeAreaInsets): string {
  const doc = parseInertHtml(html);

  for (const side of SAFE_AREA_SIDES) {
    doc.documentElement.style.setProperty(`${VAR_PREFIX}${side}`, `${insets[side]}px`);
  }

  for (const style of doc.querySelectorAll('style')) {
    const css = style.textContent ?? '';
    if (!mentionsSafeArea(css)) continue;
    style.textContent = rewriteSafeAreaEnvInCss(css, insets);
  }

  for (const el of doc.querySelectorAll('[style]')) {
    if (el === doc.documentElement) continue;
    const css = el.getAttribute('style') ?? '';
    if (!mentionsSafeArea(css)) continue;
    el.setAttribute('style', rewriteSafeAreaEnvInCss(css, insets));
  }

  // DOMParser drops the doctype; put it back when the original had one.
  const serialised = doc.documentElement.outerHTML;
  return /^<!doctype\s/i.test(html.trimStart())
    ? '<!DOCTYPE html>\n' + serialised
    : serialised;
}

// ---------------------------------------------------------------------------
// Injected script
// ---------------------------------------------------------------------------

/** Method name for the parent → sandbox inset update notification. */
export const SAFE_AREA_RPC_METHOD = 'tenna.safeArea';

/**
 * Script injected at the top of a sandboxed site's `<head>`.
 *
 * Its only job is rotation: it re-publishes the insets when the viewer sends a
 * `tenna.safeArea` notification. The *initial* values are stamped onto
 * `<html>` by {@link rewriteSafeAreaEnvInHtml} while the document is served.
 *
 * That division matters. Scripts are chosen before the site's HTML has been
 * read, so this one can't know whether the site is edge to edge — and
 * `--safe-area-inset-*` is a property sites read directly, so publishing real
 * values to a site whose frame we already shrank would pad it twice. Serving
 * the initial values with the HTML, where the answer is known, keeps the
 * decision in the one place that has it.
 */
export function getSafeAreaInjectedScript(): string {
  return `(function() {
  'use strict';

  var PREFIX = ${JSON.stringify(VAR_PREFIX)};
  var SIDES = ${JSON.stringify(SAFE_AREA_SIDES)};

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.method !== ${JSON.stringify(SAFE_AREA_RPC_METHOD)}) return;
    var insets = msg.params;
    if (!insets) return;
    var style = document.documentElement.style;
    for (var i = 0; i < SIDES.length; i++) {
      var side = SIDES[i];
      var value = insets[side];
      style.setProperty(PREFIX + side, (typeof value === 'number' ? value : 0) + 'px');
    }
  });
})();`;
}
