package pub.soapbox.tenna;

import android.content.Context;
import android.content.res.Resources;
import android.net.Uri;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The HTTP server every nsite is served from, on the loopback interface.
 *
 * Sites used to be answered from {@code shouldInterceptRequest}. That works
 * for a page and fails for its service worker: the fetch of a worker's own
 * script reaches neither the page's client nor the profile-wide one on the
 * WebViews this app has been run on, so no nsite could register a worker at
 * all — and a worker is what a push notification is delivered to. A real
 * socket has no such gap. Chromium resolves any {@code *.localhost} name to
 * loopback without asking DNS and treats the origin as secure, so
 * {@code http://<site>.nsite.localhost:<port>} gives a site a secure context,
 * a service worker, and files that arrive however they were asked for.
 *
 * The port is fixed, because the port is part of the origin and the origin is
 * where a site's storage lives. Only if it is taken is another used.
 *
 * Anything on the device can connect to loopback, so the one path that does
 * something — {@value #NOTIFICATION_PATH}, where a worker sends a
 * notification — requires a token that only the shim appended to a worker
 * script is told. Everything else served here is public content anyway.
 */
final class NsiteHttpServer {

    private static final String TAG = "NsiteHttpServer";

    /** The nsite kind number, for no better reason than that it is memorable. */
    static final int PREFERRED_PORT = 35128;

    /** Reserved under every site's origin; the shim posts to it to show a notification. */
    static final String NOTIFICATION_PATH = "/.napp/notification";

    /**
     * Reserved under every site's origin; the page the push service loads to
     * reach the site's worker. Served here for a site whose worker has no
     * fetch handler, and by the shim for one that does.
     */
    static final String WAKE_PATH = "/.napp/wake";

    /** Header carrying the token on a request to {@link #NOTIFICATION_PATH}. */
    private static final String TOKEN_HEADER = "x-napp-token";

    /** Header the browser sets on the fetch of a worker script, and on nothing else. */
    private static final String SERVICE_WORKER_HEADER = "service-worker";

    /** Placeholders in the shim source. */
    private static final String TOKEN_PLACEHOLDER = "%%NAPP_TOKEN%%";
    private static final String WAKE_PAGE_PLACEHOLDER = "%%NAPP_WAKE_PAGE%%";

    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final int MAX_BODY_BYTES = 256 * 1024;
    private static final int IDLE_TIMEOUT_MS = 20_000;

    @Nullable private static NsiteHttpServer instance;

    private final Context context;
    private final ServerSocket socket;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    @Nullable private final String shim;
    @Nullable private final String wakePage;
    private final String token;

    private NsiteHttpServer(Context context, ServerSocket socket) {
        this.context = context;
        this.socket = socket;
        this.token = loadToken(context);
        this.wakePage = readRaw(context, R.raw.napp_wake);
        String source = readRaw(context, R.raw.napp_sw_shim);
        this.shim = source == null || wakePage == null
            ? null
            : source
                .replace(TOKEN_PLACEHOLDER, token)
                // A JS string literal; org.json's quoting is also valid JS,
                // and escapes the `</` that would end an inline script.
                .replace(WAKE_PAGE_PLACEHOLDER, JSONObject.quote(wakePage));
    }

    /** Start the server if it isn't running. Safe to call from anywhere, any number of times. */
    static synchronized void start(@NonNull Context context) {
        if (instance != null) return;

        Context app = context.getApplicationContext();
        ServerSocket socket = bind();
        if (socket == null) {
            Log.e(TAG, "Could not bind a loopback port; nsites cannot be served");
            return;
        }

        NsiteHttpServer server = new NsiteHttpServer(app, socket);
        instance = server;

        Thread acceptor = new Thread(server::acceptLoop, "nsite-http");
        acceptor.setDaemon(true);
        acceptor.start();

        Log.i(TAG, "Serving nsites on 127.0.0.1:" + socket.getLocalPort());
    }

    /** The port sites are served on, or 0 if the server could not start. */
    static synchronized int port() {
        return instance == null ? 0 : instance.socket.getLocalPort();
    }

    @Nullable
    private static ServerSocket bind() {
        InetAddress loopback = InetAddress.getLoopbackAddress();
        int[] candidates = { PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2, 0 };
        for (int port : candidates) {
            try {
                return new ServerSocket(port, 64, loopback);
            } catch (IOException e) {
                Log.w(TAG, "Port " + port + " unavailable: " + e.getMessage());
            }
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // Connections
    // -----------------------------------------------------------------------

    private void acceptLoop() {
        while (!socket.isClosed()) {
            try {
                Socket client = socket.accept();
                workers.execute(() -> handle(client));
            } catch (IOException e) {
                if (!socket.isClosed()) Log.w(TAG, "accept failed", e);
            }
        }
    }

    private void handle(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(IDLE_TIMEOUT_MS);
            c.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(c.getInputStream(), 16 * 1024);
            OutputStream out = new BufferedOutputStream(c.getOutputStream(), 64 * 1024);

            while (true) {
                Request request = Request.read(in);
                if (request == null) return;

                NsiteFileServer.Response response = respond(request);
                boolean keepAlive = request.keepAlive();
                write(out, request, response, keepAlive);
                if (!keepAlive) return;
            }
        } catch (SocketTimeoutException e) {
            // Idle keep-alive connection; the client will open another.
        } catch (IOException e) {
            // The client went away mid-request. Nothing to tell it.
        } catch (RuntimeException e) {
            Log.w(TAG, "request failed", e);
        }
    }

    // -----------------------------------------------------------------------
    // Routing
    // -----------------------------------------------------------------------

    @NonNull
    private NsiteFileServer.Response respond(Request request) {
        if (!"GET".equals(request.method) && !"HEAD".equals(request.method) && !"POST".equals(request.method)) {
            return NsiteFileServer.Response.empty(405, "Method Not Allowed");
        }

        String host = request.host();
        String siteId = NsiteOrigins.siteIdFor(host);
        if (siteId == null) return NsiteFileServer.Response.empty(404, "Not Found");

        Uri uri = Uri.parse("http://" + host + request.target);

        if (NOTIFICATION_PATH.equals(uri.getPath())) {
            return notification(siteId, request);
        }

        if ("POST".equals(request.method)) {
            return NsiteFileServer.Response.empty(405, "Method Not Allowed");
        }

        if (WAKE_PATH.equals(uri.getPath())) {
            if (wakePage == null) return NsiteFileServer.Response.empty(404, "Not Found");
            byte[] bytes = wakePage.getBytes(StandardCharsets.UTF_8);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new NsiteFileServer.Response(200, "OK", "text/html", "UTF-8", headers, new ByteArrayInputStream(bytes), bytes.length);
        }

        NsiteFileServer server = NsiteFileServers.resolve(context, host);
        if (server == null) return NsiteFileServer.Response.empty(404, "Not Found");

        boolean workerScript = "script".equalsIgnoreCase(request.header(SERVICE_WORKER_HEADER));
        return server.serve(uri, workerScript ? shim : null);
    }

    /** Show a notification a worker asked for, and answer the request. */
    private NsiteFileServer.Response notification(String siteId, Request request) {
        if (!"POST".equals(request.method)) return NsiteFileServer.Response.empty(405, "Method Not Allowed");
        if (!token.equals(request.header(TOKEN_HEADER))) return NsiteFileServer.Response.empty(403, "Forbidden");

        JSONObject payload;
        try {
            payload = new JSONObject(new String(request.body, StandardCharsets.UTF_8));
        } catch (JSONException e) {
            return NsiteFileServer.Response.empty(400, "Bad Request");
        }

        boolean shown = NappNotifications.show(context, siteId, payload);
        return NsiteFileServer.Response.empty(shown ? 204 : 403, shown ? "No Content" : "Forbidden");
    }

    // -----------------------------------------------------------------------
    // Wire format
    // -----------------------------------------------------------------------

    private static void write(OutputStream out, Request request, NsiteFileServer.Response response, boolean keepAlive) throws IOException {
        StringBuilder head = new StringBuilder(256);
        head.append("HTTP/1.1 ").append(response.status).append(' ').append(response.reason).append("\r\n");
        head.append("Content-Type: ").append(response.mimeType);
        if (response.charset != null) head.append("; charset=").append(response.charset);
        head.append("\r\n");
        head.append("Content-Length: ").append(response.length).append("\r\n");
        for (Map.Entry<String, String> header : response.headers.entrySet()) {
            head.append(header.getKey()).append(": ").append(header.getValue()).append("\r\n");
        }
        head.append("Connection: ").append(keepAlive ? "keep-alive" : "close").append("\r\n");
        head.append("\r\n");
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));

        try (InputStream body = response.body) {
            if (!"HEAD".equals(request.method)) {
                byte[] buffer = new byte[16 * 1024];
                long remaining = response.length;
                int read;
                while (remaining > 0 && (read = body.read(buffer, 0, (int) Math.min(buffer.length, remaining))) != -1) {
                    out.write(buffer, 0, read);
                    remaining -= read;
                }
                if (remaining > 0) {
                    // The body came up short against the length promised;
                    // the connection can't be reused after that.
                    throw new IOException("short body");
                }
            }
        }
        out.flush();
    }

    /** One parsed HTTP request. */
    private static final class Request {
        final String method;
        final String target;
        final String version;
        final Map<String, String> headers;
        final byte[] body;

        private Request(String method, String target, String version, Map<String, String> headers, byte[] body) {
            this.method = method;
            this.target = target;
            this.version = version;
            this.headers = headers;
            this.body = body;
        }

        @Nullable
        String header(String lowerCaseName) {
            return headers.get(lowerCaseName);
        }

        /** The host asked for, without its port. */
        @Nullable
        String host() {
            String value = header("host");
            if (value == null) return null;
            int colon = value.indexOf(':');
            return (colon >= 0 ? value.substring(0, colon) : value).toLowerCase(Locale.ROOT);
        }

        boolean keepAlive() {
            String connection = header("connection");
            if (connection != null) return !"close".equalsIgnoreCase(connection.trim());
            return "HTTP/1.1".equals(version);
        }

        /** Read one request, or null at a clean end of stream. */
        @Nullable
        static Request read(InputStream in) throws IOException {
            byte[] head = readHead(in);
            if (head == null) return null;

            String[] lines = new String(head, StandardCharsets.ISO_8859_1).split("\r\n");
            String[] requestLine = lines[0].split(" ");
            if (requestLine.length != 3) throw new IOException("malformed request line");

            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon <= 0) continue;
                headers.put(
                    lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT),
                    lines[i].substring(colon + 1).trim()
                );
            }

            byte[] body = new byte[0];
            String length = headers.get("content-length");
            if (length != null) {
                int size;
                try {
                    size = Integer.parseInt(length.trim());
                } catch (NumberFormatException e) {
                    throw new IOException("bad content-length");
                }
                if (size < 0 || size > MAX_BODY_BYTES) throw new IOException("body too large");
                body = new byte[size];
                int offset = 0;
                while (offset < size) {
                    int read = in.read(body, offset, size - offset);
                    if (read == -1) throw new IOException("truncated body");
                    offset += read;
                }
            }

            return new Request(requestLine[0], requestLine[1], requestLine[2], headers, body);
        }

        /** Everything up to and excluding the blank line, or null if the stream ended first. */
        @Nullable
        private static byte[] readHead(InputStream in) throws IOException {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(1024);
            int matched = 0;
            int b;
            while ((b = in.read()) != -1) {
                buffer.write(b);
                if (buffer.size() > MAX_HEADER_BYTES) throw new IOException("headers too large");
                // Match \r\n\r\n.
                if (b == (matched % 2 == 0 ? '\r' : '\n')) {
                    matched++;
                    if (matched == 4) {
                        byte[] bytes = buffer.toByteArray();
                        byte[] head = new byte[bytes.length - 4];
                        System.arraycopy(bytes, 0, head, 0, head.length);
                        return head;
                    }
                } else {
                    matched = b == '\r' ? 1 : 0;
                }
            }
            // End of stream, between requests or partway through one; either
            // way there is no request here.
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Secrets and resources
    // -----------------------------------------------------------------------

    /**
     * The token a worker must present to show a notification.
     *
     * Generated once and kept, rather than per process: it is baked into the
     * worker script the browser caches, and a script that changed on every
     * launch would be a new worker on every launch, with the install and
     * update prompts that sites attach to that.
     */
    @NonNull
    private static String loadToken(Context context) {
        File dir = new File(context.getFilesDir(), "napp");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File file = new File(dir, "token");

        try {
            if (file.exists()) {
                try (InputStream in = new FileInputStream(file)) {
                    byte[] bytes = new byte[128];
                    int read = in.read(bytes);
                    if (read >= 32) return new String(bytes, 0, read, StandardCharsets.US_ASCII).trim();
                }
            }
        } catch (IOException ignored) {
            // Fall through and mint a new one.
        }

        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        StringBuilder hex = new StringBuilder(64);
        for (byte b : random) hex.append(String.format(Locale.ROOT, "%02x", b));
        String token = hex.toString();

        try (OutputStream out = new FileOutputStream(file)) {
            out.write(token.getBytes(StandardCharsets.US_ASCII));
        } catch (IOException e) {
            Log.w(TAG, "Could not persist the notification token; workers will need reinstalling after a restart", e);
        }
        return token;
    }

    @Nullable
    private static String readRaw(Context context, int resource) {
        try (InputStream in = context.getResources().openRawResource(resource)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(4096);
            byte[] buffer = new byte[4096];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException | Resources.NotFoundException e) {
            Log.w(TAG, "Raw resource unreadable; workers will run without the push shim", e);
            return null;
        }
    }
}
