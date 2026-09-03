package pub.soapbox.tenna;

import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Serves an nsite's files to a WebView straight from Blossom.
 *
 * This is the whole reason the Android path exists as native code. The site is
 * the WebView's top-level document, so it gets real safe-area insets — but
 * only if nothing has to round-trip its bytes through the Capacitor bridge to
 * get there. Every request is resolved here, on the background thread
 * {@code shouldInterceptRequest} already runs on, and answered from a
 * content-addressed disk cache or a direct HTTPS fetch.
 *
 * Blobs are named by sha256, so the cache never needs invalidating: a given
 * name always denotes the same bytes. Reopening a site costs nothing after the
 * first visit, which the iframe implementation cannot say — it re-downloads
 * the whole manifest every time.
 */
final class NsiteFileServer {

    /** Manifest path (e.g. {@code /index.html}) to sha256. */
    private final Map<String, String> files;
    private final List<String> servers;
    private final File cacheDir;

    /**
     * The last server that successfully served a blob, tried first next time.
     * Mirrors the same optimisation in {@code src/lib/nsiteFiles.ts}: most
     * servers in a site's list don't hold most of its blobs, so without this
     * every request pays for a run of 404s.
     */
    private volatile String preferredServer;

    NsiteFileServer(Map<String, String> files, List<String> servers, File cacheDir) {
        this.files = files;
        this.servers = servers;
        this.cacheDir = cacheDir;
        //noinspection ResultOfMethodCallIgnored
        cacheDir.mkdirs();
    }

    /**
     * Resolve a request, or return null to let it go to the network.
     *
     * Requests for anything but our own origin are somebody else's business —
     * an nsite fetching a relay, an avatar, a Blossom blob of its own.
     */
    WebResourceResponse serve(String expectedHost, Uri uri) {
        if (!expectedHost.equalsIgnoreCase(uri.getHost())) return null;

        String path = uri.getPath();
        if (path == null || path.isEmpty()) path = "/";
        if (path.endsWith("/")) path = path + "index.html";

        String sha256 = files.get(path);
        String servingPath = path;

        // Fall back to /index.html for SPA client-side routes.
        if (sha256 == null) {
            sha256 = files.get("/index.html");
            servingPath = "/index.html";
        }
        if (sha256 == null) return textResponse(404, "Not Found", "Not Found");

        File blob;
        try {
            blob = blob(sha256);
        } catch (IOException e) {
            return textResponse(502, "Bad Gateway", "Failed to fetch " + sha256);
        }

        String mimeType = NsiteMimeTypes.of(servingPath);
        Map<String, String> headers = new HashMap<>();
        // The blob itself is immutable, but the path it answers to isn't:
        // /index.html means something different after the site publishes
        // again. Our own sha256 cache is the one that's safe to keep.
        headers.put("Cache-Control", "no-cache");

        try {
            return new WebResourceResponse(
                mimeType,
                NsiteMimeTypes.encodingFor(mimeType),
                200,
                "OK",
                headers,
                new FileInputStream(blob)
            );
        } catch (IOException e) {
            return textResponse(500, "Internal Error", "Unreadable blob");
        }
    }

    // -----------------------------------------------------------------------
    // Blob retrieval
    // -----------------------------------------------------------------------

    /** The cached blob for a sha256, downloading it first if necessary. */
    private File blob(String sha256) throws IOException {
        File cached = new File(cacheDir, sha256);
        if (cached.exists() && cached.length() > 0) return cached;

        IOException lastError = null;

        String preferred = preferredServer;
        if (preferred != null && servers.contains(preferred)) {
            try {
                return download(preferred, sha256, cached);
            } catch (IOException e) {
                lastError = e;
            }
        }

        for (String server : servers) {
            if (server.equals(preferred)) continue;
            try {
                return download(server, sha256, cached);
            } catch (IOException e) {
                lastError = e;
            }
        }

        throw lastError != null
            ? lastError
            : new IOException("No Blossom server served " + sha256);
    }

    /**
     * Download a blob to a temp file and move it into place.
     *
     * Downloading whole rather than streaming through to the WebView keeps a
     * failed or truncated transfer from being cached, and from being handed to
     * the renderer as a short file. Web assets are small; the cost is one
     * extra write of bytes that were going to disk anyway.
     */
    private File download(String server, String sha256, File destination) throws IOException {
        String base = server.replaceAll("/+$", "");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + "/" + sha256).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);

        try {
            int status = connection.getResponseCode();
            if (status < 200 || status > 299) {
                throw new IOException("HTTP " + status + " from " + base);
            }

            File temp = File.createTempFile("nsite", null, cacheDir);
            try (InputStream in = connection.getInputStream();
                 OutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                throw e;
            }

            if (!temp.renameTo(destination)) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                // Another request for the same blob may have won the race,
                // which is fine — the content is identical either way.
                if (!destination.exists()) throw new IOException("Could not cache " + sha256);
            }

            preferredServer = server;
            return destination;
        } finally {
            connection.disconnect();
        }
    }

    // -----------------------------------------------------------------------

    private static WebResourceResponse textResponse(int status, String reason, String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            status,
            reason,
            headers,
            new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8))
        );
    }
}
