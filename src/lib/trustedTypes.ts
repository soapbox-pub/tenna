/**
 * The one Trusted Types policy this app has, and the only way it writes to a
 * sink the browser guards.
 *
 * `require-trusted-types-for 'script'` in the CSP turns every DOM XSS sink —
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
 * `script.src`, `eval`, `new Function` — from a string assignment into a type
 * error unless the value came from a policy. Tenna holds an nsec, so a single
 * DOM XSS is permanent key theft; this makes the dangerous assignment
 * impossible to write by accident rather than merely absent today, and it
 * fails at the sink rather than at review time.
 *
 * The policy is deliberately tiny. It has one member, it is used in one place,
 * and what it produces is a path this file can see in full — so "did a
 * stranger's string reach a sink" is a question about these few lines rather
 * than about the whole codebase.
 *
 * `default` is not defined on purpose. A default policy would silently launder
 * every assignment in every dependency, which is the opposite of what this is
 * for: an unexpected sink should throw, loudly, in development.
 */

/** Paths the injector is allowed to point a `<script>` at. */
const INJECTED_SCRIPT_PATH = /^\/__injected__\/[a-z-]+\.js$/;

interface Policy {
  createScriptURL(input: string): string;
  createHTML(input: string): string;
}

let policy: Policy | null = null;
let created = false;

/**
 * The policy, or a passthrough where Trusted Types does not exist.
 *
 * Firefox and Safari have no `trustedTypes`, and neither does jsdom, so the
 * fallback is the plain string. That is not a weakening: where the API is
 * absent the CSP directive is inert too, and the app is exactly as safe as it
 * was before — the allowlist below still runs either way.
 */
function getPolicy(): Policy {
  if (!created) {
    created = true;
    const tt = (globalThis as { trustedTypes?: {
      createPolicy(name: string, rules: Policy): Policy;
    } }).trustedTypes;
    policy = tt?.createPolicy('tenna', {
      createScriptURL: (input: string) => input,
      createHTML: (input: string) => input,
    }) ?? null;
  }
  return policy ?? {
    createScriptURL: (input: string) => input,
    createHTML: (input: string) => input,
  };
}

/**
 * A URL for a `<script src>`, for the sandbox's HTML injector and nothing
 * else.
 *
 * The allowlist is the actual guarantee; the policy is what satisfies the
 * browser. Only the virtual paths `SandboxFrame` serves out of
 * `injectedScripts` can be returned, so no value derived from an event, a
 * manifest or a site's own markup can become a script URL even if a future
 * caller passes one in.
 */
export function injectedScriptURL(path: string): string {
  if (!INJECTED_SCRIPT_PATH.test(path)) {
    throw new Error(`Refusing to script-src an unexpected path: ${path}`);
  }
  return getPolicy().createScriptURL(path);
}

/**
 * Parse untrusted HTML into an inert document.
 *
 * The app reads other people's markup in four places — an nsite's `index.html`
 * for its icons and colours, the same document for the insets it declares, and
 * the injector that adds script tags on the way out. All of them go through
 * here.
 *
 * `DOMParser.parseFromString` really is a Trusted Types sink in Chrome, which
 * is worth saying because it is the one on this list that looks like it should
 * not be: the document it returns has no browsing context, so no script in it
 * runs and no resource it names is fetched. Reading a stranger's HTML this way
 * is safe, and it is the reason the app can look at a site's markup at all.
 *
 * What is *not* safe is taking a node out of that document and putting it in
 * this one — adoption revives scripts and loads resources. Nothing here does;
 * every caller reads attributes and text, or re-serialises to a string that is
 * then served to the site's own origin rather than to Tenna's.
 */
export function parseInertHtml(html: string): Document {
  return new DOMParser().parseFromString(getPolicy().createHTML(html), 'text/html');
}
