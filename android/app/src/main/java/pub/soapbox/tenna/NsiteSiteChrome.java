package pub.soapbox.tenna;

import android.graphics.Color;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
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
 *
 * <p>{@code theme-color} is the other half, and the only signal a document has
 * ever had for the colour of the chrome beside it. A page may declare it as
 * many times as it likes, each keyed by a {@code media} query, and the first
 * declaration whose query matches is the one that counts. Evaluating an
 * arbitrary media query needs a CSS engine, which is not available here, so
 * {@code prefers-color-scheme} — the only one anybody keys a theme colour on —
 * is evaluated and a declaration keyed on anything else is skipped, exactly as
 * a browser skips one whose query doesn't match. The iframe path has a real
 * {@code matchMedia} and evaluates the lot; for every site seen in the wild the
 * two agree.
 */
final class NsiteSiteChrome {

    /** The site declares {@code viewport-fit=cover} and pads itself. */
    final boolean edgeToEdge;

    /** Every usable {@code theme-color}, in the order the document declared them. */
    @NonNull private final List<Declaration> themeColors;

    private NsiteSiteChrome(boolean edgeToEdge, @NonNull List<Declaration> themeColors) {
        this.edgeToEdge = edgeToEdge;
        this.themeColors = themeColors;
    }

    /** One {@code theme-color}, with the colour scheme it was keyed on. */
    private static final class Declaration {
        final int color;
        /** {@code null} when unconditional, so that it answers for either scheme. */
        @Nullable final Boolean prefersDark;

        Declaration(int color, @Nullable Boolean prefersDark) {
            this.color = color;
            this.prefersDark = prefersDark;
        }
    }

    /**
     * The colour the site says the chrome around it should be, or nothing.
     *
     * First match wins, which is what the HTML standard asks for: a document
     * that names a dark colour before an unconditional one is naming the dark
     * one for a dark device. Nothing at all is a real answer — a site whose
     * only declaration is keyed on the scheme the device isn't in has said
     * nothing about the scheme it is in, and guessing from the other one would
     * be inventing a colour the site never asked for.
     */
    @Nullable
    Integer themeColor(boolean prefersDark) {
        for (Declaration declaration : themeColors) {
            if (declaration.prefersDark == null || declaration.prefersDark == prefersDark) {
                return declaration.color;
            }
        }
        return null;
    }

    /** Only the head can carry a viewport meta, and it is the top of the file. */
    private static final int SNIFF_LIMIT = 64 * 1024;

    private static final Pattern META_TAG =
        Pattern.compile("<meta\\b[^>]*>", Pattern.CASE_INSENSITIVE);

    private static final Pattern VIEWPORT_FIT_COVER =
        Pattern.compile("viewport-fit\\s*=\\s*cover", Pattern.CASE_INSENSITIVE);

    /** The one media query worth evaluating without a CSS engine behind it. */
    private static final Pattern PREFERS_COLOR_SCHEME =
        Pattern.compile("^\\(\\s*prefers-color-scheme\\s*:\\s*(dark|light)\\s*\\)$",
                        Pattern.CASE_INSENSITIVE);

    /** `#rgb` through `#rrggbbaa`. */
    private static final Pattern HEX_COLOR =
        Pattern.compile("^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$", Pattern.CASE_INSENSITIVE);

    /** `rgb()` and `rgba()`, in both the comma and the space syntax. */
    private static final Pattern RGB_COLOR =
        Pattern.compile("^rgba?\\(([^()]*)\\)$", Pattern.CASE_INSENSITIVE);

    /** A bare keyword, before {@link Color#parseColor} is asked whether it knows it. */
    private static final Pattern KEYWORD_COLOR =
        Pattern.compile("^[a-z]{3,20}$", Pattern.CASE_INSENSITIVE);

    @NonNull
    static NsiteSiteChrome read(@NonNull String html) {
        String head = html.length() > SNIFF_LIMIT ? html.substring(0, SNIFF_LIMIT) : html;

        boolean edgeToEdge = false;
        List<Declaration> themeColors = new ArrayList<>();

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
            } else if (name.equalsIgnoreCase("theme-color")) {
                Integer color = parseColor(attribute(tag, "content"));
                if (color == null) continue;

                String media = attribute(tag, "media");
                if (media == null) {
                    themeColors.add(new Declaration(color, null));
                    continue;
                }

                Matcher scheme = PREFERS_COLOR_SCHEME.matcher(media.trim());
                // Anything else is a query with no answer here, and a
                // declaration that can't be evaluated can't be honoured.
                if (scheme.matches()) {
                    themeColors.add(new Declaration(
                        color, scheme.group(1).equalsIgnoreCase("dark")
                    ));
                }
            }
        }

        return new NsiteSiteChrome(edgeToEdge, themeColors);
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
     * Parse a {@code theme-color}, or nothing.
     *
     * The value comes from a Nostr event and ends up as a view's background and
     * as the argument for whether the clock over it is drawn black or white, so
     * it is matched against known syntaxes rather than handed to a lenient
     * parser. Hex, {@code rgb()}, {@code rgba()} and the keywords Android knows
     * cover everything the iframe path accepts bar {@code hsl()}, which CSS
     * understands and Android does not — a site using one gets the plain black
     * letterbox and Tenna's own bars. That is a fallback, not a failure.
     */
    @Nullable
    static Integer parseColor(@Nullable String value) {
        if (value == null) return null;
        String color = value.trim();

        if (HEX_COLOR.matcher(color).matches()) return parseHex(color);

        Matcher rgb = RGB_COLOR.matcher(color);
        if (rgb.matches()) return parseRgb(rgb.group(1));

        if (KEYWORD_COLOR.matcher(color).matches()) {
            try {
                // Parses the handful of keywords it knows and throws on the
                // rest, which is the allowlist we would otherwise write out.
                return Color.parseColor(color.toLowerCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                return null;
            }
        }

        return null;
    }

    @Nullable
    private static Integer parseHex(@NonNull String color) {
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

    /**
     * Parse the inside of an {@code rgb()} or {@code rgba()} call.
     *
     * Both separators are accepted, since CSS Color 4 made
     * {@code rgb(250 246 240 / 50%)} as ordinary as the comma form, and either
     * may turn up in a document written this decade. Components may be numbers
     * or percentages; alpha may be a number or a percentage too.
     */
    @Nullable
    private static Integer parseRgb(@NonNull String body) {
        String[] parts = body.trim().split("\\s*[,/]\\s*|\\s+");
        if (parts.length < 3 || parts.length > 4) return null;

        int[] rgb = new int[3];
        for (int i = 0; i < 3; i++) {
            Float channel = parseNumber(parts[i], 255f);
            if (channel == null) return null;
            rgb[i] = clamp(Math.round(channel));
        }

        int alpha = 255;
        if (parts.length == 4) {
            Float parsed = parseNumber(parts[3], 1f);
            if (parsed == null) return null;
            alpha = clamp(Math.round(parsed * 255f));
        }

        return Color.argb(alpha, rgb[0], rgb[1], rgb[2]);
    }

    /** A CSS number, or a percentage of {@code full}. */
    @Nullable
    private static Float parseNumber(@NonNull String value, float full) {
        boolean percent = value.endsWith("%");
        String number = percent ? value.substring(0, value.length() - 1) : value;
        try {
            float parsed = Float.parseFloat(number.trim());
            return percent ? parsed / 100f * full : parsed;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(255, value));
    }
}
