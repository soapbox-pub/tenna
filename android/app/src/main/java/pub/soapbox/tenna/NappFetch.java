package pub.soapbox.tenna;

import android.net.Uri;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
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
import okio.BufferedSink;

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
 * <h2>Two roads in, for two kinds of caller</h2>
 *
 * <p>Both exist because of one fact: {@code shouldInterceptRequest} is never
 * given a request body. So a request cannot simply be made as itself and
 * intercepted — the body would be lost on the way — and it has to arrive by
 * some other road.
 *
 * <ul>
 *   <li><b>A window</b> stages its request over the message channel its
 *       {@code window.nostr} already uses, the body crossing as an array
 *       buffer, and is handed a <b>ticket</b>. It then fetches
 *       {@code /.napp/fetch?t=…}, which is answered here, and the
 *       <em>response</em> comes back through interception — which streams and
 *       carries headers and gives the site a real {@code Response} object
 *       rather than an imitation of one. The ticket is the proof: unguessable,
 *       one-shot, minted against one site, and expiring in
 *       {@value NappFetchPolicy#TICKET_TTL_MS} milliseconds.
 *   <li><b>A worker</b> has a channel of its own — a {@link NappPort}, handed
 *       to it by whatever document started it — and uses it for the whole
 *       request, body and response alike. See {@link PortCall}. Nothing about
 *       that road touches interception, so nothing about it is bounded by what
 *       a URL can hold.
 * </ul>
 *
 * <h2>Why a body streams rather than buffers</h2>
 *
 * <p>A worker's chunks are not gathered up and then sent. The call is started
 * before the first one arrives, and the request body is a stream pulling from
 * a queue {@value NappFetchPolicy#MAX_STAGED_CHUNKS} chunks deep — so a chunk
 * handed over is on its way to the socket before the next one is asked for,
 * and a sixteen-megabyte upload costs about a megabyte of memory rather than
 * sixteen. Each chunk is acknowledged once it has been written, which is what
 * keeps a worker that outruns the network from filling a buffer.
 *
 * <p>A staged body is one-shot, as any stream is. A redirect that would need
 * it a second time is refused rather than replayed; one that turns the request
 * into a GET drops it, which is what the standard asks for anyway.
 *
 * <h2>Why the interception thread is only held for headers</h2>
 *
 * <p>Interception runs on a thread Chromium owns and shares with every service
 * worker in the process, so blocking there stalls every site at once. A
 * window's request is therefore started when it is <em>staged</em>, not when it
 * is collected, and the collection blocks only until the response headers are
 * in — capped at {@value NappFetchPolicy#HEADERS_TIMEOUT_MS} milliseconds. The
 * body is handed over as a stream that Chromium drains on its own schedule, so
 * a slow download holds nothing at all. A worker's request never touches that
 * thread in the first place.
 */
final class NappFetch {

    private static final String TAG = "NappFetch";

    /** Where a window's staged request is collected. */
    static final String PATH = "/.napp/fetch";

    /** Query parameter naming a request staged over the message channel. */
    static final String TICKET_PARAM = "t";

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
     * A worker's body, arriving one chunk at a time over its port.
     *
     * <p>A hand-off between two threads, neither of which may wait on the
     * other for long. The worker's side is {@link NappPort}'s shared thread and
     * never blocks at all — the queue has room for more than the worker is
     * allowed to have outstanding, so {@link #offer} always either takes a
     * chunk or refuses it outright. The socket's side is one of
     * {@link #WORKERS} and may wait as long as
     * {@value NappFetchPolicy#CHUNK_STALL_MS}, since a thread of ours blocking
     * on a queue costs nobody anything.
     *
     * <p>What keeps the queue from filling is the acknowledgement: a chunk is
     * acknowledged when it has been written to the socket, and the worker sends
     * no more than {@value NappFetchPolicy#MAX_STAGED_CHUNKS} unacknowledged
     * ones. The slack above that is for a worker that miscounts; it is refused
     * rather than allowed to grow.
     */
    private static final class Staged {
        /** One chunk, and the number the worker is owed an acknowledgement for. */
        static final class Chunk {
            final int sequence;
            @NonNull final byte[] bytes;

            Chunk(int sequence, @NonNull byte[] bytes) {
                this.sequence = sequence;
                this.bytes = bytes;
            }
        }

        /** What the worker said was coming, and what {@code Content-Length} will say. */
        final long length;

        private final ArrayBlockingQueue<Chunk> chunks =
            new ArrayBlockingQueue<>(NappFetchPolicy.MAX_STAGED_CHUNKS + 2);

        /** Set when nothing more will be accepted, for any of the reasons. */
        private volatile boolean closed;

        /** Bytes taken from the worker so far. Guarded by {@link #offer}'s monitor. */
        private long accepted;

        /** The chunk number expected next. Guarded by {@link #offer}'s monitor. */
        private int next;

        Staged(long length) {
            this.length = length;
        }

        /**
         * Take one chunk, and say whether it was wanted.
         *
         * <p>A chunk out of order, past the declared length, or arriving after
         * the request is over is refused and the upload ends. Nothing honest
         * produces one: the port delivers in order, and the worker counts its
         * own bytes.
         */
        synchronized boolean offer(int sequence, @NonNull byte[] chunk) {
            if (closed) return false;
            // Already had it. Nothing here should produce a duplicate, but
            // answering one by writing the bytes twice would be the worst
            // available way to find out.
            if (sequence != next) return sequence < next;
            if (accepted + chunk.length > length) return false;
            if (!chunks.offer(new Chunk(sequence, chunk))) return false;

            next++;
            accepted += chunk.length;
            return true;
        }

        /** The next chunk to write, for {@link StagedBody}. */
        @NonNull
        Chunk take() throws IOException {
            Chunk chunk;
            try {
                chunk = chunks.poll(NappFetchPolicy.CHUNK_STALL_MS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted");
            }

            if (chunk == null) {
                // Nothing came. Either the worker was killed mid-upload or it
                // simply stopped; either way there is no body to finish, and
                // nothing will ever say so — a port has no close callback.
                throw new IOException("The request body stalled");
            }
            if (closed) throw new IOException("The request body was abandoned");
            return chunk;
        }

        /**
         * Stop accepting, and unblock whoever is waiting on either side.
         *
         * <p>The sentinel matters: a {@code writeTo} parked in {@link #take}
         * would otherwise sit there for the full stall timeout holding a
         * socket, for a body that is never going to arrive.
         */
        void close() {
            closed = true;
            chunks.offer(new Chunk(-1, new byte[0]));
        }
    }

    /** Told when a chunk is really on the socket, so the worker may send another. */
    interface Wrote {
        void wrote(int sequence);
    }

    /**
     * The request body OkHttp writes from, pulling as the worker supplies.
     *
     * <p>One-shot, in OkHttp's sense and in the plain one: the chunks are gone
     * once written, so a retry of any kind has nothing to send. Redirects are
     * followed by hand here, and {@link #execute} refuses the ones that would
     * need the body again.
     */
    private static final class StagedBody extends RequestBody {
        private final Staged staged;
        @Nullable private final MediaType contentType;
        @Nullable private final Wrote wrote;

        StagedBody(@NonNull Staged staged, @Nullable MediaType contentType, @Nullable Wrote wrote) {
            this.staged = staged;
            this.contentType = contentType;
            this.wrote = wrote;
        }

        @Nullable
        @Override
        public MediaType contentType() {
            return contentType;
        }

        @Override
        public long contentLength() {
            return staged.length;
        }

        @Override
        public boolean isOneShot() {
            return true;
        }

        @Override
        public void writeTo(@NonNull BufferedSink sink) throws IOException {
            long written = 0;
            while (written < staged.length) {
                Staged.Chunk chunk = staged.take();
                sink.write(chunk.bytes);
                // Flushed as it goes, so that a chunk handed over is really on
                // its way rather than sitting in Okio's buffer waiting for the
                // next one. It is what makes the queue depth the memory cost.
                sink.flush();
                written += chunk.bytes.length;
                // Only now: an acknowledgement is a promise that the bytes are
                // gone, which is what lets the worker let go of the next slice.
                if (wrote != null) wrote.wrote(chunk.sequence);
            }
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

        /**
         * When {@link #sweep} may drop this, if nobody has come back for it.
         *
         * <p>Not final, because a staged body legitimately outlives the TTL: a
         * sixteen-megabyte upload takes longer than thirty seconds and the
         * ticket has to survive every chunk of it. Each chunk pushes this out,
         * so what expires is an idle ticket rather than a slow one.
         */
        volatile long expiresAt;

        final CountDownLatch ready = new CountDownLatch(1);
        /** Guards the accounting in {@link #release}, which has several callers. */
        final AtomicBoolean released = new AtomicBoolean();

        @Nullable volatile byte[] body;
        /** Set instead of {@link #body} when the body is arriving in chunks. */
        @Nullable volatile Staged staging;
        /** Where a written chunk is reported, for a body arriving over a port. */
        @Nullable volatile Wrote wrote;
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
     * Answer a window's collecting fetch.
     *
     * <p>The caller has already established that this is the named site: a
     * ticket is minted against one site and checked against it here. See
     * {@link NsiteRequests}.
     */
    @NonNull
    static WebResourceResponse serve(@NonNull String siteId, @NonNull Uri url) {
        String ticketId = query(url, TICKET_PARAM);
        if (ticketId == null) return error("No request");

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

    // ── A worker's request, over its port ────────────────────────────────────

    /**
     * One {@code napp.fetch} made by a service worker, start to finish, over
     * the port it was handed.
     *
     * <p>Nothing here is a URL and nothing here is intercepted. The request
     * arrives as a message; a body follows as framed chunks and is written to
     * the socket as each one lands; the response goes back the same way, header
     * message first and then frames, so the site can read it as it arrives
     * rather than when it is complete. See {@link NappPort} for the wire.
     *
     * <p>Both directions are acknowledged, because a port has no backpressure
     * of its own. Outgoing, a chunk is acknowledged when it is on the socket;
     * incoming, when the site's stream has taken it. Neither end is allowed
     * more than {@value NappFetchPolicy#MAX_STAGED_CHUNKS} unacknowledged, so
     * neither end ever holds more than about a megabyte of a body however large
     * the body is.
     */
    static final class PortCall {

        /** Where the answer goes. Every method is called from this call's own thread. */
        interface Sink {
            /** The response, as everything about it except the bytes. */
            void head(@NonNull JSONObject head);

            /** {@code length} bytes of the body, numbered from zero. */
            void body(@NonNull byte[] chunk, int length, int sequence);

            /** One chunk of the <em>request</em> body is on the socket. */
            void wrote(int sequence);

            /** The end, whether it worked or not. Called exactly once. */
            void done(@Nullable String error);
        }

        private final Ticket ticket;
        private final Sink sink;

        /**
         * How many more response chunks may be sent before one is acknowledged.
         *
         * <p>The whole of the backpressure coming back. Without it a fast
         * server and a slow site would put the entire response into the
         * worker's message queue.
         */
        private final Semaphore credit = new Semaphore(NappFetchPolicy.MAX_STAGED_CHUNKS);

        private final AtomicBoolean finished = new AtomicBoolean();

        private PortCall(@NonNull Ticket ticket, @NonNull Sink sink) {
            this.ticket = ticket;
            this.sink = sink;
        }

        /**
         * Read what the worker asked for and claim a place in the queue.
         *
         * <p>Separate from {@link #run} so that the caller can register this
         * before anything is sent: the body chunks are messages of their own
         * and may reach the port's thread before the request has finished
         * starting.
         */
        @NonNull
        static PortCall begin(
            @NonNull String siteId,
            @NonNull JSONObject request,
            @NonNull Sink sink
        ) throws Refused {
            Plan plan = planFrom(request);

            long length = request.optLong("length", 0);
            if (length < 0) throw new Refused("No body length");
            if (length > NappFetchPolicy.MAX_WORKER_BODY_BYTES) {
                throw new Refused("Request body is too large");
            }
            if (length > 0 && !plan.hasBody) throw new Refused("That request said it had no body");
            if (plan.hasBody && length == 0) throw new Refused("That request said it had a body");

            Ticket ticket = new Ticket(UUID.randomUUID().toString(), siteId, plan);
            PortCall call = new PortCall(ticket, sink);

            if (length > 0) {
                ticket.staging = new Staged(length);
                ticket.wrote = sink::wrote;
            }

            if (!take(siteId)) throw new Refused("Too many requests in flight");
            return call;
        }

        /** Make the request, and stream the answer back. */
        void run() {
            ticket.started = true;
            WORKERS.execute(() -> {
                okhttp3.Response response = null;
                try {
                    response = execute(ticket);
                    stream(response);
                    finish(null);
                } catch (IOException | RuntimeException e) {
                    finish(ticket.error != null ? ticket.error : reasonFrom(e));
                } finally {
                    Staged staging = ticket.staging;
                    if (staging != null) staging.close();
                    close(response);
                    release(ticket);
                }
            });
        }

        /** One chunk of the request body, straight off the port's thread. */
        void chunk(int sequence, @NonNull byte[] bytes) {
            Staged staging = ticket.staging;
            if (staging == null) return;
            if (bytes.length > NappFetchPolicy.MAX_CHUNK_BYTES) {
                fail("That chunk is too large");
                return;
            }
            if (!staging.offer(sequence, bytes)) {
                // Out of order, past the length, or after the end. Nothing
                // honest produces one, and feeding the socket half a body
                // would be worse than saying so.
                fail("That chunk was not expected");
            }
        }

        /** The site has taken a response chunk, so another may be sent. */
        void acknowledged(int sequence) {
            credit.release();
        }

        /**
         * Give up: the site aborted, its worker went, or the port closed.
         *
         * <p>Releases the site's place in the queue as well as stopping the
         * request, because this can arrive before {@link #run} ever did — a
         * port closing between {@link #begin} and the first message — and then
         * there is no {@code finally} to do it. Both are idempotent.
         */
        void cancel() {
            if (ticket.error == null) ticket.error = "Aborted";
            drop(ticket);
            credit.release(NappFetchPolicy.MAX_STAGED_CHUNKS);
            release(ticket);
            finish(ticket.error);
        }

        private void fail(@NonNull String reason) {
            ticket.error = reason;
            drop(ticket);
            credit.release(NappFetchPolicy.MAX_STAGED_CHUNKS);
        }

        private void finish(@Nullable String error) {
            if (!finished.compareAndSet(false, true)) return;
            sink.done(error);
        }

        /**
         * Hand over the response: everything but the bytes, then the bytes.
         *
         * <p>Filled a chunk at a time rather than posted as each read returns,
         * because a socket hands back whatever happens to have arrived and a
         * message per TCP segment would be thousands of them for one download.
         */
        private void stream(@NonNull okhttp3.Response response) throws IOException {
            int status = response.code();
            if (!NappFetchPolicy.isServableStatus(status)) {
                throw new IOException("Unserveable status " + status);
            }

            JSONArray headers = new JSONArray();
            for (String name : response.headers().names()) {
                if (NappFetchPolicy.isStrippedResponseHeader(name)) continue;
                for (String value : response.headers().values(name)) {
                    headers.put(new JSONArray().put(name).put(value));
                }
            }

            JSONObject head = new JSONObject();
            try {
                head.put("status", status);
                head.put("statusText", NappFetchPolicy.reasonFor(status, response.message()));
                head.put("headers", headers);
                head.put("url", response.request().url().toString());
            } catch (JSONException e) {
                throw new IOException("Could not describe the response");
            }
            sink.head(head);

            ResponseBody source =
                NappFetchPolicy.isBodilessStatus(status) ? null : response.body();
            if (source == null) return;

            InputStream in = source.byteStream();
            byte[] buffer = new byte[NappFetchPolicy.MAX_CHUNK_BYTES];
            long total = 0;
            int sequence = 0;

            for (;;) {
                int filled = fill(in, buffer);
                if (filled <= 0) break;

                total += filled;
                if (total > NappFetchPolicy.MAX_RESPONSE_BYTES) {
                    throw new IOException("Response is too large");
                }

                try {
                    if (!credit.tryAcquire(
                            NappFetchPolicy.CHUNK_STALL_MS, TimeUnit.MILLISECONDS)) {
                        // The site stopped reading and nothing will say so: a
                        // worker that has been stopped takes messages that go
                        // nowhere and raises nothing.
                        throw new IOException("The response was not collected");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted");
                }

                if (ticket.aborted) throw new IOException("Aborted");
                sink.body(buffer, filled, sequence++);
            }
        }

        /** Read until the buffer is full or the stream ends. */
        private static int fill(@NonNull InputStream in, @NonNull byte[] buffer) throws IOException {
            int filled = 0;
            while (filled < buffer.length) {
                int n = in.read(buffer, filled, buffer.length - filled);
                if (n < 0) break;
                filled += n;
            }
            return filled;
        }
    }

    /** Claim a place in the in-flight count, or say there is none. */
    private static boolean take(@NonNull String siteId) {
        synchronized (staged) {
            sweep();
            int running = count(siteId);
            if (running >= NappFetchPolicy.MAX_IN_FLIGHT_PER_SITE) return false;
            inFlight.put(siteId, running + 1);
        }
        return true;
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
                // Nothing more will be written, whether it went or not. A
                // worker still offering chunks is told so by `put`, which
                // reads the error this just set.
                Staged staging = ticket.staging;
                if (staging != null) staging.close();
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
        Staged staging = ticket.staging;
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
                payload = staging != null
                    ? new StagedBody(staging, contentType, ticket.wrote)
                    : RequestBody.create(body == null ? new byte[0] : body, contentType);
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
                // Whatever the worker has left to hand over is no longer
                // wanted. Closing it says so, rather than leaving the worker
                // offering chunks to a request that has moved on without them.
                if (staging != null) {
                    staging.close();
                    staging = null;
                }
                headers = withoutEntityHeaders(headers);
            } else if (staging != null) {
                // A 307 or a 308 asks for the same body a second time, and a
                // stream has no second time. Every HTTP client refuses this;
                // the alternative is buffering sixteen megabytes on the chance
                // that a server redirects.
                staging.close();
                throw new IOException("Cannot follow that redirect with a staged body");
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
     * <p>Lazily, on the next staging or collection: there is no clock worth
     * running for this, and anything stale is by definition something no one
     * is waiting on. Called holding {@link #staged}.
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

        // Before cancelling, so that a `writeTo` parked on the queue is
        // released rather than left to sit out the stall timeout.
        Staged staging = ticket.staging;
        if (staging != null) staging.close();

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
