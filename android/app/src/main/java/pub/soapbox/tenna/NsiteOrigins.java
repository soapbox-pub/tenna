package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Locale;
import java.util.regex.Pattern;

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

    /**
     * A DNS label, which is all a site id is ever allowed to be. The Java side
     * of {@code isNsiteLabel} in {@code src/lib/nsiteSubdomain.ts}.
     *
     * A named site's id ends in its {@code d} tag, which is arbitrary text off
     * a stranger's event, and the id is concatenated into a URL here. A tag
     * carrying {@code /}, {@code \}, {@code ?}, {@code #} or {@code @} names a
     * host that is not ours — and {@link android.webkit.WebView#loadUrl} does
     * not consult {@code shouldOverrideUrlLoading}, so the site's own window
     * would load somebody else's page. The same string is the origin the
     * message listener and the document-start script are scoped to, where a
     * malformed rule throws on the UI thread.
     */
    private static final Pattern LABEL = Pattern.compile("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$");

    private NsiteOrigins() {}

    /** Whether a string is a site id — that is, a DNS label. */
    static boolean isSiteId(@Nullable String siteId) {
        return siteId != null && LABEL.matcher(siteId).matches();
    }

    /**
     * The host a site is served on.
     *
     * Refuses rather than lowercases anything that is not already a label:
     * every id this app holds was produced by the web layer, which builds them
     * lowercase, so a value needing the fold is a value from somewhere else.
     */
    @NonNull
    static String hostFor(@NonNull String siteId) {
        if (!isSiteId(siteId)) throw new IllegalArgumentException("Not a site id: " + siteId);
        return siteId + "." + SITE_DOMAIN;
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
        if (!isSiteId(label)) return null;
        return label;
    }
}
