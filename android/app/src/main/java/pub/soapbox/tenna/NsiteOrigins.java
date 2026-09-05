package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.Locale;

/**
 * Where an nsite lives, as far as the WebView is concerned.
 *
 * Chromium resolves any {@code *.localhost} name to loopback without asking
 * DNS, and treats the origin as potentially trustworthy, so a site at
 * {@code http://<site>.nsite.localhost:<port>} is a secure context — it can
 * use crypto.subtle, register a service worker, and the rest — while every
 * request it makes to its own origin lands on {@link NsiteHttpServer}.
 *
 * Unlike the shared, public {@code iframe.diy} domain the iframe path uses,
 * this one is reachable only from this device, so the site label can be the
 * plain NIP-5A subdomain rather than an HMAC of it.
 */
final class NsiteOrigins {

    /** Parent domain for site origins. */
    static final String SITE_DOMAIN = "nsite.localhost";

    private NsiteOrigins() {}

    /** The host a site is served on, without the port. */
    @NonNull
    static String hostFor(@NonNull String siteId) {
        return siteId.toLowerCase(Locale.ROOT) + "." + SITE_DOMAIN;
    }

    /**
     * The origin a site is served on.
     *
     * Only meaningful once {@link NsiteHttpServer} is up; the port is its.
     */
    @NonNull
    static String originFor(@NonNull String siteId) {
        return "http://" + hostFor(siteId) + ":" + NsiteHttpServer.port();
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
