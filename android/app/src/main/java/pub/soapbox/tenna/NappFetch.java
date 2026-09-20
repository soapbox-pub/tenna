package pub.soapbox.tenna;

import android.net.Uri;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebResourceResponse;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.Call;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.ResponseBody;

/**
 * {@code napp.fetch} — an HTTP request made on a site's behalf, without CORS.
 *
 * <p>A native app can call any HTTP API it likes. A page cannot, because the
 * browser will not let it read a cross-origin response the far end has not
 * consented to. That rule exists to protect the user's <em>ambient
 * authority</em> — the cookies a browser would attach — rather than to protect
 * the bytes, which is why lifting it is defensible here and only here: every
 * request made through this class is anonymous. There is no cookie jar, no
 * {@code Origin}, no {@code Referer}, and no way for a site to add them. See
 * {@link NappFetchPolicy}, which is the whole of what stands between a site
 * and the network.
 *
 * <h2>Two legs, because a worker has no bridge</h2>
 *
 * <p>The awkwardness in here is all one fact: {@code shouldInterceptRequest}
 * is never given a request body. So a request cannot simply be made as itself
 * and intercepted — the body would be lost on the way — and the request has to
 * arrive by some other road while the <em>response</em> comes back through
 * interception, which streams and carries headers and gives the site a real
 * {@code Response} object rather than an imitation of one.
 *
 * <ul>
 *   <li><b>A window</b> stages its request over the message channel its
 *       {@code window.nostr} already uses, the body crossing as an array
 *       buffer, and is handed a <b>ticket</b>. It then fetches
 *       {@code /.napp/fetch?t=…}, which is answered here. The ticket is the
 *       proof: unguessable, one-shot, minted against one site, and expiring in
 *       {@value NappFetchPolicy#TICKET_TTL_MS} milliseconds.
 *   <li><b>A worker</b> has no channel — the interesting case is the one with
 *       no window open at all — so its whole request, body included, is the
 *       URL, authenticated with the site token baked into its shim exactly as
 *       {@link NsiteWorkerSigner} is. A URL is not a body, so that leg is
 *       capped at {@value NappFetchPolicy#MAX_WORKER_BODY_BYTES} bytes.
 * </ul>
 *
 * <p>One API, two ceilings. The alternative was a loopback socket every other
 * app on the device could also reach, to spare a worker a size limit it will
 * almost never meet.
 *
 * <h2>Why the interception thread is only held for headers</h2>
 *
 * <p>{@link NsiteWorkerSigner} explains at length why blocking in
 * {@code shouldInterceptRequest} is a hazard: it runs on a thread Chromium
 * owns and shares with every service worker in the process. The request here
 * is therefore started when it is <em>staged</em>, not when it is collected,
 * and the collection blocks only until the response headers are in — capped at
 * {@value NappFetchPolicy#HEADERS_TIMEOUT_MS} milliseconds. The body is handed
 * over as a stream that Chromium drains on its own schedule, so a slow
 * download holds nothing at all.
 */
final class NappFetch {

    private static final String TAG = "NappFetch";

    /** Where a staged or self-describing request is collected. */
    static final String PATH = "/.napp/fetch";

    /** Query parameter naming a request staged over the message channel. */
    static final String TICKET_PARAM = "t";

    /** Query parameter carrying a whole request as base64url JSON. */
    static final String REQUEST_PARAM = "r";

    /**
     * Header set when the failure is Tenna's answer rather than a server's.
     *
     * <p>A refused address, a DNS failure, a timeout: things a real
     * {@code fetch} reports by rejecting with a {@code TypeError} rather than
     * by resolving with a response. The shim looks for this and rejects, so
     * that a site sees what it would see in a browser. An upstream 502 carries
     * no such header and is passed through as the answer it is.
     */
    static final String ERROR_HEADER = "X-Napp-Error";

    /**
     * Where the request ended up, after redirects.
     *
     * <p>{@code Response.url} cannot be set from script and will read as the
     * local collection path, so the honest answer is given as a header
     * instead. Documented in NAPP.md as the one thing this cannot make true.
     */
    static final String FINAL_URL_HEADER = "X-Napp-Final-Url";

    private NappFetch() {}

    // ── The client ───────────────────────────────────────────────────────────

    /**
     * One client for every site.
     *
     * <p>Redirects are followed by hand rather than by OkHttp, because each
     * hop has to be put back through {@link NappFetchPolicy#refuseUrl} — a
     * server that is allowed to answer is not thereby allowed to point
     * somewhere that is not.
     *
     * <p>No {@code cookieJar} is set, which in OkHttp means
     * {@code CookieJar.NO_COOKIES}: nothing is stored and nothing is sent.
     * That is the property the whole design rests on.
     */
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .dns(new GuardedDns())
        .build();

    /**
     * The resolver, and the place the network policy is actually enforced.
     *
     * <p>Filtering hostnames catches nothing on its own. Any name under the
     * site's control can be given an {@code A} record of {@code 127.0.0.1} or
     * {@code 192.168.1.1} — an ordinary DNS record, costing nothing, and the
     * standard way a page reaches something it has no business reaching. What
     * closes it is refusing the <em>address</em>, and doing it here means
     * OkHttp can only connect to addresses that have already been judged: the
     * list this returns is the list it tries.
     */
    private static final class GuardedDns implements Dns {
        @NonNull
        @Override
        public List<InetAddress> lookup(@NonNull String hostname) throws UnknownHostException {
            List<InetAddress> resolved = Dns.SYSTEM.lookup(hostname);
            List<InetAddress> allowed = new ArrayList<>(resolved.size());

            for (InetAddress address : resolved) {
                if (NappFetchPolicy.refuseAddress(address) == null) allowed.add(address);
            }

            if (allowed.isEmpty()) {
                // Deliberately the same wording whatever the reason. A site
                // that could tell "no such host" from "that one is on your
                // network" would have a port scanner.
                throw new UnknownHostException("That host is not reachable");
            }

            return allowed;
        }
    }

    private static final ExecutorService WORKERS = Executors.newCachedThreadPool(r -> {
        Thread thread = new Thread(r, "napp-fetch");
        thread.setDaemon(true);
        return thread;
    });

    // ── A request in flight ──────────────────────────────────────────────────

    /** Everything a site asked for, parsed and checked. */
    private static final class Plan {
        @NonNull final String url;
        @NonNull final String method;
        /** Name/value pairs, in order, duplicates kept. */
        @NonNull final List<String[]> headers;
        /** {@code follow}, {@code error} or {@code manual}. */
        @NonNull final String redirect;
        final boolean hasBody;

        Plan(
            @NonNull String url,
            @NonNull String method,
            @NonNull List<String[]> headers,
            @NonNull String redirect,
            boolean hasBody
        ) {
            this.url = url;
            this.method = method;
            this.headers = headers;
            this.redirect = redirect;
            this.hasBody = hasBody;
        }
    }

    /**
     * One request, from staging to the last byte read off it.
     *
     * <p>Held in {@link #staged} only between being minted and being
     * collected. Afterwards the response stream owns it, and dropping the last
     * reference to the stream is what releases the connection and the site's
     * place in the in-flight count.
     */
    private static final class Ticket {
        @NonNull final String id;
        @NonNull final String siteId;
        @NonNull final Plan plan;
        final long expiresAt;

        final CountDownLatch ready = new CountDownLatch(1);
        /** Guards the accounting in {@link #release}, which has several callers. */
        final AtomicBoolean released = new AtomicBoolean();

        @Nullable volatile byte[] body;
        volatile boolean started;
        volatile boolean aborted;
        @Nullable volatile Call call;
        @Nullable volatile okhttp3.Response response;
        @Nullable volatile String error;

        Ticket(@NonNull String id, @NonNull String siteId, @NonNull Plan plan) {
            this.id = id;
            this.siteId = siteId;
            this.plan = plan;
            this.expiresAt = System.currentTimeMillis() + NappFetchPolicy.TICKET_TTL_MS;
        }
    }

    private static final Map<String, Ticket> staged = new HashMap<>();

    /** How many requests each site has in flight, for the per-site ceiling. */
    private static final Map<String, Integer> inFlight = new HashMap<>();

    /** Raised for anything a site is told about rather than a failure to relay. */
    static final class Refused extends Exception {
        Refused(@NonNull String reason) {
            super(reason);
        }
    }

    // ── Staging, for a window ────────────────────────────────────────────────

    /**
     * Take a request from a site's window and hand back a ticket for it.
     *
     * <p>The request starts now unless a body is still coming, in which case
     * {@link #body} starts it. By the time the site's collecting fetch arrives
     * the headers are usually already in, which is the point.
     */
    @NonNull
    static String stage(@NonNull String siteId, @NonNull JSONObject request) throws Refused {
        Plan plan = planFrom(request);

        Ticket ticket = new Ticket(UUID.randomUUID().toString(), siteId, plan);

        synchronized (staged) {
            sweep();

            int running = count(siteId);
            if (running >= NappFetchPolicy.MAX_IN_FLIGHT_PER_SITE) {
                throw new Refused("Too many requests in flight");
            }
            inFlight.put(siteId, running + 1);
            staged.put(ticket.id, ticket);
        }

        if (!plan.hasBody) start(ticket);
        return ticket.id;
    }

    /**
     * Attach the body a window said was coming, and start the request.
     *
     * <p>Silently does nothing for a ticket that has gone — expired, aborted,
     * or never existed. A site cannot learn anything from the difference and
     * the collecting fetch will fail on its own.
     */
    static void body(@Nullable String ticketId, @Nullable byte[] bytes) {
        Ticket ticket;
        synchronized (staged) {
            ticket = ticketId == null ? null : staged.get(ticketId);
        }
        if (ticket == null || ticket.started) return;

        if (bytes != null && bytes.length > NappFetchPolicy.MAX_WINDOW_BODY_BYTES) {
            fail(ticket, "Request body is too large");
            return;
        }

        ticket.body = bytes;
        start(ticket);
    }

    /** Give up on a staged request, because the site's {@code AbortSignal} fired. */
    static void abort(@Nullable String ticketId) {
        Ticket ticket;
        synchronized (staged) {
            ticket = ticketId == null ? null : staged.remove(ticketId);
        }
        // Already collected, or never existed. A collected one is being read
        // through its own stream, and aborting the site's fetch closes that.
        if (ticket == null) return;

        ticket.error = "Aborted";
        drop(ticket);
        release(ticket);
    }

    // ── Collecting ───────────────────────────────────────────────────────────

    /**
     * Answer a site's collecting fetch, by either road.
     *
     * <p>The caller has already established that this is the named site: a
     * ticket is minted against one site and checked against it here, and the
     * self-describing form is gated on the site token before it ever reaches
     * this method. See {@link NsiteRequests}.
     */
    @NonNull
    static WebResourceResponse serve(@NonNull String siteId, @NonNull Uri url) {
        String ticketId = query(url, TICKET_PARAM);

        if (ticketId != null) {
            Ticket ticket;
            synchronized (staged) {
                sweep();
                ticket = staged.get(ticketId);
                // One shot. A ticket is a capability, and one that could be
                // replayed would outlive the request it was minted for.
                if (ticket != null) staged.remove(ticketId);
            }

            if (ticket == null || !ticket.siteId.equals(siteId)) {
                return error("No such request");
            }
            return collect(ticket);
        }

        String encoded = query(url, REQUEST_PARAM);
        if (encoded == null) return error("No request");

        return serveInline(siteId, encoded);
    }

    /**
     * A worker's request, which arrived whole.
     *
     * <p>Started and collected in one go on the calling thread, which is
     * already a background one. It blocks for as long as the headers take and
     * no longer — see the note on the class.
     */
    @NonNull
    private static WebResourceResponse serveInline(@NonNull String siteId, @NonNull String encoded) {
        JSONObject request;
        try {
            byte[] json = Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            request = new JSONObject(new String(json, StandardCharsets.UTF_8));
        } catch (IllegalArgumentException | JSONException e) {
            return error("Malformed request");
        }

        Plan plan;
        byte[] body = null;
        try {
            plan = planFrom(request);

            String encodedBody = request.optString("body", null);
            if (encodedBody != null && !encodedBody.isEmpty()) {
                body = Base64.decode(encodedBody, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
                if (body.length > NappFetchPolicy.MAX_WORKER_BODY_BYTES) {
                    return error("Request body is too large for a worker");
                }
            }
        } catch (Refused e) {
            return error(e.getMessage());
        } catch (IllegalArgumentException e) {
            return error("Malformed request body");
        }

        Ticket ticket = new Ticket(UUID.randomUUID().toString(), siteId, plan);
        ticket.body = body;

        synchronized (staged) {
            sweep();
            int running = count(siteId);
            if (running >= NappFetchPolicy.MAX_IN_FLIGHT_PER_SITE) {
                return error("Too many requests in flight");
            }
            inFlight.put(siteId, running + 1);
        }

        start(ticket);
        return collect(ticket);
    }

    /** Wait for the headers and turn them into something Chromium will serve. */
    @NonNull
    private static WebResourceResponse collect(@NonNull Ticket ticket) {
        try {
            if (!ticket.ready.await(NappFetchPolicy.HEADERS_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                drop(ticket);
                release(ticket);
                return error("Timed out");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            drop(ticket);
            release(ticket);
            return error("Interrupted");
        }

        okhttp3.Response response = ticket.response;
        if (response == null) {
            release(ticket);
            return error(ticket.error == null ? "Request failed" : ticket.error);
        }

        return respond(ticket, response);
    }

    /** Build the response the site will see, and hand it the body as a stream. */
    @NonNull
    private static WebResourceResponse respond(
        @NonNull Ticket ticket,
        @NonNull okhttp3.Response response
    ) {
        int status = response.code();
        if (!NappFetchPolicy.isServableStatus(status)) {
            close(response);
            release(ticket);
            return error("Unserveable status " + status);
        }

        Map<String, String> headers = new HashMap<>();
        Set<String> names = response.headers().names();
        for (String name : names) {
            if (NappFetchPolicy.isStrippedResponseHeader(name)) continue;
            List<String> values = response.headers().values(name);
            if (values.isEmpty()) continue;
            // WebResourceResponse takes one value per name. Everything a site
            // reads off a Response gets them comma-joined anyway, which is
            // what the Fetch standard says a combined field value is.
            headers.put(name, join(values));
        }

        headers.put("Cache-Control", "no-store");
        headers.put(FINAL_URL_HEADER, response.request().url().toString());

        String mime = "application/octet-stream";
        String charset = null;
        MediaType type = response.body() == null ? null : response.body().contentType();
        if (type != null) {
            mime = type.type() + "/" + type.subtype();
            charset = type.charset() == null ? null : type.charset().name();
        }

        // A 304 relayed with the body that came with it is a contradiction
        // Chromium rejects and the site never asked for.
        ResponseBody source = NappFetchPolicy.isBodilessStatus(status) ? null : response.body();

        InputStream body;
        if (source == null) {
            close(response);
            release(ticket);
            body = new ByteArrayInputStream(new byte[0]);
        } else {
            // From here the stream owns the response, and closing it is what
            // releases the connection and the site's place in the queue.
            body = new Metered(source.byteStream(), ticket, response);
        }

        return new WebResourceResponse(
            mime,
            charset,
            status,
            NappFetchPolicy.reasonFor(status, response.message()),
            headers,
            body
        );
    }

    /**
     * The response body, with a ceiling on it and the bookkeeping attached.
     *
     * <p>Closing this is what ends the request: it releases the connection and
     * gives the site back its place in the in-flight count. Chromium closes it
     * whether it read to the end or gave up, so this is the one reliable
     * moment to do either.
     */
    private static final class Metered extends FilterInputStream {
        private final Ticket ticket;
        private final okhttp3.Response response;
        private long read;

        Metered(@NonNull InputStream in, @NonNull Ticket ticket, @NonNull okhttp3.Response response) {
            super(in);
            this.ticket = ticket;
            this.response = response;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) count(1);
            return b;
        }

        @Override
        public int read(@NonNull byte[] buffer, int offset, int length) throws IOException {
            int n = super.read(buffer, offset, length);
            if (n > 0) count(n);
            return n;
        }

        private void count(int n) throws IOException {
            read += n;
            if (read > NappFetchPolicy.MAX_RESPONSE_BYTES) {
                throw new IOException("Response is too large");
            }
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                // Qualified, because this class has a `close` of its own.
                NappFetch.close(response);
                release(ticket);
            }
        }
    }

    // ── Running one ──────────────────────────────────────────────────────────

    private static void start(@NonNull Ticket ticket) {
        if (ticket.started) return;
        ticket.started = true;

        WORKERS.execute(() -> {
            try {
                ticket.response = execute(ticket);
            } catch (IOException | RuntimeException e) {
                ticket.error = reasonFrom(e);
            } finally {
                ticket.ready.countDown();
            }
        });
    }

    /**
     * Make the request, following redirects by hand.
     *
     * <p>Every hop is judged again from scratch. A server that is allowed to
     * answer has not thereby earned the right to send the phone somewhere
     * else, and {@code Authorization} is dropped when the host changes so that
     * a redirect cannot be used to harvest a token the site meant for one
     * server.
     */
    @NonNull
    private static okhttp3.Response execute(@NonNull Ticket ticket) throws IOException {
        String url = ticket.plan.url;
        String method = ticket.plan.method;
        byte[] body = ticket.body;
        List<String[]> headers = ticket.plan.headers;

        for (int hop = 0; hop <= NappFetchPolicy.MAX_REDIRECTS; hop++) {
            String refusal = NappFetchPolicy.refuseUrl(url);
            if (refusal != null) throw new IOException(refusal);

            if (ticket.aborted) throw new IOException("Aborted");

            Request.Builder builder = new Request.Builder().url(url);

            MediaType contentType = null;
            for (String[] header : headers) {
                if ("content-type".equals(header[0].toLowerCase(Locale.ROOT))) {
                    // Carried on the body rather than as a header, so that
                    // OkHttp does not end up framing two of them.
                    contentType = MediaType.parse(header[1]);
                    continue;
                }
                builder.addHeader(header[0], header[1]);
            }

            RequestBody payload = null;
            if (NappFetchPolicy.allowsBody(method)) {
                payload = RequestBody.create(body == null ? new byte[0] : body, contentType);
            }
            builder.method(method, payload);

            Call call = CLIENT.newCall(builder.build());
            ticket.call = call;

            okhttp3.Response response = call.execute();

            int status = response.code();
            if (!NappFetchPolicy.isRedirect(status)) return response;

            String location = response.header("Location");
            HttpUrl from = response.request().url();
            HttpUrl next = location == null ? null : from.resolve(location);
            close(response);

            if (next == null) throw new IOException("Bad redirect");

            if ("error".equals(ticket.plan.redirect)) {
                throw new IOException("Redirected");
            }

            if (NappFetchPolicy.redirectBecomesGet(status, method)) {
                method = "GET";
                body = null;
                headers = withoutEntityHeaders(headers);
            }

            if (!from.host().equalsIgnoreCase(next.host())) {
                headers = without(headers, "authorization");
            }

            url = next.toString();
        }

        throw new IOException("Too many redirects");
    }

    // ── Reading what a site asked for ────────────────────────────────────────

    /** Parse and check a request, or refuse it with a reason the site is told. */
    @NonNull
    private static Plan planFrom(@NonNull JSONObject request) throws Refused {
        String url = request.optString("url", null);
        String refusal = NappFetchPolicy.refuseUrl(url);
        if (refusal != null) throw new Refused(refusal);

        String method = NappFetchPolicy.normalizeMethod(request.optString("method", "GET"));
        if (method == null) throw new Refused("That method is not allowed");

        boolean hasBody = request.optBoolean("hasBody", false)
            || (request.optString("body", "").length() > 0);

        if (hasBody && !NappFetchPolicy.allowsBody(method)) {
            throw new Refused("A " + method + " request cannot have a body");
        }

        String redirect = request.optString("redirect", "follow");
        if (!"follow".equals(redirect) && !"error".equals(redirect) && !"manual".equals(redirect)) {
            redirect = "follow";
        }

        List<String[]> headers = new ArrayList<>();
        JSONArray given = request.optJSONArray("headers");
        for (int i = 0; given != null && i < given.length(); i++) {
            JSONArray pair = given.optJSONArray(i);
            if (pair == null || pair.length() < 2) continue;

            String name = pair.optString(0, "");
            String value = pair.optString(1, "");

            if (NappFetchPolicy.isForbiddenRequestHeader(name)) {
                throw new Refused("Cannot set the header " + name);
            }
            if (!NappFetchPolicy.isValidHeaderValue(value)) {
                throw new Refused("Bad value for the header " + name);
            }

            headers.add(new String[] { name, value });
        }

        //noinspection ConstantConditions — refuseUrl has established it is not null
        return new Plan(url, method, headers, redirect, hasBody);
    }

    private static List<String[]> without(@NonNull List<String[]> headers, @NonNull String name) {
        List<String[]> kept = new ArrayList<>(headers.size());
        for (String[] header : headers) {
            if (name.equals(header[0].toLowerCase(Locale.ROOT))) continue;
            kept.add(header);
        }
        return kept;
    }

    /** Headers that described a body there no longer is. */
    private static final Set<String> ENTITY_HEADERS =
        new HashSet<>(java.util.Arrays.asList("content-type", "content-language", "content-location"));

    private static List<String[]> withoutEntityHeaders(@NonNull List<String[]> headers) {
        List<String[]> kept = new ArrayList<>(headers.size());
        for (String[] header : headers) {
            if (ENTITY_HEADERS.contains(header[0].toLowerCase(Locale.ROOT))) continue;
            kept.add(header);
        }
        return kept;
    }

    // ── Bookkeeping ──────────────────────────────────────────────────────────

    /** Called holding {@link #staged}. */
    private static int count(@NonNull String siteId) {
        Integer running = inFlight.get(siteId);
        return running == null ? 0 : running;
    }

    /** Give a site back its place in the queue, exactly once. */
    private static void release(@NonNull Ticket ticket) {
        if (!ticket.released.compareAndSet(false, true)) return;

        synchronized (staged) {
            staged.remove(ticket.id);
            int running = count(ticket.siteId) - 1;
            if (running <= 0) inFlight.remove(ticket.siteId);
            else inFlight.put(ticket.siteId, running);
        }
    }

    /**
     * Drop tickets nobody came back for.
     *
     * <p>Lazily, on the next staging or collection, which is how
     * {@link NsiteWorkerSigner} does it too: there is no clock worth running
     * for this, and anything stale is by definition something no one is
     * waiting on. Called holding {@link #staged}.
     */
    private static void sweep() {
        long now = System.currentTimeMillis();
        List<Ticket> stale = new ArrayList<>();

        for (Ticket ticket : staged.values()) {
            if (now > ticket.expiresAt) stale.add(ticket);
        }

        for (Ticket ticket : stale) {
            staged.remove(ticket.id);
            drop(ticket);
            // Not `release`, which would take the lock this is already under.
            if (ticket.released.compareAndSet(false, true)) {
                int running = count(ticket.siteId) - 1;
                if (running <= 0) inFlight.remove(ticket.siteId);
                else inFlight.put(ticket.siteId, running);
            }
        }
    }

    /**
     * Abandon a request nobody is going to collect.
     *
     * <p>Cancelling the call is not enough on its own. A request that had
     * already <em>succeeded</em> is holding an open response — and with it a
     * socket out of the connection pool — which nothing will ever read,
     * because the only thing that would have read it was the collecting fetch
     * that never came. So the response is closed here rather than left to the
     * stream that was going to own it.
     */
    private static void drop(@NonNull Ticket ticket) {
        ticket.aborted = true;

        Call call = ticket.call;
        if (call != null) call.cancel();

        okhttp3.Response response = ticket.response;
        ticket.response = null;
        close(response);

        ticket.ready.countDown();
    }

    private static void fail(@NonNull Ticket ticket, @NonNull String reason) {
        ticket.error = reason;
        ticket.ready.countDown();
    }

    private static void close(@Nullable okhttp3.Response response) {
        if (response == null) return;
        try {
            response.close();
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not close a response", e);
        }
    }

    /**
     * What a site is told about a failure.
     *
     * <p>Deliberately terse. The exception's own message can name a hostname,
     * a resolver, a certificate chain — detail about the device's network
     * rather than about the request, and none of it the site's business.
     */
    @NonNull
    private static String reasonFrom(@NonNull Exception e) {
        if (e instanceof UnknownHostException) return "That host is not reachable";
        if (e instanceof InterruptedIOException) return "Timed out";
        if (e instanceof javax.net.ssl.SSLException) return "The connection is not secure";

        String message = e.getMessage();
        return message == null || message.isEmpty() ? "Request failed" : message;
    }

    /** A failure of Tenna's, which the shim turns into a rejected promise. */
    @NonNull
    private static WebResourceResponse error(@Nullable String reason) {
        String message = reason == null ? "Request failed" : reason;

        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put(ERROR_HEADER, NappFetchPolicy.isValidHeaderValue(message) ? message : "Request failed");

        return new WebResourceResponse(
            "text/plain",
            "UTF-8",
            502,
            "Bad Gateway",
            headers,
            new ByteArrayInputStream(new byte[0])
        );
    }

    @NonNull
    private static String join(@NonNull List<String> values) {
        if (values.size() == 1) return values.get(0);
        StringBuilder joined = new StringBuilder();
        for (String value : values) {
            if (joined.length() > 0) joined.append(", ");
            joined.append(value);
        }
        return joined.toString();
    }

    @Nullable
    private static String query(@NonNull Uri url, @NonNull String name) {
        try {
            return url.getQueryParameter(name);
        } catch (UnsupportedOperationException e) {
            return null;
        }
    }

    /** Everything this class knows, for a site that has gone away. */
    static void forget(@NonNull String siteId) {
        List<Ticket> theirs = new ArrayList<>();

        synchronized (staged) {
            for (Ticket ticket : staged.values()) {
                if (ticket.siteId.equals(siteId)) theirs.add(ticket);
            }
            for (Ticket ticket : theirs) staged.remove(ticket.id);
            inFlight.remove(siteId);
        }

        for (Ticket ticket : theirs) {
            ticket.released.set(true);
            drop(ticket);
        }
    }
}
