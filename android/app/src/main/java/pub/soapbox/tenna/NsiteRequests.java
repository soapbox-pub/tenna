package pub.soapbox.tenna;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Everything served under an nsite's own origin, from wherever it was asked
 * for.
 *
 * There are three askers and they must all answer alike: the site's own
 * WebView, the WebView the push service opens to wake a worker, and the
 * process-wide {@link NsiteServiceWorkers} client that every service worker
 * fetch goes to. Which one a given request arrives on is not the site's
 * business, so the routing lives here rather than in any of them.
 *
 * Two paths are Tenna's rather than the site's, and are reserved under every
 * site origin:
 *
 * <ul>
 *   <li>{@value #WAKE_PATH} — the page the push service navigates to in order
 *       to reach the site's worker. A site whose worker claims navigations
 *       answers this itself, from the shim; otherwise it is served here.
 *   <li>{@value #NOTIFICATION_PATH} — where the shim sends a
 *       {@code showNotification}. A GET, with the payload in the query, because
 *       {@code shouldInterceptRequest} is never given a request body.
 * </ul>
 *
 * Nothing outside this process can reach either. Interception is not a socket:
 * a request only arrives here because a WebView of ours made it.
 */
final class NsiteRequests {

    private static final String TAG = "NsiteRequests";

    /** The page the push service loads to reach a site's service worker. */
    static final String WAKE_PATH = "/.napp/wake";

    /** Where a worker's {@code showNotification} lands. */
    static final String NOTIFICATION_PATH = "/.napp/notification";

    /** Query parameter carrying the base64url notification payload. */
    static final String PAYLOAD_PARAM = "p";

    /** Header the browser sets on the fetch of a worker script, and on nothing else. */
    private static final String SERVICE_WORKER_HEADER = "Service-Worker";

    /** Placeholder in the shim source for the page it may have to serve. */
    private static final String WAKE_PAGE_PLACEHOLDER = "%%NAPP_WAKE_PAGE%%";

    @Nullable private static String wakePage;
    @Nullable private static String shim;
    private static boolean assetsLoaded;

    private NsiteRequests() {}

    /**
     * Answer a request for a site's origin, or return null to let it go to the
     * network.
     *
     * Anything but a site origin is somebody else's business — an nsite
     * fetching a relay, an avatar, a Blossom blob of its own.
     *
     * Any site origin, not only the caller's own: a worker is served here for
     * whichever site it belongs to, and often for one with no window at all.
     * A site asking for another site's files is answered too, and gains
     * nothing by it — the response is cross-origin, so it cannot read it, and
     * every byte an nsite is made of is public in the first place.
     */
    @Nullable
    static WebResourceResponse serve(@NonNull Context context, @NonNull WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"https".equalsIgnoreCase(url.getScheme())) return null;

        String host = url.getHost();
        String siteId = NsiteOrigins.siteIdFor(host);
        if (siteId == null) return null;

        String path = url.getPath();

        if (NOTIFICATION_PATH.equals(path)) {
            return notification(context, siteId, url);
        }

        if (WAKE_PATH.equals(path)) {
            String page = wakePage(context);
            return page == null
                ? NsiteFileServer.Response.empty(404, "Not Found").toWebResource()
                : html(page);
        }

        NsiteFileServer server = NsiteFileServers.resolve(context, host);
        if (server == null) {
            return NsiteFileServer.Response.text(404, "Not Found", "No such site").toWebResource();
        }

        boolean workerScript = "script".equalsIgnoreCase(header(request, SERVICE_WORKER_HEADER));
        return server.serve(url, workerScript ? shim(context) : null).toWebResource();
    }

    /** Show a notification a worker asked for, and answer its fetch. */
    private static WebResourceResponse notification(Context context, String siteId, Uri url) {
        String encoded;
        try {
            encoded = url.getQueryParameter(PAYLOAD_PARAM);
        } catch (UnsupportedOperationException e) {
            encoded = null;
        }
        if (encoded == null) {
            return NsiteFileServer.Response.empty(400, "Bad Request").toWebResource();
        }

        JSONObject payload;
        try {
            byte[] bytes = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            payload = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException | JSONException e) {
            return NsiteFileServer.Response.empty(400, "Bad Request").toWebResource();
        }

        boolean shown = NappNotifications.show(context, siteId, payload);
        return NsiteFileServer.Response
            .empty(shown ? 200 : 403, shown ? "OK" : "Forbidden")
            .toWebResource();
    }

    // -----------------------------------------------------------------------
    // Assets
    // -----------------------------------------------------------------------

    /**
     * The shim appended to a site's worker script, or null if it could not be
     * read.
     *
     * It carries the wake page inside it: a worker with a fetch handler claims
     * every navigation at its origin, including the one the push service makes
     * to reach it, so the worker has to be able to answer that request itself.
     */
    @Nullable
    static synchronized String shim(@NonNull Context context) {
        load(context);
        return shim;
    }

    @Nullable
    private static synchronized String wakePage(@NonNull Context context) {
        load(context);
        return wakePage;
    }

    private static void load(Context context) {
        if (assetsLoaded) return;
        assetsLoaded = true;

        wakePage = readRaw(context, R.raw.napp_wake);
        String source = readRaw(context, R.raw.napp_sw_shim);
        shim = source == null || wakePage == null
            ? null
            // A JS string literal; org.json's quoting is also valid JS, and
            // escapes the `</` that would otherwise end an inline script.
            : source.replace(WAKE_PAGE_PLACEHOLDER, JSONObject.quote(wakePage));
    }

    @Nullable
    private static String readRaw(Context context, int resource) {
        try (InputStream in = context.getResources().openRawResource(resource)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(4096);
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "Raw resource unreadable; workers will run without the push shim", e);
            return null;
        }
    }

    // -----------------------------------------------------------------------

    private static WebResourceResponse html(String source) {
        byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new NsiteFileServer.Response(
            200, "OK", "text/html", "UTF-8", headers, new ByteArrayInputStream(bytes), bytes.length
        ).toWebResource();
    }

    /** A request header, matched without regard to case as HTTP defines it. */
    @Nullable
    private static String header(WebResourceRequest request, String name) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return null;
        String direct = headers.get(name);
        if (direct != null) return direct;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }
}
