import { injectedScriptURL, parseInertHtml } from '@/lib/trustedTypes';

/**
 * Inject `<script>` tags into an HTML document string.
 *
 * Uses DOMParser to safely manipulate the DOM, then serialises back to a
 * string. Each script path is prepended inside `<head>` so the injected
 * scripts run before the app's own scripts.
 *
 * The document is inert — DOMParser runs no script and fetches nothing — but
 * `script.src` is a Trusted Types sink all the same, and this app enforces
 * `require-trusted-types-for 'script'`. So the path goes through the policy,
 * which also holds the allowlist saying these are the only paths a script tag
 * here may ever point at. See `@/lib/trustedTypes`.
 */
export function injectScriptTags(html: string, scriptPaths: string[]): string {
  if (scriptPaths.length === 0) return html;

  const doc = parseInertHtml(html);

  // Insert in reverse order so the first path ends up first in <head>.
  for (let i = scriptPaths.length - 1; i >= 0; i--) {
    const script = doc.createElement('script');
    script.src = injectedScriptURL(scriptPaths[i]) as string;
    doc.head.prepend(script);
  }

  // DOMParser strips the doctype; re-add it when the original had one.
  const hasDoctype = /^<!doctype\s/i.test(html.trimStart());
  const serialised = doc.documentElement.outerHTML;
  return hasDoctype ? '<!DOCTYPE html>\n' + serialised : serialised;
}
