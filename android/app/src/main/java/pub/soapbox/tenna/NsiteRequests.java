package pub.soapbox.tenna;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
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
 *       {@code shouldInterceptRequest} is never given a request body. Its
 *       neighbours {@value #NOTIFICATIONS_PATH}, {@value #CLOSE_PATH} and
 *       {@value #OPEN_PATH} are the rest of what a worker can do to a
 *       notification: read the tray back, take one down, and open the window
 *       a tap on one leads to.
 *   <li>{@code /.napp/nostr} — where a worker's {@code self.nostr} calls land,
 *       which is the same token-authenticated shape for the same reason. See
 *       {@link NsiteWorkerSigner}.
 *   <li>{@value #SHARE_PATH} — the page that turns a staged share into a real
 *       form POST at the site's own origin, for a {@code share_target} that
 *       asked for one. Only a document there can make that navigation.
 *   <li>{@value #SHARE_FILE_PATH}{@code /<n>} — one shared file's bytes, for
 *       that page to fetch back and put in the form.
 * </ul>
 *
 * That same missing request body is what decides how a share is answered. A
 * POST navigation only reaches here when the site's service worker did not
 * claim it — a worker that did would have taken it long before — so arriving
 * here at all is proof there is nobody to hand it to, and it is answered with
 * a page saying so rather than with the site's own index.
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

    /** Where a worker's {@code getNotifications} lands. */
    static final String NOTIFICATIONS_PATH = "/.napp/notifications";

    /** Where a worker's {@code Notification.close} lands. */
    static final String CLOSE_PATH = "/.napp/close";

    /** Where a worker's {@code clients.openWindow} and {@code focus} land. */
    static final String OPEN_PATH = "/.napp/open";

    /** Query parameter carrying the base64url notification payload. */
    static final String PAYLOAD_PARAM = "p";

    /** Query parameter naming one notification, by the key the host gave it. */
    static final String KEY_PARAM = "k";

    /** Query parameter naming a site-absolute path to open the site at. */
    static final String URL_PARAM = "u";

    /** Query parameter narrowing {@link #NOTIFICATIONS_PATH} to one tag. */
    static final String TAG_PARAM = "tag";

    /** Query parameter proving the caller is the site's own worker. */
    static final String AUTH_PARAM = "a";

    /** The page that submits a staged share as a form, for a POST target. */
    static final String SHARE_PATH = "/.tenna/share";

    /** Where that page fetches the shared files back from. */
    static final String SHARE_FILE_PATH = "/.tenna/share/file";

    /** Query parameter naming the staged share. */
    static final String TOKEN_PARAM = "t";

    /** Header the browser sets on the fetch of a worker script, and on nothing else. */
    private static final String SERVICE_WORKER_HEADER = "Service-Worker";

    /** Placeholder in the shim source for the page it may have to serve. */
    private static final String WAKE_PAGE_PLACEHOLDER = "%%NAPP_WAKE_PAGE%%";

    /** Placeholder in the shim source for the site's own token. */
    private static final String SITE_TOKEN_PLACEHOLDER = "%%NAPP_SITE_TOKEN%%";

    /** Placeholder in the share page for the form it is to build. */
    private static final String SHARE_PLAN_PLACEHOLDER = "%%TENNA_SHARE_PLAN%%";

    @Nullable private static String wakePage;
    @Nullable private static String sharePage;
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

        // The paths that do something rather than serve something. A worker's
        // fetch arrives with no WebView attached, so the host in the URL is
        // the only thing naming a site — and a host is not proof, since any
        // site can fetch any other site's paths. The token is. See NappTokens.
        if (NOTIFICATION_PATH.equals(path)
            || NOTIFICATIONS_PATH.equals(path)
            || CLOSE_PATH.equals(path)
            || OPEN_PATH.equals(path)
            || NsiteWorkerSigner.PATH.equals(path)) {

            if (!NappTokens.matches(context, siteId, query(url, AUTH_PARAM))) {
                Log.i(TAG, "Refused an unauthenticated " + path + " for " + siteId);
                return NsiteFileServer.Response.empty(403, "Forbidden").toWebResource();
            }

            if (NOTIFICATION_PATH.equals(path)) return notification(context, siteId, url);
            if (NOTIFICATIONS_PATH.equals(path)) return notifications(context, siteId, url);
            if (CLOSE_PATH.equals(path)) return close(context, siteId, url);
            if (NsiteWorkerSigner.PATH.equals(path)) {
                return NsiteWorkerSigner.serve(context, siteId, url);
            }
            return open(context, siteId, url);
        }

        if (WAKE_PATH.equals(path)) {
            String page = wakePage(context);
            return page == null
                ? NsiteFileServer.Response.empty(404, "Not Found").toWebResource()
                : html(page);
        }

        if (SHARE_PATH.equals(path)) {
            return sharePage(context, siteId, url);
        }

        if (path != null && path.startsWith(SHARE_FILE_PATH + "/")) {
            return sharedFile(context, siteId, url, path);
        }

        // A share posted to a site whose worker did not claim it. See the note
        // on the class: interception cannot recover a request body, so getting
        // here at all is proof there is nobody to hand it to.
        //
        // Only a navigation. A site posting to its own origin from script is
        // doing something else entirely, and gets the ordinary answer — which
        // is a 404, since there is no file at a path it would post to.
        if ("POST".equalsIgnoreCase(request.getMethod()) && request.isForMainFrame()) {
            return html(UNCLAIMED_POST);
        }

        NsiteFileServer server = NsiteFileServers.resolve(context, host);
        if (server == null) {
            return NsiteFileServer.Response.text(404, "Not Found", "No such site").toWebResource();
        }

        boolean workerScript = "script".equalsIgnoreCase(header(request, SERVICE_WORKER_HEADER));
        return server.serve(url, workerScript ? shim(context, siteId) : null).toWebResource();
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

    /**
     * The site's notifications as they currently stand, for
     * {@code registration.getNotifications()}.
     *
     * Only its own — the site id comes off the request's host, so a site can
     * no more read another's tray than it can post to it.
     */
    private static WebResourceResponse notifications(Context context, String siteId, Uri url) {
        String tag = query(url, TAG_PARAM);
        JSONArray out = new JSONArray();

        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            if (tag != null && !tag.equals(entry.tag)) continue;
            try {
                JSONObject json = new JSONObject();
                json.put("key", entry.key);
                json.put("tag", entry.tag);
                json.put("title", entry.title);
                json.put("options", new JSONObject(entry.options));
                out.put(json);
            } catch (JSONException e) {
                // An unreadable record is one the site never hears about.
            }
        }

        return json(out.toString());
    }

    /** Take one of the site's notifications down. */
    private static WebResourceResponse close(Context context, String siteId, Uri url) {
        String key = query(url, KEY_PARAM);
        if (key == null || !key.startsWith(NsiteSites.key(siteId) + "/")) {
            return NsiteFileServer.Response.empty(400, "Bad Request").toWebResource();
        }

        NappNotifications.cancel(context, siteId, key);
        return NsiteFileServer.Response.empty(200, "OK").toWebResource();
    }

    /**
     * Open or resume the site's own window, at a path of its choosing.
     *
     * What {@code clients.openWindow()} and {@code WindowClient.focus()} mean
     * here. Neither works in a WebView on its own — a worker has no way to
     * make a browsing context, and focusing one is a window-manager act rather
     * than a web one — so both come back out to the host, which starts the
     * same activity a notification's tap does.
     *
     * A site can only open itself: the id is the request's host, and the path
     * is refused unless it is one inside the site. And only just after the
     * user acted on one of its notifications, which is the case the API is
     * for.
     */
    private static WebResourceResponse open(Context context, String siteId, Uri url) {
        String path = NappOptions.path(query(url, URL_PARAM));

        if (NsiteSites.load(context, siteId) == null) {
            return NsiteFileServer.Response.empty(404, "Not Found").toWebResource();
        }

        // Only in answer to something the user did. A worker that puts its
        // site on screen off the back of a relay event is not answering
        // anybody; see NappNotifications.
        if (!NappNotifications.recentlyInteracted(siteId)) {
            return NsiteFileServer.Response.empty(403, "Forbidden").toWebResource();
        }

        try {
            context.startActivity(
                NsiteAppActivity.notificationIntentFor(context, siteId, path, null)
            );
        } catch (RuntimeException e) {
            // Background activity launch restrictions. A worker woken by a tap
            // is inside the exemption window; one woken by a relay is not, and
            // has no business opening a window unasked anyway.
            Log.i(TAG, "Refused to open a window for " + siteId, e);
            return NsiteFileServer.Response.empty(403, "Forbidden").toWebResource();
        }

        return NsiteFileServer.Response.empty(200, "OK").toWebResource();
    }

    // -----------------------------------------------------------------------
    // Shares
    // -----------------------------------------------------------------------

    /**
     * The page that hands a staged share to the site as a form POST.
     *
     * Served only to the site the share was given to. The token is unguessable
     * and never leaves this process, but a share is somebody's photograph and
     * the check costs nothing.
     */
    private static WebResourceResponse sharePage(Context context, String siteId, Uri url) {
        String token = query(url, TOKEN_PARAM);
        NsiteShares.Delivery delivery =
            token == null ? null : NsiteShares.delivery(context, token);

        if (delivery == null || !delivery.siteId.equals(siteId) || delivery.plan == null) {
            return NsiteFileServer.Response.empty(404, "Not Found").toWebResource();
        }

        String page = sharePage(context);
        if (page == null) {
            return NsiteFileServer.Response.empty(404, "Not Found").toWebResource();
        }

        // The plan names the files by index; the page wants URLs it can fetch,
        // and only this side knows the token they hang off.
        String plan = withFileUrls(delivery.plan, token);
        if (plan == null) {
            return NsiteFileServer.Response.empty(500, "Internal Error").toWebResource();
        }

        return html(page.replace(SHARE_PLAN_PLACEHOLDER, plan));
    }

    /**
     * Rewrite the plan's file list into something fetchable, and make it safe
     * to sit in a script block.
     *
     * The plan is JSON built in the web layer out of the site's own manifest
     * and the shared payload, and it is read back with {@code JSON.parse} — but
     * it still lands inside an HTML document, where {@code </script} would end
     * the element early whatever the JSON says. Escaping the slash keeps the
     * text identical to the parser and inert to the tokenizer.
     */
    @Nullable
    private static String withFileUrls(String plan, String token) {
        try {
            JSONObject json = new JSONObject(plan);
            JSONArray files = json.optJSONArray("files");

            for (int i = 0; files != null && i < files.length(); i++) {
                JSONObject file = files.optJSONObject(i);
                if (file == null) continue;
                file.put(
                    "url",
                    SHARE_FILE_PATH + "/" + file.optInt("index", i)
                        + "?" + TOKEN_PARAM + "=" + token
                );
            }

            return json.toString()
                .replace("</", "<\\/")
                .replace("<!--", "<\\u0021--");
        } catch (JSONException e) {
            return null;
        }
    }

    /** One shared file, for the share page to put back into the form. */
    private static WebResourceResponse sharedFile(
        Context context,
        String siteId,
        Uri url,
        String path
    ) {
        String token = query(url, TOKEN_PARAM);
        int index;
        try {
            index = Integer.parseInt(path.substring(SHARE_FILE_PATH.length() + 1));
        } catch (NumberFormatException e) {
            return NsiteFileServer.Response.empty(404, "Not Found").toWebResource();
        }

        File file = token == null ? null : NsiteShares.file(context, token, siteId, index);
        if (file == null) {
            return NsiteFileServer.Response.empty(404, "Not Found").toWebResource();
        }

        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new NsiteFileServer.Response(
                200,
                "OK",
                "application/octet-stream",
                null,
                headers,
                new FileInputStream(file),
                file.length()
            ).toWebResource();
        } catch (IOException e) {
            return NsiteFileServer.Response.empty(404, "Not Found").toWebResource();
        }
    }

    /** A query parameter, or null if the URL has none to give. */
    @Nullable
    private static String query(Uri url, String name) {
        try {
            return url.getQueryParameter(name);
        } catch (UnsupportedOperationException e) {
            return null;
        }
    }

    /**
     * What a site gets when it declares a POST share target and has no service
     * worker to answer one.
     *
     * Static markup, with nothing of the site's or the share's in it.
     */
    private static final String UNCLAIMED_POST =
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        + "<title>Sharing</title><style>html,body{margin:0;height:100%;background:#150609;"
        + "color:#7CFC9B}body{display:flex;align-items:center;justify-content:center;"
        + "padding:2rem;box-sizing:border-box;font:1rem/1.6 system-ui,sans-serif;"
        + "text-align:center}p{margin:0;max-width:32rem}</style></head><body>"
        + "<p>This site asks for shares to be posted to it, but has no service worker "
        + "to receive them. Nothing was sent.</p></body></html>";

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
     *
     * And it carries the site's own token, which is why this is per site
     * rather than one shared string. The response it goes into is readable
     * only by the origin that asked for it, and only when the browser asked
     * for it as a worker script — see {@link NappTokens}.
     */
    @Nullable
    static synchronized String shim(@NonNull Context context, @NonNull String siteId) {
        load(context);
        if (shim == null) return null;
        return shim.replace(
            SITE_TOKEN_PLACEHOLDER,
            JSONObject.quote(NappTokens.forSite(context, siteId))
        );
    }

    @Nullable
    private static synchronized String wakePage(@NonNull Context context) {
        load(context);
        return wakePage;
    }

    @Nullable
    private static synchronized String sharePage(@NonNull Context context) {
        load(context);
        return sharePage;
    }

    private static void load(Context context) {
        if (assetsLoaded) return;
        assetsLoaded = true;

        wakePage = readRaw(context, R.raw.napp_wake);
        sharePage = readRaw(context, R.raw.tenna_share);
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

    private static WebResourceResponse json(String source) {
        byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new NsiteFileServer.Response(
            200, "OK", "application/json", "UTF-8", headers, new ByteArrayInputStream(bytes), bytes.length
        ).toWebResource();
    }

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
