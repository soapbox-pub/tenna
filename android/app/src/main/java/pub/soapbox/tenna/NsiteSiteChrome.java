package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a site's own HTML says about the chrome around it.
 *
 * The Java counterpart of {@code readSiteChrome} in {@code src/lib/safeArea.ts},
 * and it has to stay its counterpart: a site must be treated the same whether
 * it is served into an iframe or into a WebView of its own.
 *
 * <p>{@code viewport-fit=cover} is the only standardised way for a document to
 * say it will draw under the system bars and pad itself with
 * {@code env(safe-area-inset-*)}. There is no webmanifest equivalent. A site
 * that doesn't say it is asking to be laid out within the safe area, which is
 * what {@code viewport-fit=auto} means — and since Chrome only honours that for
 * display cutouts, and only in cutout mode, the WebView is inset by hand
 * instead.
 */
final class NsiteSiteChrome {

    /** The site declares {@code viewport-fit=cover} and pads itself. */
    final boolean edgeToEdge;

    /** Validated {@code theme-color}, for the letterbox behind a site that doesn't. */
    @Nullable final Integer themeColor;

    private NsiteSiteChrome(boolean edgeToEdge, @Nullable Integer themeColor) {
        this.edgeToEdge = edgeToEdge;
        this.themeColor = themeColor;
    }

    /** Only the head can carry a viewport meta, and it is the top of the file. */
    private static final int SNIFF_LIMIT = 64 * 1024;

    private static final Pattern META_TAG =
        Pattern.compile("<meta\\b[^>]*>", Pattern.CASE_INSENSITIVE);

    private static final Pattern VIEWPORT_FIT_COVER =
        Pattern.compile("viewport-fit\\s*=\\s*cover", Pattern.CASE_INSENSITIVE);

    /** `#rgb` through `#rrggbbaa`. Anything else is not worth the parse. */
    private static final Pattern HEX_COLOR =
        Pattern.compile("^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$", Pattern.CASE_INSENSITIVE);

    @NonNull
    static NsiteSiteChrome read(@NonNull String html) {
        String head = html.length() > SNIFF_LIMIT ? html.substring(0, SNIFF_LIMIT) : html;

        boolean edgeToEdge = false;
        Integer themeColor = null;

        Matcher tags = META_TAG.matcher(head);
        while (tags.find()) {
            String tag = tags.group();
            String name = attribute(tag, "name");
            if (name == null) continue;

            if (name.equalsIgnoreCase("viewport")) {
                String content = attribute(tag, "content");
                if (content != null && VIEWPORT_FIT_COVER.matcher(content).find()) {
                    edgeToEdge = true;
                }
            } else if (name.equalsIgnoreCase("theme-color") && themeColor == null) {
                // `theme-color` may be declared more than once, keyed by a
                // `media` query. Without the means to evaluate one, take the
                // first unconditional declaration and ignore the rest.
                if (attribute(tag, "media") == null) {
                    themeColor = parseColor(attribute(tag, "content"));
                }
            }
        }

        return new NsiteSiteChrome(edgeToEdge, themeColor);
    }

    // -----------------------------------------------------------------------

    /** Read an attribute out of a single tag, quoted either way or bare. */
    @Nullable
    private static String attribute(String tag, String attribute) {
        Matcher m = Pattern
            .compile(attribute + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))",
                     Pattern.CASE_INSENSITIVE)
            .matcher(tag);
        if (!m.find()) return null;

        for (int group = 1; group <= 3; group++) {
            if (m.group(group) != null) return m.group(group).trim();
        }
        return null;
    }

    /**
     * Parse a hex {@code theme-color}, or nothing.
     *
     * The value comes from a Nostr event and ends up as a view's background,
     * so it is matched strictly rather than handed to a lenient parser.
     * {@code rgb()} and the named colors are accepted by the iframe path — CSS
     * understands them and Android does not — so a site using one gets the
     * plain black letterbox here. That is a fallback, not a failure.
     */
    @Nullable
    private static Integer parseColor(@Nullable String value) {
        if (value == null) return null;
        String color = value.trim();
        if (!HEX_COLOR.matcher(color).matches()) return null;

        String hex = color.substring(1);
        // Expand the shorthand forms, then move #rrggbbaa to Android's #aarrggbb.
        if (hex.length() == 3 || hex.length() == 4) {
            StringBuilder expanded = new StringBuilder();
            for (int i = 0; i < hex.length(); i++) {
                expanded.append(hex.charAt(i)).append(hex.charAt(i));
            }
            hex = expanded.toString();
        }
        if (hex.length() == 8) {
            hex = hex.substring(6) + hex.substring(0, 6);
        }

        try {
            return (int) Long.parseLong(hex, 16) | (hex.length() == 6 ? 0xFF000000 : 0);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
