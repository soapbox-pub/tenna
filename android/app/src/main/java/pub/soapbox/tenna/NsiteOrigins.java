package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Locale;

/**
 * Where an nsite lives, as far as the WebView is concerned.
 *
 * A {@code .localhost} name is treated as potentially trustworthy, so the
 * document is a secure context and can use crypto.subtle, service workers and
 * the rest. Nothing resolves it: every request to a site's own origin is
 * answered by {@link NsiteRequests}, from the page's own WebView client or
 * from the process-wide {@link NsiteServiceWorkers} one.
 *
 * Unlike the shared, public {@code iframe.diy} domain the iframe path uses,
 * this one is reachable only from inside this app's WebViews, so the site
 * label can be the plain NIP-5A subdomain rather than an HMAC of it.
 */
final class NsiteOrigins {

    /** Parent domain for site origins. */
    static final String SITE_DOMAIN = "nsite.localhost";

    private NsiteOrigins() {}

    /** The host a site is served on. */
    @NonNull
    static String hostFor(@NonNull String siteId) {
        return siteId.toLowerCase(Locale.ROOT) + "." + SITE_DOMAIN;
    }

    /** The origin a site is served on. */
    @NonNull
    static String originFor(@NonNull String siteId) {
        return "https://" + hostFor(siteId);
    }

    /**
     * The site id a host names, or null if it is not one of ours.
     *
     * Site ids are NIP-5A subdomains, which are lowercase by construction —
     * bech32 and base36 both are, and a named site's {@code d} tag is part of
     * a hostname — so the label is the id.
     */
    @Nullable
    static String siteIdFor(@Nullable String host) {
        if (host == null) return null;
        String suffix = "." + SITE_DOMAIN;
        String lower = host.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(suffix)) return null;
        String label = lower.substring(0, lower.length() - suffix.length());
        if (label.isEmpty() || label.contains(".")) return null;
        return label;
    }
}
