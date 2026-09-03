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

/** CSS custom properties the injected script defines inside the sandbox. */
const VAR_PREFIX = '--tenna-safe-area-inset-';

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
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const viewport = doc.querySelector('meta[name="viewport" i]')?.getAttribute('content') ?? '';
  const edgeToEdge = /viewport-fit\s*=\s*cover/i.test(viewport);

  // `theme-color` may be declared more than once, keyed by a `media` query.
  // Prefer an unconditional one; otherwise take the first declaration.
  const candidates = [...doc.querySelectorAll('meta[name="theme-color" i]')];
  const chosen = candidates.find((el) => !el.getAttribute('media')) ?? candidates[0];

  return {
    edgeToEdge,
    themeColor: sanitizeCssColor(chosen?.getAttribute('content') ?? null),
  };
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
 * Substitute real inset values for `env(safe-area-inset-*)` in a stylesheet.
 *
 * `env()` can't be redefined from inside the document, so the only way to give
 * a sandboxed site true insets is to rewrite the calls as they're served. Each
 * becomes `var(--tenna-safe-area-inset-<side>, <measured>px)`: the custom
 * property lets the values be updated live on rotation, and the literal
 * fallback keeps things correct even if the injected script never runs.
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
  return css.replace(SAFE_AREA_ENV, (_match, side: keyof SafeAreaInsets) =>
    `var(${VAR_PREFIX}${side}, ${insets[side]}px)`,
  );
}

/**
 * Rewrite the CSS embedded in an HTML document — `<style>` elements and
 * `style` attributes — leaving everything else, `class` above all, untouched.
 */
export function rewriteSafeAreaEnvInHtml(html: string, insets: SafeAreaInsets): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;

  for (const style of doc.querySelectorAll('style')) {
    const css = style.textContent ?? '';
    if (!mentionsSafeArea(css)) continue;
    style.textContent = rewriteSafeAreaEnvInCss(css, insets);
    changed = true;
  }

  for (const el of doc.querySelectorAll('[style]')) {
    const css = el.getAttribute('style') ?? '';
    if (!mentionsSafeArea(css)) continue;
    el.setAttribute('style', rewriteSafeAreaEnvInCss(css, insets));
    changed = true;
  }

  if (!changed) return html;

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
 * Publishes the measured insets as custom properties on `<html>`, which is
 * where {@link rewriteSafeAreaEnv}'s output reads them from, and keeps them
 * current by listening for `tenna.safeArea` notifications from the viewer
 * (sent when the device rotates).
 */
export function getSafeAreaInjectedScript(insets: SafeAreaInsets): string {
  return `(function() {
  'use strict';

  var PREFIX = ${JSON.stringify(VAR_PREFIX)};
  var SIDES = ${JSON.stringify(SAFE_AREA_SIDES)};

  function apply(insets) {
    if (!insets) return;
    var style = document.documentElement.style;
    for (var i = 0; i < SIDES.length; i++) {
      var side = SIDES[i];
      var value = insets[side];
      style.setProperty(PREFIX + side, (typeof value === 'number' ? value : 0) + 'px');
    }
  }

  apply(${JSON.stringify(insets)});

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.method !== ${JSON.stringify(SAFE_AREA_RPC_METHOD)}) return;
    apply(msg.params);
  });
})();`;
}
