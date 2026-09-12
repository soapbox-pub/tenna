package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The two strings a remote connection can start from.
 *
 * <p>{@code bunker://} is the signer's invitation: Tenna makes a key and a
 * secret, and whoever quotes the secret first becomes the client. {@code
 * nostrconnect://} is the client's: it names itself, its relays, and a secret
 * of its own that Tenna has to quote back so the client knows it reached the
 * right signer.
 *
 * <p>Parsed by hand rather than with {@code Uri}, because both carry a bare
 * 64-character pubkey where a URI expects a host — and {@code Uri.getHost}
 * lowercases, which is harmless for hex but not something to depend on — and
 * because {@code relay} is repeatable, which the platform's query helpers do
 * not return more than once from every version of Android this runs on.
 */
final class BunkerUris {

    private static final int MAX_RELAYS = 8;

    private BunkerUris() {}

    /** What a {@code nostrconnect://} string was asking for. */
    static final class NostrConnect {
        @NonNull final String clientPubkey;
        @NonNull final String secret;
        @NonNull final List<String> relays;
        @NonNull final String name;
        @NonNull final String url;
        @NonNull final String image;
        /** The comma-separated {@code perms} list, as it arrived. */
        @NonNull final String perms;

        NostrConnect(@NonNull String clientPubkey, @NonNull String secret,
                     @NonNull List<String> relays, @NonNull String name,
                     @NonNull String url, @NonNull String image, @NonNull String perms) {
            this.clientPubkey = clientPubkey;
            this.secret = secret;
            this.relays = relays;
            this.name = name;
            this.url = url;
            this.image = image;
            this.perms = perms;
        }
    }

    /**
     * Read a {@code nostrconnect://} string, or null if it is not one.
     *
     * <p>A client with no relay is refused rather than given the signer's
     * defaults: the relays in the string are where that client is listening,
     * and a connection made on relays it never named is one it will never hear
     * an answer on.
     *
     * <p>A client with no secret is refused too. The secret is the only thing
     * that tells the client it reached the signer the user meant rather than
     * someone who scraped the string off a screen.
     */
    @Nullable
    static NostrConnect parseNostrConnect(@Nullable String uri) {
        if (uri == null) return null;

        String rest = strip(uri, "nostrconnect://");
        if (rest == null) return null;

        int split = rest.indexOf('?');
        String clientPubkey = (split < 0 ? rest : rest.substring(0, split)).trim();
        if (!isPubkey(clientPubkey)) return null;

        String secret = "", name = "", url = "", image = "", perms = "";
        Set<String> relays = new LinkedHashSet<>();

        if (split >= 0) {
            for (String pair : rest.substring(split + 1).split("&")) {
                if (pair.isEmpty()) continue;
                int equals = pair.indexOf('=');
                if (equals < 0) continue;

                String key = pair.substring(0, equals);
                String value = decode(pair.substring(equals + 1));

                switch (key) {
                    case "relay": {
                        String relay = normalizeRelay(value);
                        if (relay != null && relays.size() < MAX_RELAYS) relays.add(relay);
                        break;
                    }
                    case "secret": secret = value; break;
                    case "name": name = value; break;
                    case "url": url = value; break;
                    case "image": image = value; break;
                    case "perms": perms = value; break;
                    default: break;
                }
            }
        }

        if (secret.isEmpty() || relays.isEmpty()) return null;

        return new NostrConnect(clientPubkey, secret, new ArrayList<>(relays),
            name, url, image, perms);
    }

    /**
     * The invitation for a connection Tenna made.
     *
     * <p>It names the connection's own key, never the user's — see
     * {@link BunkerConnections}. What the client learns from this string is
     * where to talk and what to say; who it is talking to is something it has
     * to ask for afterwards.
     */
    @NonNull
    static String bunkerUri(@NonNull BunkerConnections.Connection connection) {
        StringBuilder uri = new StringBuilder("bunker://").append(connection.localPubkey);

        char separator = '?';
        for (String relay : connection.relays) {
            uri.append(separator).append("relay=").append(encode(relay));
            separator = '&';
        }
        if (!connection.secret.isEmpty()) {
            uri.append(separator).append("secret=").append(encode(connection.secret));
        }
        return uri.toString();
    }

    // ── Pieces ───────────────────────────────────────────────────────────────

    /** Case-insensitively take a scheme off the front, or null. */
    @Nullable
    private static String strip(@NonNull String uri, @NonNull String scheme) {
        String trimmed = uri.trim();
        return trimmed.length() > scheme.length()
            && trimmed.substring(0, scheme.length()).equalsIgnoreCase(scheme)
            ? trimmed.substring(scheme.length())
            : null;
    }

    static boolean isPubkey(@Nullable String value) {
        if (value == null || value.length() != 64) return false;
        for (int i = 0; i < 64; i++) {
            char c = value.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
            if (!hex) return false;
        }
        return true;
    }

    /**
     * A relay URL, or null if it is not one.
     *
     * <p>Same rules as a site's subscriptions use: a websocket scheme and a
     * host, nothing else. A connection's relays end up as sockets this app
     * opens and keeps open, so an {@code http://} or a {@code file://} in here
     * would be somebody choosing what a background service connects to.
     */
    @Nullable
    static String normalizeRelay(@Nullable String value) {
        if (value == null) return null;

        String trimmed = value.trim();
        if (trimmed.isEmpty()) return null;

        String lower = trimmed.toLowerCase(java.util.Locale.ROOT);
        if (!lower.startsWith("wss://") && !lower.startsWith("ws://")) return null;

        int schemeEnd = trimmed.indexOf("://") + 3;
        if (schemeEnd >= trimmed.length()) return null;

        String authority = trimmed.substring(schemeEnd);
        int slash = authority.indexOf('/');
        String host = slash < 0 ? authority : authority.substring(0, slash);
        if (host.isEmpty() || host.contains("@")) return null;

        // Last, and only once the host is known to exist: stripping first
        // would turn a bare `wss://` into `wss:`, which has no host left to
        // notice the absence of.
        while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);

        return trimmed;
    }

    @NonNull
    private static String decode(@NonNull String value) {
        try {
            return URLDecoder.decode(value, "UTF-8");
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return value;
        }
    }

    @NonNull
    private static String encode(@NonNull String value) {
        try {
            return URLEncoder.encode(value, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            return value;
        }
    }
}
