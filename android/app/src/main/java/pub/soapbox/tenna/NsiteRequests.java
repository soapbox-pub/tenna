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
 * There are three askers: the site's own WebView, the WebView the push service
 * opens to wake a worker, and the service worker client — the process-wide
 * {@link NsiteServiceWorkers} one, or the per-site client {@link NsiteProfiles}
 * sets — that every service worker fetch goes to. For the site's own files they
 * answer alike, and which one a given request arrived on is none of the site's
 * business, so the routing lives here rather than in any of them.
 *
 * These paths are Tenna's rather than the site's, and are reserved under every
 * site origin:
 *
 * <ul>
 *   <li>{@value #WAKE_PATH} — the page the push service navigates to in order
 *       to reach the site's worker. A site whose worker claims navigations
 *       answers this itself, from the shim; otherwise it is served here.
 *   <li>{@code /.napp/fetch} — where a <em>window's</em> {@code napp.fetch} is
 *       collected. The one path here that answers with somebody else's bytes:
 *       the request was made out on the network and this is the site reading
 *       the response back in. See {@link NappFetch}.
 *   <li>{@value #SHARE_PATH} — the page that turns a staged share into a real
 *       form POST at the site's own origin, for a {@code share_target} that
 *       asked for one. Only a document there can make that navigation.
 *   <li>{@value #SHARE_FILE_PATH}{@code /<n>} — one shared file's bytes, for
 *       that page to fetch back and put in the form.
 * </ul>
 *
 * <p>A <b>service worker</b> used to have half a dozen paths of its own here —
 * one per thing it could ask Tenna for, each a GET with its payload written
 * out as base64 in the query string, because {@code shouldInterceptRequest} is
 * never given a request body. It has a {@link NappPort} now, and a port carries
 * bytes, speaks in both directions, and lands on a thread of Tenna's. What is
 * left of the worker's business here is the wake page and the script it is
 * installed from, both of which are documents and neither of which a port could
 * have replaced.
 *
 * <p>That same missing request body is what decides how a share is answered. A
 * POST navigation only reaches here when the site's service worker did not
 * claim it — a worker that did would have taken it long before — so arriving
 * here at all is proof there is nobody to hand it to, and it is answered with
 * a page saying so rather than with the site's own index.
 *
 * Nothing outside this process can reach any of it. Interception is not a
 * socket: a request only arrives here because a WebView of ours made it.
 */
final class NsiteRequests {

    private static final String TAG = "NsiteRequests";

    /** The page the push service loads to reach a site's service worker. */
    static final String WAKE_PATH = "/.napp/wake";

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

    /** Placeholder in the shim source for whether bytes may cross as bytes. */
    private static final String BINARY_PLACEHOLDER = "%%NAPP_BINARY%%";

    /** Placeholder in the port script for the object a window talks through. */
    private static final String HOST_OBJECT_PLACEHOLDER = "%%NAPP_HOST_OBJECT%%";

    /** Placeholder in the share page for the form it is to build. */
    private static final String SHARE_PLAN_PLACEHOLDER = "%%TENNA_SHARE_PLAN%%";

    @Nullable private static String wakePage;
    @Nullable private static String sharePage;
    @Nullable private static String shim;
    @Nullable private static String portScript;
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
    static WebResourceResponse serve(
        @NonNull Context context,
        @NonNull WebResourceRequest request
    ) {
        Uri url = request.getUrl();
        if (!"https".equalsIgnoreCase(url.getScheme())) return null;

        String host = url.getHost();

        String siteId = NsiteOrigins.siteIdFor(host);
        if (siteId == null) return null;

        String path = url.getPath();

        // A window collecting a napp.fetch it staged over the bridge. The
        // ticket is the proof on its own: unguessable, one-shot, and minted
        // against this site. A worker never comes here — it has a port, and
        // makes the whole request over that. See NappFetch.
        if (NappFetch.PATH.equals(path)) {
            if (query(url, NappFetch.TICKET_PARAM) == null) {
                Log.i(TAG, "Refused a ticketless " + path + " for " + siteId);
                return NsiteFileServer.Response.empty(403, "Forbidden").toWebResource();
            }
            return NappFetch.serve(siteId, url);
        }

        // A worker ringing for a port, which is the one thing it cannot ask
        // for over one. Bodiless, and answered with nothing: what it sets in
        // motion is a document being told to carry a port across. See NappPort.
        if (NappPort.PATH.equals(path)) {
            boolean anyone = NappPort.wanted(siteId);
            if (!anyone) Log.i(TAG, "No window to get " + siteId + "'s worker a port");
            return NsiteFileServer.Response
                .empty(anyone ? 204 : 404, anyone ? "No Content" : "Not Found")
                .toWebResource();
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
     * for it as a worker script — see {@link NappTokens}. What the token proves
     * is now one thing rather than every call: that the port a document carried
     * over really reached the worker. See {@link NappPort}.
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

    /**
     * The script every window at a site's origin runs first, which exists to
     * carry a port across to the site's worker.
     *
     * <p>Not the site's business and not the page's: a {@code MessagePort}
     * arrives at a frame, and a frame is the only thing that can transfer one
     * into a worker. See {@code napp_port.js}.
     */
    @Nullable
    static synchronized String portScript(@NonNull Context context, @NonNull String hostObject) {
        load(context);
        if (portScript == null) return null;
        return portScript.replace(HOST_OBJECT_PLACEHOLDER, JSONObject.quote(hostObject));
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
        portScript = readRaw(context, R.raw.napp_port);

        String source = readRaw(context, R.raw.napp_sw_shim);
        shim = source == null || wakePage == null
            ? null
            // A JS string literal; org.json's quoting is also valid JS, and
            // escapes the `</` that would otherwise end an inline script.
            : source.replace(WAKE_PAGE_PLACEHOLDER, JSONObject.quote(wakePage))
                // Whether this WebView will carry an array buffer on a message.
                // A fact about what happens to be installed rather than about
                // the site, so the shim leaves a hole for it as it does for the
                // token. See NappPort.
                .replace(BINARY_PLACEHOLDER, NappPort.isBinary() ? "true" : "false");
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
