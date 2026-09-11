package pub.soapbox.tenna;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.SequenceInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Serves an nsite's files to a WebView straight from Blossom.
 *
 * This is the whole reason the Android path exists as native code. The site is
 * the WebView's top-level document, so it gets real safe-area insets — but
 * only if nothing has to round-trip its bytes through the Capacitor bridge to
 * get there. Every request is resolved here, on whichever background thread
 * {@link NsiteRequests} was called on, and answered from a content-addressed
 * disk cache or a direct HTTPS fetch.
 *
 * Blobs are named by sha256, so the cache never needs invalidating: a given
 * name always denotes the same bytes. Reopening a site costs nothing after the
 * first visit, which the iframe implementation cannot say — it re-downloads
 * the whole manifest every time.
 */
final class NsiteFileServer {

    /**
     * Told what the site's own document asks for, the first time it is served.
     *
     * Raised on the serving thread, before the renderer has been given a byte
     * of the document — early enough that the view can be laid out for the
     * site before it paints.
     */
    interface ChromeListener {
        void onSiteChrome(NsiteSiteChrome chrome);
    }

    /** What to send back: the transport-neutral shape of an HTTP response. */
    static final class Response {
        final int status;
        @NonNull final String reason;
        @NonNull final String mimeType;
        @Nullable final String charset;
        @NonNull final Map<String, String> headers;
        @NonNull final InputStream body;
        /** Exact byte length of {@link #body}; every body served here is known in advance. */
        final long length;

        Response(
            int status,
            @NonNull String reason,
            @NonNull String mimeType,
            @Nullable String charset,
            @NonNull Map<String, String> headers,
            @NonNull InputStream body,
            long length
        ) {
            this.status = status;
            this.reason = reason;
            this.mimeType = mimeType;
            this.charset = charset;
            this.headers = headers;
            this.body = body;
            this.length = length;
        }

        static Response text(int status, String reason, String text) {
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new Response(status, reason, "text/plain", "UTF-8", headers, new ByteArrayInputStream(bytes), bytes.length);
        }

        static Response empty(int status, String reason) {
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new Response(status, reason, "text/plain", "UTF-8", headers, new ByteArrayInputStream(new byte[0]), 0);
        }

        /**
         * The same response, in the shape a WebView client returns.
         *
         * The length is stated as a header rather than dropped: without it a
         * service worker reading the response has no {@code Content-Length} to
         * go on, and Chromium refuses a response whose status has no reason
         * phrase, which is why every one made here carries one.
         */
        @NonNull
        WebResourceResponse toWebResource() {
            Map<String, String> all = new HashMap<>(headers);
            all.put("Content-Length", Long.toString(length));
            return new WebResourceResponse(mimeType, charset, status, reason, all, body);
        }
    }

    /** Manifest path (e.g. {@code /index.html}) to sha256. */
    private final Map<String, String> files;
    private final List<String> servers;
    private final File cacheDir;
    /** Null for a server with no view to lay out — one serving a worker. */
    @Nullable private final ChromeListener chromeListener;

    /** The document is served again on every SPA route; sniff it once. */
    private volatile boolean chromeReported;

    /**
     * The last server that successfully served a blob, tried first next time.
     * Mirrors the same optimisation in {@code src/lib/nsiteFiles.ts}: most
     * servers in a site's list don't hold most of its blobs, so without this
     * every request pays for a run of 404s.
     */
    private volatile String preferredServer;

    NsiteFileServer(
        Map<String, String> files,
        List<String> servers,
        File cacheDir,
        @Nullable ChromeListener chromeListener
    ) {
        this.files = files;
        this.servers = servers;
        this.cacheDir = cacheDir;
        this.chromeListener = chromeListener;
        //noinspection ResultOfMethodCallIgnored
        cacheDir.mkdirs();
    }

    /** A server for a parsed manifest, with nothing to lay out. */
    static NsiteFileServer forManifest(@NonNull Context context, @NonNull NsiteManifest manifest) {
        return new NsiteFileServer(manifest.files, manifest.servers, cacheDir(context), null);
    }

    /**
     * The one blob cache every server shares: blobs are named by content.
     *
     * Versioned in the name because the guarantee changed rather than the
     * layout. Everything in the old directory was written by a build that
     * cached whatever a server answered with, under the name that had been
     * asked for — so a device upgrading into this one cannot be allowed to go
     * on reading it. A new directory is the cheapest way to say that, and what
     * it costs is one re-download of the sites the user actually opens.
     */
    static File cacheDir(@NonNull Context context) {
        return new File(context.getCacheDir(), "nsite-v2");
    }

    /**
     * Resolve a request, appending {@code scriptSuffix} to the file if it is
     * a script the manifest names outright.
     *
     * A worker script is the one file the host has to add to: the site's own
     * bytes, then the push shim after them. The suffix is withheld from the
     * SPA fallback — a request for a script that isn't there gets the site's
     * document, and a document is not a script to be extended.
     */
    @NonNull
    Response serve(@NonNull Uri uri, @Nullable String scriptSuffix) {
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
        if (sha256 == null) return Response.text(404, "Not Found", "Not Found");

        File blob;
        try {
            blob = blob(sha256);
        } catch (IOException e) {
            return Response.text(502, "Bad Gateway", "Failed to fetch " + sha256);
        }

        String mimeType = NsiteMimeTypes.of(servingPath);
        Map<String, String> headers = new HashMap<>();
        // The blob itself is immutable, but the path it answers to isn't:
        // /index.html means something different after the site publishes
        // again. Our own sha256 cache is the one that's safe to keep.
        headers.put("Cache-Control", "no-cache");

        try {
            InputStream body;
            long length;
            if ("/index.html".equals(servingPath)) {
                byte[] document = document(blob);
                body = new ByteArrayInputStream(document);
                length = document.length;
            } else if (scriptSuffix != null && servingPath.equals(path) && NsiteMimeTypes.isScript(mimeType)) {
                byte[] suffix = ("\n" + scriptSuffix).getBytes(StandardCharsets.UTF_8);
                body = new SequenceInputStream(new FileInputStream(blob), new ByteArrayInputStream(suffix));
                length = blob.length() + suffix.length;
            } else {
                body = new FileInputStream(blob);
                length = blob.length();
            }

            return new Response(
                200,
                "OK",
                mimeType,
                NsiteMimeTypes.encodingFor(mimeType),
                headers,
                body,
                length
            );
        } catch (IOException e) {
            return Response.text(500, "Internal Error", "Unreadable blob");
        }
    }

    /**
     * Read the site's document into memory so it can be sniffed on the way out.
     *
     * Its meta tags decide how the WebView is laid out, and that has to be
     * settled before the renderer paints — so the document is read here rather
     * than asked for afterwards with {@code evaluateJavascript}, which would
     * arrive a frame late and show the site jumping into place.
     */
    private byte[] document(File blob) throws IOException {
        byte[] bytes = readFully(blob);

        if (!chromeReported && chromeListener != null) {
            chromeReported = true;
            chromeListener.onSiteChrome(
                NsiteSiteChrome.read(new String(bytes, StandardCharsets.UTF_8))
            );
        }

        return bytes;
    }

    private static byte[] readFully(File file) throws IOException {
        try (InputStream in = new FileInputStream(file);
             ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length())) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }

    // -----------------------------------------------------------------------
    // Blob retrieval
    // -----------------------------------------------------------------------

    /** The cached blob for a sha256, downloading it first if necessary. */
    private File blob(String sha256) throws IOException {
        // The manifest was filtered on the way in, on both sides of the
        // bridge, but this is the line that turns the string into a path and
        // so it is the line that has to be sure. See NsiteBlobs.
        if (!NsiteBlobs.isName(sha256)) throw new IOException("Not a blob name: " + sha256);

        File cached = new File(cacheDir, sha256);
        if (!cached.getCanonicalFile().getParentFile().equals(cacheDir.getCanonicalFile())) {
            throw new IOException("Blob would not be in the cache: " + sha256);
        }
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
     * Download a blob to a temp file, check it is the blob that was asked for,
     * and move it into place.
     *
     * Downloading whole rather than streaming through to the WebView keeps a
     * failed or truncated transfer from being cached, and from being handed to
     * the renderer as a short file. Web assets are small; the cost is one
     * extra write of bytes that were going to disk anyway.
     *
     * **The bytes are hashed as they are written.** A Blossom server is named
     * by a {@code server} tag on the manifest, which is the publisher's choice
     * and not the reader's, so the content address is the only thing that makes
     * a mirror untrusted infrastructure rather than a host. It matters more
     * here than on the web, because {@link #cacheDir} is shared by every site
     * in the app and a blob is cached under the name that was *requested*: an
     * unverified answer would let one site's chosen server poison a file
     * another site is made of, and hand it script at that site's origin with
     * that site's stored permissions. A server that fails is treated as one
     * that did not have the blob, and the next is tried.
     */
    private File download(String server, String sha256, File destination) throws IOException {
        String base = server.replaceAll("/+$", "");
        URLConnection opened = new URL(base + "/" + sha256).openConnection();
        if (!(opened instanceof HttpURLConnection)) {
            throw new IOException("Not an HTTP server: " + base);
        }
        HttpURLConnection connection = (HttpURLConnection) opened;
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setInstanceFollowRedirects(true);

        try {
            int status = connection.getResponseCode();
            if (status < 200 || status > 299) {
                throw new IOException("HTTP " + status + " from " + base);
            }

            MessageDigest digest;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IOException("No SHA-256 on this device", e);
            }

            File temp = File.createTempFile("nsite", null, cacheDir);
            try (InputStream in = connection.getInputStream();
                 OutputStream out = new FileOutputStream(temp)) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    digest.update(buffer, 0, read);
                    out.write(buffer, 0, read);
                }
            } catch (IOException e) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                throw e;
            }

            String served = NsiteBlobs.hex(digest.digest());
            if (!served.equals(sha256)) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                throw new IOException(base + " served " + served + ", not " + sha256);
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
}
