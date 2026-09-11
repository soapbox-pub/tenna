/**
 * Keep untrusted strings away from the DOM sinks that execute them.
 *
 * Tenna's own origin holds an nsec, and a Nostr key cannot be rotated: one DOM
 * XSS here is permanent, silent theft of the user's whole identity, across
 * every client they will ever use. The CSP already makes these sinks throw at
 * runtime — `require-trusted-types-for 'script'` — so this rule is not the
 * defence. It is the part that fails in review rather than in production, on a
 * machine where the developer can see it, with a message saying what to do
 * instead.
 *
 * `parseInertHtml` and `injectedScriptURL` in `src/lib/trustedTypes.ts` are the
 * sanctioned ways through, which is why that file is the only one exempt.
 */

/** Property assignments that parse their right-hand side as markup or code. */
const SINK_PROPERTIES = new Set([
  'innerHTML',
  'outerHTML',
  'srcdoc',
]);

/** Methods that do the same. */
const SINK_METHODS = new Set([
  'insertAdjacentHTML',
  'write',
  'writeln',
  'createContextualFragment',
  'parseFromString',
]);

/** The one file allowed to touch them, relative to the repo root. */
const EXEMPT = 'src/lib/trustedTypes.ts';

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid HTML and script injection sinks outside the Trusted Types policy',
      category: 'Security',
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      sink:
        "'{{name}}' parses its argument as markup or code. Tenna keeps an nsec on this " +
        'origin, so a DOM XSS is permanent key theft. Use parseInertHtml() from ' +
        '@/lib/trustedTypes to read untrusted HTML, or render it through JSX, which escapes.',
      dangerous:
        'dangerouslySetInnerHTML bypasses the escaping that makes JSX safe. Tenna keeps ' +
        'an nsec on this origin; render the value as a child instead.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (filename.replace(/\\/g, '/').endsWith(EXEMPT)) return {};

    return {
      // `el.innerHTML = …`, `frame.srcdoc = …`
      AssignmentExpression(node) {
        const target = node.left;
        if (target.type !== 'MemberExpression' || target.computed) return;
        if (target.property.type !== 'Identifier') return;
        if (!SINK_PROPERTIES.has(target.property.name)) return;

        context.report({
          node: target.property,
          messageId: 'sink',
          data: { name: target.property.name },
        });
      },

      // `el.insertAdjacentHTML(…)`, `new DOMParser().parseFromString(…)`
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        if (!SINK_METHODS.has(callee.property.name)) return;

        // `document.write` is a sink; `stream.write` and `fs.write` are not,
        // and neither is anything else that happens to be spelled that way.
        if (
          (callee.property.name === 'write' || callee.property.name === 'writeln') &&
          !(callee.object.type === 'Identifier' && callee.object.name === 'document')
        ) {
          return;
        }

        context.report({
          node: callee.property,
          messageId: 'sink',
          data: { name: callee.property.name },
        });
      },

      // <div dangerouslySetInnerHTML={…} />
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier') return;
        if (node.name.name !== 'dangerouslySetInnerHTML') return;
        context.report({ node, messageId: 'dangerous' });
      },
    };
  },
};
