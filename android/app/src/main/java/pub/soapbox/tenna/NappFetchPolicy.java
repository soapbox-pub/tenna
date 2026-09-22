package pub.soapbox.tenna;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * What {@code napp.fetch} is allowed to reach, and what it is allowed to say.
 *
 * <p>This is the whole of the security model. There is no prompt in front of
 * {@code napp.fetch} — a site that cannot reach the network is broken, and a
 * question with one sane answer only teaches people to say yes — so what
 * stands between a site and the device is this file and nothing else. It is
 * deliberately plain Java with no Android imports, so it can be tested on the
 * JVM rather than trusted.
 *
 * <p>Three separate things are being defended:
 *
 * <ul>
 *   <li><b>The user's ambient authority.</b> CORS exists because a browser
 *       attaches cookies to a request and a page is not entitled to read what
 *       those cookies unlocked. Lifting CORS without lifting the credentials
 *       keeps that true: every request made here is anonymous, so there is no
 *       authority for the site to borrow. That is enforced in
 *       {@link NappFetch}, which installs no cookie jar, and here, by refusing
 *       to let a site set {@code Cookie}, {@code Origin} or {@code Referer} by
 *       hand.
 *   <li><b>The device's position on the network.</b> A phone sits inside a
 *       house. A page that can fetch without CORS can fetch a router's admin
 *       page, another app's local server, a printer — none of which a browser
 *       would allow, and all of which are reachable only because the request
 *       comes from this side of the door. {@link #refuseAddress} is the door;
 *       it runs on the address actually connected to, on every redirect hop,
 *       which is what makes it proof against a name that resolves differently
 *       the second time.
 *   <li><b>Tenna itself.</b> {@code *.localhost} is where every nsite lives.
 *       Without the name check a site could fetch another site's reserved
 *       {@code /.napp/} paths from a context the token check was never written
 *       to expect.
 * </ul>
 */
final class NappFetchPolicy {

    private NappFetchPolicy() {}

    // ── Ceilings ─────────────────────────────────────────────────────────────

    /**
     * The largest body a site's window may send.
     *
     * <p>It crosses as a single {@code WebMessageCompat} array buffer, which is
     * a Mojo message and not a stream, so this is a real ceiling rather than a
     * policy — the whole thing is in memory twice on the way through. A site
     * wanting to put a film on a Blossom server is asking for something this
     * transport cannot give it.
     */
    static final int MAX_WINDOW_BODY_BYTES = 16 * 1024 * 1024;

    /**
     * The largest body a site's <b>worker</b> may send.
     *
     * <p>The same number, and now for the same reason. A worker's body crosses
     * its {@link NappPort} in chunks, each written to the socket as it arrives,
     * so nothing about the transport bounds it — this is policy, and the memory
     * cost of raising it would be nothing. What stops it going further is the
     * clock: a worker woken by a push has sixty seconds, and sixteen megabytes
     * does not go over a mobile connection inside that.
     */
    static final int MAX_WORKER_BODY_BYTES = 16 * 1024 * 1024;

    /** The largest single chunk of a body, in either direction. */
    static final int MAX_CHUNK_BYTES = 512 * 1024;

    /**
     * How many chunks either end may have unacknowledged.
     *
     * <p>A message port has no backpressure of its own — {@code postMessage}
     * always succeeds and the far end's queue grows — so this is it, in both
     * directions. It is also the whole memory cost of a body of any size: two
     * chunks outstanding and one being dealt with, about a megabyte and a half,
     * whether the body is one kilobyte or sixteen megabytes.
     */
    static final int MAX_STAGED_CHUNKS = 2;

    /**
     * How long either end waits for the next chunk, or for an acknowledgement,
     * before giving up.
     *
     * <p>The backstop for a worker that went away halfway through. Chromium
     * stops an idle service worker without telling anybody, a
     * {@code postMessage} to one that has gone throws nothing, and a port has
     * no close callback — so a silence is the only symptom there is, and this
     * is how long one is given the benefit of the doubt. Without it a
     * {@code writeTo} would block on a queue nobody will ever add to, holding
     * a socket for as long as the process lives.
     */
    static final long CHUNK_STALL_MS = 30_000;

    /** The largest response that will be relayed, in bytes. */
    static final long MAX_RESPONSE_BYTES = 64L * 1024 * 1024;

    /** How many redirects are followed before giving up. */
    static final int MAX_REDIRECTS = 5;

    /** How many requests one site may have in flight at once. */
    static final int MAX_IN_FLIGHT_PER_SITE = 8;

    /** How long a staged request waits to be collected before it is dropped. */
    static final long TICKET_TTL_MS = 30_000;

    /** How long an interception will block waiting for response headers. */
    static final long HEADERS_TIMEOUT_MS = 30_000;

    // ── Where a site may go ──────────────────────────────────────────────────

    /**
     * Why this URL is refused, or null if it is allowed.
     *
     * <p>The message is handed to the site, so it says what is wrong without
     * saying anything about the device.
     */
    @Nullable
    static String refuseUrl(@Nullable String url) {
        if (url == null || url.isEmpty()) return "No URL";

        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return "Not a URL";
        }

        if (!uri.isAbsolute()) return "Not an absolute URL";

        String scheme = uri.getScheme();
        if (scheme == null || !"https".equals(scheme.toLowerCase(Locale.ROOT))) {
            // http is refused along with everything else. The only plaintext
            // hosts a phone can usefully reach are on its own network, and
            // those are refused below anyway — so allowing it would buy
            // nothing but a way to have the request read off the air.
            return "Only https URLs can be fetched";
        }

        // Credentials in a URL are sent as an Authorization header before
        // anyone has looked at the host, survive a redirect if nobody strips
        // them, and are not a thing a site needs a special fetch to do.
        if (uri.getUserInfo() != null) return "Credentials in the URL are not allowed";

        String host = uri.getHost();
        if (host == null || host.isEmpty()) return "No host";

        return refuseHost(host);
    }

    /**
     * Why this hostname is refused, or null if it is allowed.
     *
     * <p>Names only. An address that a permitted name resolves to is judged
     * separately, and later, by {@link #refuseAddress} — a name tells you
     * nothing about where it points.
     */
    @Nullable
    static String refuseHost(@Nullable String host) {
        if (host == null || host.isEmpty()) return "No host";

        String lower = host.toLowerCase(Locale.ROOT);

        // A bracketed IPv6 literal, as it appears in a URL.
        if (lower.startsWith("[") && lower.endsWith("]")) {
            lower = lower.substring(1, lower.length() - 1);
        }

        // Everything Tenna serves itself. `*.localhost` is where every nsite
        // lives and is a secure context by fiat, so a site reaching one is a
        // site reaching its neighbours' reserved paths.
        if (lower.equals("localhost") || lower.endsWith(".localhost")) {
            return "That host is not reachable";
        }

        // Names that resolve on the local network rather than in DNS.
        if (lower.endsWith(".local")
            || lower.endsWith(".internal")
            || lower.endsWith(".home.arpa")
            || lower.endsWith(".onion")) {
            return "That host is not reachable";
        }

        // An address written out rather than named, which is the one shape
        // {@link #refuseAddress} would otherwise never see: there is nothing
        // to resolve, so OkHttp builds the socket address itself and
        // {@code GuardedDns} is never asked. A site asking for
        // {@code https://192.168.1.1/} by name is refused by the resolver and
        // by number was not refused at all.
        InetAddress literal = addressIn(lower);
        if (literal != null && refuseAddress(literal) != null) {
            return "That host is not reachable";
        }

        return null;
    }

    /**
     * The address a host is, if it is written as one rather than named.
     *
     * <p>Parsed without asking anybody: a hostname is returned as null rather
     * than resolved, because resolving here would both be a lookup the caller
     * did not ask for and defeat the point of doing the address check at the
     * resolver. {@code InetAddress.getByName} does no lookup for a literal,
     * and the shape test in front of it is what keeps a name from reaching it.
     */
    @Nullable
    private static InetAddress addressIn(@NonNull String host) {
        boolean numeric = host.indexOf(':') >= 0;
        if (!numeric) {
            // IPv4, or one of the older spellings of it — a bare number, or
            // fewer than four parts — all of which InetAddress understands and
            // a site could hide an address in.
            numeric = !host.isEmpty();
            for (int i = 0; i < host.length(); i++) {
                char c = host.charAt(i);
                if (c != '.' && (c < '0' || c > '9')) {
                    numeric = false;
                    break;
                }
            }
        }
        if (!numeric) return null;

        try {
            return InetAddress.getByName(host);
        } catch (java.net.UnknownHostException e) {
            return null;
        }
    }

    /**
     * Why this address is refused, or null if it may be connected to.
     *
     * <p>Called from the resolver, so it applies to the address the socket
     * will actually be opened to. Filtering names alone would stop nothing:
     * a host under the site's control can return {@code 127.0.0.1} for its
     * own name, which is a perfectly ordinary DNS record and exactly how a
     * page talks to something it should not be able to see.
     */
    @Nullable
    static String refuseAddress(@Nullable InetAddress address) {
        if (address == null) return "Unresolvable";

        if (address.isAnyLocalAddress()) return "Unroutable address";
        if (address.isLoopbackAddress()) return "Unroutable address";
        if (address.isLinkLocalAddress()) return "Unroutable address";
        if (address.isSiteLocalAddress()) return "Private address";
        if (address.isMulticastAddress()) return "Unroutable address";

        byte[] bytes = address.getAddress();

        if (bytes.length == 4) {
            int a = bytes[0] & 0xff;
            int b = bytes[1] & 0xff;

            // 0.0.0.0/8 — "this network".
            if (a == 0) return "Unroutable address";
            // 100.64.0.0/10 — carrier-grade NAT, which on a phone is the
            // carrier's own network rather than the public internet.
            if (a == 100 && b >= 64 && b <= 127) return "Private address";
            // 192.0.0.0/24 — IETF protocol assignments.
            if (a == 192 && b == 0 && (bytes[2] & 0xff) == 0) return "Unroutable address";
            // 198.18.0.0/15 — benchmarking.
            if (a == 198 && (b == 18 || b == 19)) return "Unroutable address";
            // 240.0.0.0/4 — reserved, including the broadcast address.
            if (a >= 240) return "Unroutable address";
        } else if (bytes.length == 16) {
            // fc00::/7 — unique local addresses. Java's isSiteLocalAddress
            // only knows the deprecated fec0::/10, so this is on us.
            if ((bytes[0] & 0xfe) == 0xfc) return "Private address";

            // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 coat. Java
            // usually hands these back as an Inet4Address, but "usually" is
            // not a thing to rest this on.
            boolean mapped = true;
            for (int i = 0; i < 10; i++) {
                if (bytes[i] != 0) { mapped = false; break; }
            }
            if (mapped && (bytes[10] & 0xff) == 0xff && (bytes[11] & 0xff) == 0xff) {
                byte[] inner = Arrays.copyOfRange(bytes, 12, 16);
                try {
                    return refuseAddress(InetAddress.getByAddress(inner));
                } catch (java.net.UnknownHostException e) {
                    return "Unroutable address";
                }
            }
        }

        return null;
    }

    // ── What a site may say ──────────────────────────────────────────────────

    /**
     * Headers a site does not get to set.
     *
     * <p>Three kinds. Ones that describe the connection rather than the
     * request, which belong to whoever is making it; ones the browser would
     * refuse for the same reason it refuses them to {@code fetch}; and ones
     * that would let a site claim to be somebody else to the far end.
     *
     * <p>{@code Accept-Encoding} is on the list for a duller reason. OkHttp
     * only decompresses transparently when it set the header itself, and a
     * response handed back through {@code shouldInterceptRequest} is not run
     * through Chromium's decoder — so a site that asked for gzip would be
     * given gzip and no way to know.
     */
    private static final Set<String> FORBIDDEN_REQUEST_HEADERS = new HashSet<>(Arrays.asList(
        "accept-encoding",
        "connection",
        "content-length",
        "cookie",
        "cookie2",
        "date",
        "expect",
        "forwarded",
        "host",
        "keep-alive",
        "origin",
        "referer",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via"
    ));

    /** Prefixes refused wholesale, for the same reasons as the list above. */
    private static final String[] FORBIDDEN_REQUEST_PREFIXES = {
        "proxy-", "sec-", "x-forwarded-", "access-control-request-"
    };

    /** Whether a site may set this request header. */
    static boolean isForbiddenRequestHeader(@Nullable String name) {
        if (name == null || name.isEmpty()) return true;

        String lower = name.toLowerCase(Locale.ROOT);
        if (!isTokenName(lower)) return true;
        if (FORBIDDEN_REQUEST_HEADERS.contains(lower)) return true;

        for (String prefix : FORBIDDEN_REQUEST_PREFIXES) {
            if (lower.startsWith(prefix)) return true;
        }

        return false;
    }

    /**
     * Headers stripped from the response before the site sees it.
     *
     * <p>{@code Set-Cookie} because the request was anonymous and is going to
     * stay that way — a cookie relayed to the site is a cookie the site can
     * put back on the next request by hand, which is the credential path
     * closing by the back door. The rest either describe a connection that no
     * longer exists by the time the site reads them, or describe a body that
     * has already been decoded.
     */
    private static final Set<String> STRIPPED_RESPONSE_HEADERS = new HashSet<>(Arrays.asList(
        "connection",
        "content-encoding",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "set-cookie",
        "set-cookie2",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade"
    ));

    /** Whether this response header is kept out of what the site is handed. */
    static boolean isStrippedResponseHeader(@Nullable String name) {
        if (name == null || name.isEmpty()) return true;
        return STRIPPED_RESPONSE_HEADERS.contains(name.toLowerCase(Locale.ROOT));
    }

    /** Whether a string is a valid HTTP field name, as RFC 7230 defines one. */
    private static boolean isTokenName(@NonNull String name) {
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c <= 0x20 || c >= 0x7f) return false;
            if ("()<>@,;:\\\"/[]?={}".indexOf(c) >= 0) return false;
        }
        return true;
    }

    /** Whether a header value is one that can be sent without reframing anything. */
    static boolean isValidHeaderValue(@Nullable String value) {
        if (value == null) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\n' || c == '\r' || c == 0) return false;
        }
        return true;
    }

    // ── Answering ────────────────────────────────────────────────────────────

    /**
     * A reason phrase for a status code.
     *
     * <p>{@code WebResourceResponse} refuses a status with an empty reason
     * phrase, and HTTP/2 has no reason phrases at all — every response over it
     * arrives with an empty message. So one is supplied rather than relayed.
     */
    @NonNull
    static String reasonFor(int status, @Nullable String given) {
        if (given != null && !given.trim().isEmpty() && isTokenValueAscii(given)) {
            return given.trim();
        }

        switch (status) {
            case 200: return "OK";
            case 201: return "Created";
            case 202: return "Accepted";
            case 204: return "No Content";
            case 206: return "Partial Content";
            case 304: return "Not Modified";
            case 400: return "Bad Request";
            case 401: return "Unauthorized";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 409: return "Conflict";
            case 410: return "Gone";
            case 413: return "Payload Too Large";
            case 429: return "Too Many Requests";
            case 500: return "Internal Server Error";
            case 501: return "Not Implemented";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            case 504: return "Gateway Timeout";
            default: return status >= 400 ? "Error" : "Status";
        }
    }

    /** Whether a status code is one a {@code WebResourceResponse} may carry. */
    static boolean isServableStatus(int status) {
        return status >= 100 && status <= 599;
    }

    /**
     * Whether a status is one that must be served with no body at all.
     *
     * <p>Chromium rejects a {@code WebResourceResponse} that contradicts
     * itself here, and a 304 relayed with the body that came with it is a
     * contradiction the site never asked for.
     */
    static boolean isBodilessStatus(int status) {
        return status == 204 || status == 205 || status == 304;
    }

    private static boolean isTokenValueAscii(@NonNull String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || c >= 0x7f) return false;
        }
        return true;
    }

    // ── Methods ──────────────────────────────────────────────────────────────

    /** Methods a site may use. */
    private static final Set<String> METHODS = new HashSet<>(Arrays.asList(
        "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"
    ));

    /**
     * The method, normalised, or null if it is not one a site may use.
     *
     * <p>{@code CONNECT}, {@code TRACE} and {@code TRACK} are forbidden to
     * {@code fetch} by the standard and are forbidden here for the same
     * reasons, along with anything invented.
     */
    @Nullable
    static String normalizeMethod(@Nullable String method) {
        if (method == null || method.isEmpty()) return "GET";
        String upper = method.toUpperCase(Locale.ROOT);
        return METHODS.contains(upper) ? upper : null;
    }

    /** Whether a method is one that may carry a request body. */
    static boolean allowsBody(@NonNull String method) {
        return !"GET".equals(method) && !"HEAD".equals(method);
    }

    /**
     * Whether a redirect from this status turns the request into a bodiless
     * GET, as the standard says it does.
     *
     * <p>303 always; 301 and 302 for anything but GET and HEAD, which is not
     * what the original RFC said and is what every browser has done for thirty
     * years.
     */
    static boolean redirectBecomesGet(int status, @NonNull String method) {
        if (status == 303) return true;
        if (status == 301 || status == 302) {
            return !"GET".equals(method) && !"HEAD".equals(method);
        }
        return false;
    }

    /** Whether a status is a redirect this follows. */
    static boolean isRedirect(int status) {
        return status == 301 || status == 302 || status == 303
            || status == 307 || status == 308;
    }
}
