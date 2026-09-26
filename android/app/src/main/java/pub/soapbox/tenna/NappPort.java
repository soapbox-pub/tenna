package pub.soapbox.tenna;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Base64;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebMessagePortCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import android.net.Uri;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The host end of a message channel to one nsite's service worker.
 *
 * <p>Everything a worker can ask Tenna for arrives here: a notification, the
 * tray read back, a window opened, a signature, an HTTP request. It used to
 * arrive as a URL — a {@code fetch} at the site's own origin, answered from
 * {@code shouldInterceptRequest} — and that road had three costs that were not
 * incidental.
 *
 * <ul>
 *   <li><b>A URL is not a body.</b> {@code shouldInterceptRequest} is never
 *       given a request body; it is not withheld, it is not in the data
 *       structure Chromium builds. So anything a worker wanted to <em>say</em>
 *       had to be written out as base64 in a query string, a third larger than
 *       the bytes it stood for, inside Chromium's two-megabyte URL ceiling, and
 *       a large one had to be cut into as many URLs as it took.
 *   <li><b>It is one-way.</b> A URL is a question; there was no way for the
 *       host to speak first. A signature that needed the user's approval could
 *       therefore not be waited for — it was parked, and the worker asked again
 *       every second until somebody had walked to their phone.
 *   <li><b>The thread is Chromium's.</b> Interception runs on a thread shared
 *       by every service worker in the process, so nothing there could block
 *       without stalling every other site.
 * </ul>
 *
 * <p>A port has none of those. It carries an {@code ArrayBuffer} as bytes,
 * both ends may speak whenever they have something to say, and the callbacks
 * land on a thread of Tenna's own — so a call that has to wait for a person
 * simply waits, and the reply arrives when it arrives.
 *
 * <h2>Who a port belongs to</h2>
 *
 * <p>A port cannot be pointed at the wrong <em>site</em>. It is minted on one
 * site's WebView, on that site's profile, posted to a document at that origin
 * with that origin as the target, and transferred by that document into its own
 * registration. Every hop is constrained by the origin, so the question the old
 * road had to answer with {@link NappTokens} — <em>which</em> site is asking,
 * given that a host in a URL is only a claim — does not arise.
 *
 * <p>What does arise is which <em>context</em> of that site is asking, and the
 * token is still what answers it. A port reaches a worker by way of a document,
 * and a document at a site's origin is running the site's own code, which could
 * keep the port instead of passing it on. That would matter: a page's
 * notifications go through Tenna's permission prompt, and a worker's do not —
 * a worker woken by a push has nobody to prompt. So the first thing a port
 * carries is the token stamped into the shim when the worker's script was
 * served, held in a closure the site's own code cannot read, and nothing on an
 * unproven port is answered. See {@link NappTokens}.
 *
 * <h2>The protocol</h2>
 *
 * <p>Text messages are one JSON object. A call from the worker is
 * {@code {"id":N,"m":"<method>","p":{…}}} and is answered exactly once with
 * {@code {"id":N,"ok":…}} or {@code {"id":N,"err":"…"}}. A {@code fetch} is
 * answered with {@code head}, then body frames, then {@code end}.
 *
 * <p>Bytes travel as framed array buffers: four big-endian bytes of header
 * length, that many bytes of UTF-8 JSON, then the payload. The header names the
 * call and the chunk, so a frame needs no channel of its own. A WebView too old
 * for {@code WEB_MESSAGE_ARRAY_BUFFER} gets the same frames as base64 inside an
 * ordinary text message, which costs a third in size and nothing in
 * correctness.
 *
 * <p><b>Ports have no backpressure</b>, so it is done by hand and in both
 * directions: a chunk is acknowledged when it has been dealt with — written to
 * the socket going out, handed to the site's stream coming in — and neither end
 * sends more than {@link NappFetchPolicy#MAX_STAGED_CHUNKS} unacknowledged. A
 * sixteen-megabyte upload therefore costs about a megabyte of memory on each
 * side rather than sixteen.
 *
 * <h2>What a port does not survive</h2>
 *
 * <p>It outlives the document that handed it over — measured: the WebView can
 * be destroyed and the port still round-trips — which is what makes it usable
 * for a push, where the wake page is gone long before the worker has finished.
 *
 * <p>It does not outlive the worker. Chromium stops an idle worker after about
 * thirty seconds and the next start gets a fresh global with no port in it, so
 * a port is handed over per worker start rather than once. Nor does traffic on
 * one keep a worker alive: a port message is not an event and does not touch
 * the idle timer, so a long operation has to be held open by the
 * {@code waitUntil} of whatever event started it, exactly as everything else in
 * a worker is.
 *
 * <p>And a {@code postMessage} to a worker that has gone throws nothing and is
 * simply lost. There is no close callback to listen for. So nothing here waits
 * forever: a chunk that is never acknowledged times out
 * ({@link NappFetchPolicy#CHUNK_STALL_MS}) and the request it belonged to is
 * abandoned.
 */
final class NappPort {

    private static final String TAG = "NappPort";

    /**
     * Where a worker with no port rings for one.
     *
     * <p>The last thing in a worker's API that is a URL, and the one thing
     * interception is actually good at: a bodiless GET, carrying nothing,
     * answered with nothing. It exists because the doorbell cannot be rung any
     * other way. A worker can reach its own windows with
     * {@code client.postMessage}, but a page only receives those once something
     * has started its message queue — and starting it on a site's behalf would
     * deliver messages the site queued for a listener it has not added yet.
     * Ringing the host instead costs the site nothing.
     */
    static final String PATH = "/.napp/port";

    /** How many bytes of a frame name its header's length. */
    private static final int HEADER_PREFIX_BYTES = 4;

    /**
     * One thread for every port in the app.
     *
     * <p>Callbacks land here, and nothing on it is allowed to block: it is
     * shared, so a call that waited on a person or a socket would stall every
     * other site's worker — the very hazard interception had, reproduced. What
     * runs here is framing, dispatch and the acknowledgements, all of which are
     * bookkeeping. Everything that can wait goes to {@link #CALLS}.
     */
    @Nullable private static HandlerThread thread;
    @Nullable private static Handler handler;

    /**
     * Where a call is actually answered.
     *
     * <p>Unbounded and cached, because what is waiting is a person or a
     * network: a signature nobody has approved holds one of these for as long
     * as {@link NsiteWorkerSigner} allows, and a site is entitled to
     * {@link NappFetchPolicy#MAX_IN_FLIGHT_PER_SITE} requests at once.
     */
    private static final ExecutorService CALLS = Executors.newCachedThreadPool(r -> {
        Thread worker = new Thread(r, "napp-port-call");
        worker.setDaemon(true);
        return worker;
    });

    /** Every live port, by site. A site may briefly have more than one. */
    private static final Map<String, List<NappPort>> live = new HashMap<>();

    /** Something that can put a port in front of a site's worker. */
    interface Source {
        void wanted();
    }

    /**
     * Who to ask, per site, when a worker rings {@link #PATH}.
     *
     * <p>A site's own window, in practice: it is the document that has to
     * carry the port across, and minting one needs its WebView. A site with no
     * window has nobody here and its worker is told so — but that case does not
     * arise for the reason a worker is running at all with no window, which is
     * a push, and a push arrives with a port already attached.
     */
    private static final Map<String, Source> sources = new HashMap<>();

    /** Say who will answer the doorbell for a site. */
    static void source(@NonNull String siteId, @NonNull Source source) {
        synchronized (sources) {
            sources.put(siteId, source);
        }
    }

    /**
     * Take it back, a window having closed.
     *
     * <p>Only if it is still the one registered: opening the same site again
     * replaces it, and the window that went is not the window that answers.
     * With nobody left, a worker that rings is told so at once rather than
     * waiting out its own deadline on a WebView that has been destroyed.
     */
    static void unsource(@NonNull String siteId, @NonNull Source source) {
        synchronized (sources) {
            if (sources.get(siteId) == source) sources.remove(siteId);
        }
    }

    /** A worker asking for a port. Answers whether anyone was there to ask. */
    static boolean wanted(@NonNull String siteId) {
        Source source;
        synchronized (sources) {
            source = sources.get(siteId);
        }
        if (source == null) return false;
        source.wanted();
        return true;
    }

    private final Context context;
    private final String siteId;
    private final WebMessagePortCompat port;

    /** Fetches this port has out, by call id. */
    private final Map<Integer, NappFetch.PortCall> fetches = new HashMap<>();

    private volatile boolean closed;

    /**
     * Whether the thing holding the far end has shown it is the worker.
     *
     * <p>Set from the port's own thread, before anything is dispatched, so
     * that a call cannot overtake the proof that allows it. See the note on
     * the class for what it is defending.
     */
    private boolean proven;

    private NappPort(@NonNull Context context, @NonNull String siteId, @NonNull WebMessagePortCompat port) {
        this.context = context.getApplicationContext();
        this.siteId = siteId;
        this.port = port;
    }

    // ── Making one ───────────────────────────────────────────────────────────

    /** Whether this WebView can hand a worker a port at all. */
    static boolean isSupported() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL)
            && WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE)
            && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE)
            && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_CALLBACK_ON_MESSAGE);
    }

    /** Whether bytes can cross as bytes, rather than as base64 in a string. */
    static boolean isBinary() {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
    }

    /**
     * Mint a channel on a document's WebView and post the far end to it.
     *
     * <p>The document is expected to transfer that end into its own service
     * worker: a port arrives at a frame, and a frame is the only thing that can
     * hand one to a worker. See {@code napp_port.js}, which both the wake page
     * and a site's own window run.
     *
     * <p>{@code extra} rides along in the same message, which is how the wake
     * page delivers a push and the port it is to be answered over in one go —
     * so by the time the site's handler runs, {@code self.napp} already works.
     *
     * @return false if this WebView cannot do it, in which case the worker has
     *         no host at all and the caller should say so rather than wait.
     */
    static boolean hand(
        @NonNull Context context,
        @NonNull WebView view,
        @NonNull String siteId,
        @NonNull String origin,
        @NonNull JSONObject message
    ) {
        if (!isSupported()) {
            Log.w(TAG, "This WebView cannot give a worker a port; " + siteId + " gets no host");
            return false;
        }

        try {
            WebMessagePortCompat[] pair = WebViewCompat.createWebMessageChannel(view);
            NappPort host = new NappPort(context, siteId, pair[0]);
            host.listen();
            WebViewCompat.postWebMessage(
                view,
                new WebMessageCompat(message.toString(), new WebMessagePortCompat[] { pair[1] }),
                Uri.parse(origin)
            );
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not hand " + siteId + " a port", e);
            return false;
        }
    }

    private void listen() {
        synchronized (live) {
            List<NappPort> theirs = live.get(siteId);
            if (theirs == null) {
                theirs = new ArrayList<>(2);
                live.put(siteId, theirs);
            }
            theirs.add(this);
        }

        port.setWebMessageCallback(handler(), new WebMessagePortCompat.WebMessageCallbackCompat() {
            @Override
            public void onMessage(@NonNull WebMessagePortCompat p, @Nullable WebMessageCompat message) {
                if (message == null) return;
                if (isBinary() && message.getType() == WebMessageCompat.TYPE_ARRAY_BUFFER) {
                    onFrame(message.getArrayBuffer());
                    return;
                }
                onText(message.getData());
            }
        });
    }

    private static synchronized Handler handler() {
        if (handler == null) {
            thread = new HandlerThread("napp-port");
            thread.start();
            handler = new Handler(thread.getLooper());
        }
        return handler;
    }

    // ── Letting go ───────────────────────────────────────────────────────────

    /**
     * Drop every port a site has, and everything they had out.
     *
     * <p>Called when a site's window closes or the site is forgotten. A port
     * whose worker is still running will simply stop being answered, which is
     * the same thing that happens when the worker itself goes.
     */
    static void forget(@NonNull String siteId) {
        synchronized (sources) {
            sources.remove(siteId);
        }

        List<NappPort> theirs;
        synchronized (live) {
            theirs = live.remove(siteId);
        }
        if (theirs == null) return;
        for (NappPort host : theirs) host.close();
    }

    private void close() {
        if (closed) return;
        closed = true;

        List<NappFetch.PortCall> running;
        synchronized (fetches) {
            running = new ArrayList<>(fetches.values());
            fetches.clear();
        }
        for (NappFetch.PortCall call : running) call.cancel();

        // On the port's own thread: closing one is not documented as safe from
        // anywhere else, and there may be a callback in flight.
        handler().post(() -> {
            try {
                port.close();
            } catch (RuntimeException e) {
                // A port whose worker has gone. Nothing to do about it.
            }
        });
    }

    private void retire() {
        synchronized (live) {
            List<NappPort> theirs = live.get(siteId);
            if (theirs != null) {
                theirs.remove(this);
                if (theirs.isEmpty()) live.remove(siteId);
            }
        }
        close();
    }

    // ── Reading ──────────────────────────────────────────────────────────────

    /**
     * One text message from the worker.
     *
     * <p>On the shared thread, so this decides what can be answered here and
     * what has to go somewhere it may block. Acknowledgements are the former:
     * they are the mechanism the blocking waits on, and handing one to a queue
     * behind the call it unblocks would deadlock.
     */
    private void onText(@Nullable String data) {
        if (data == null || closed) return;

        JSONObject message;
        try {
            message = new JSONObject(data);
        } catch (JSONException e) {
            // Not ours. A site's own code shares this worker and may well
            // postMessage things of its own shape.
            return;
        }

        String method = message.optString("m", "");

        // The worker saying who it is, which is the first thing it says. On
        // this thread rather than on the executor, so that nothing a port
        // carries can be dispatched before the proof that allows it.
        if (method.equals("hello")) {
            JSONObject params = message.optJSONObject("p");
            String token = params == null ? null : params.optString("a", null);
            proven = NappTokens.matches(context, siteId, token);
            if (!proven) {
                Log.i(TAG, "A port for " + siteId + " could not show it was the worker's");
                retire();
            }
            return;
        }

        if (!proven) {
            // Nothing else is worth reading. A document at the site's origin
            // could be holding this instead of having passed it on, and a
            // document has its own, prompted, way of asking for all of it.
            Log.i(TAG, "Refused " + method + " on an unproven port for " + siteId);
            return;
        }

        int id = message.optInt("id", -1);
        if (id < 0) return;

        // A frame the long way round, on a WebView with no array buffers.
        if (message.has("b")) {
            byte[] payload;
            try {
                payload = Base64.decode(
                    message.optString("b", ""), Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            } catch (IllegalArgumentException e) {
                return;
            }
            body(id, message.optInt("i", -1), payload);
            return;
        }

        if (method.equals("ack")) {
            NappFetch.PortCall call = fetch(id);
            if (call != null) call.acknowledged(message.optInt("i", -1));
            return;
        }

        if (method.equals("abort")) {
            NappFetch.PortCall call;
            synchronized (fetches) {
                call = fetches.remove(id);
            }
            if (call != null) call.cancel();
            return;
        }

        JSONObject params = message.optJSONObject("p");
        final JSONObject args = params == null ? new JSONObject() : params;

        // A fetch is registered here rather than on the executor, and that is
        // load-bearing. The body follows as separate messages, which a port
        // delivers in order and this thread therefore sees in order — but only
        // if the thing they belong to is already in the map by the time the
        // first one arrives. Registering it a thread-hop away lost the race
        // often enough to be found: every chunk was dropped on the floor and
        // the upload stalled until the body timed out, thirty seconds later,
        // with nothing anywhere saying why. Nothing in `begin` blocks.
        if (method.equals("fetch")) {
            fetch(id, args);
            return;
        }

        CALLS.execute(() -> answer(id, method, args));
    }

    /**
     * One chunk of a body, as it crosses: four big-endian bytes of header
     * length, that many bytes of UTF-8 JSON, then the payload.
     *
     * <p>A wire format shared with {@code napp_sw_shim.js}, so it is pinned by
     * a test rather than left to be discovered from both sides at once.
     */
    static final class Frame {
        final int id;
        final int sequence;
        @NonNull final byte[] payload;

        private Frame(int id, int sequence, @NonNull byte[] payload) {
            this.id = id;
            this.sequence = sequence;
            this.payload = payload;
        }

        /** Write one. {@code length} bytes are taken from the front of {@code chunk}. */
        @NonNull
        static byte[] write(int id, int sequence, @NonNull byte[] chunk, int length) {
            byte[] header = ("{\"id\":" + id + ",\"i\":" + sequence + "}")
                .getBytes(StandardCharsets.UTF_8);
            byte[] frame = new byte[HEADER_PREFIX_BYTES + header.length + length];

            frame[0] = (byte) (header.length >>> 24);
            frame[1] = (byte) (header.length >>> 16);
            frame[2] = (byte) (header.length >>> 8);
            frame[3] = (byte) header.length;
            System.arraycopy(header, 0, frame, HEADER_PREFIX_BYTES, header.length);
            System.arraycopy(chunk, 0, frame, HEADER_PREFIX_BYTES + header.length, length);

            return frame;
        }

        /** Read one, or null if it is not one. */
        @Nullable
        static Frame read(@Nullable byte[] frame) {
            if (frame == null || frame.length < HEADER_PREFIX_BYTES) return null;

            int length = ((frame[0] & 0xFF) << 24)
                | ((frame[1] & 0xFF) << 16)
                | ((frame[2] & 0xFF) << 8)
                | (frame[3] & 0xFF);
            if (length < 0 || length > frame.length - HEADER_PREFIX_BYTES) return null;

            JSONObject header;
            try {
                header = new JSONObject(
                    new String(frame, HEADER_PREFIX_BYTES, length, StandardCharsets.UTF_8));
            } catch (JSONException e) {
                return null;
            }

            int id = header.optInt("id", -1);
            int sequence = header.optInt("i", -1);
            if (id < 0 || sequence < 0) return null;

            int from = HEADER_PREFIX_BYTES + length;
            byte[] payload = new byte[frame.length - from];
            System.arraycopy(frame, from, payload, 0, payload.length);

            return new Frame(id, sequence, payload);
        }
    }

    /** One framed array buffer from the worker: a chunk of a request body. */
    private void onFrame(@Nullable byte[] frame) {
        if (closed || !proven) return;

        Frame read = Frame.read(frame);
        if (read == null) return;

        body(read.id, read.sequence, read.payload);
    }

    private void body(int id, int sequence, @NonNull byte[] payload) {
        if (id < 0 || sequence < 0) return;
        NappFetch.PortCall call = fetch(id);
        if (call != null) call.chunk(sequence, payload);
    }

    @Nullable
    private NappFetch.PortCall fetch(int id) {
        synchronized (fetches) {
            return fetches.get(id);
        }
    }

    // ── Answering ────────────────────────────────────────────────────────────

    /**
     * Do one thing a worker asked for.
     *
     * <p>On {@link #CALLS}, so it may take as long as it takes. Every branch
     * ends in exactly one reply, including the ones that fail — a call the
     * worker is never answered about is a promise that never settles.
     */
    private void answer(int id, @NonNull String method, @NonNull JSONObject params) {
        try {
            switch (method) {
                case "notification":
                    notification(id, params);
                    break;
                case "notifications":
                    notifications(id, params);
                    break;
                case "close":
                    closeNotification(id, params);
                    break;
                case "open":
                    open(id, params);
                    break;
                case "nostr":
                    nostr(id, params);
                    break;
                case "periodicsync":
                    periodicSync(id, params);
                    break;
                default:
                    fail(id, "Tenna does not know that call");
                    break;
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not answer " + method + " for " + siteId, e);
            fail(id, "Tenna could not answer");
        }
    }

    /**
     * {@code registration.showNotification}.
     *
     * <p>Only for a site the user let notify. A worker has nobody to prompt,
     * and one woken by a periodic sync — unlike one woken by a push — has not
     * shown it was ever allowed to say anything. See {@link NappNotifyGrants}.
     */
    private void notification(int id, @NonNull JSONObject params) {
        if (!NappNotifyGrants.allowed(context, siteId)) {
            fail(id, "Notification refused");
            return;
        }
        if (NappNotifications.show(context, siteId, params)) result(id, JSONObject.NULL);
        else fail(id, "Notification refused");
    }

    /**
     * {@code registration.periodicSync}, from inside the worker.
     *
     * <p>Reading and unregistering are answered as they are for the window.
     * Registering is not asked of anybody — a worker has nobody to ask — so it
     * is only allowed for a site that already holds a tag, which is proof the
     * user granted it: revoking the grant clears every tag. A site with none
     * registers from its window, where the question can be put.
     */
    private void periodicSync(int id, @NonNull JSONObject params) {
        String op = params.optString("op", "");
        String tag = params.optString("tag", "");

        switch (op) {
            case "tags":
                result(id, new JSONArray(NappPeriodicSync.tags(context, siteId)));
                return;
            case "unregister":
                if (!tag.isEmpty()) NappPeriodicSync.unregister(context, siteId, tag);
                result(id, JSONObject.NULL);
                return;
            case "register":
                if (tag.isEmpty()) {
                    fail(id, "Invalid tag");
                    return;
                }
                if (NappPeriodicSync.get(context, siteId).isEmpty()) {
                    fail(id, "Permission denied");
                    return;
                }
                try {
                    NappPeriodicSync.register(context, siteId, tag, params.optLong("minInterval", 0));
                } catch (IllegalStateException e) {
                    fail(id, e.getMessage());
                    return;
                }
                result(id, JSONObject.NULL);
                return;
            default:
                fail(id, "Tenna does not know that call");
        }
    }

    /**
     * {@code registration.getNotifications}.
     *
     * <p>Only the site's own: the id is this port's, so a site can no more read
     * another's tray than it can post to it.
     */
    private void notifications(int id, @NonNull JSONObject params) {
        String tag = params.isNull("tag") ? null : params.optString("tag", null);
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

        result(id, out);
    }

    /** {@code Notification.close}. */
    private void closeNotification(int id, @NonNull JSONObject params) {
        String key = params.optString("key", "");
        if (key.isEmpty() || !key.startsWith(NsiteSites.key(siteId) + "/")) {
            fail(id, "No such notification");
            return;
        }

        NappNotifications.cancel(context, siteId, key);
        result(id, JSONObject.NULL);
    }

    /**
     * {@code clients.openWindow} and {@code WindowClient.focus}.
     *
     * <p>Neither works in a WebView on its own — a worker has no way to make a
     * browsing context, and focusing one is a window-manager act rather than a
     * web one — so both come out here, which starts the same activity a tap on
     * a notification does.
     *
     * <p>A site can only open itself, and only just after the user acted on one
     * of its notifications, which is the case the API is for.
     */
    private void open(int id, @NonNull JSONObject params) {
        String path = NappOptions.path(params.isNull("url") ? null : params.optString("url", null));

        if (NsiteSites.load(context, siteId) == null) {
            fail(id, "No such site");
            return;
        }

        // A worker that puts its site on screen off the back of a relay event
        // is not answering anybody; see NappNotifications.
        if (!NappNotifications.recentlyInteracted(siteId)) {
            fail(id, "Nothing asked for that window");
            return;
        }

        try {
            context.startActivity(
                NsiteAppActivity.notificationIntentFor(context, siteId, path, null));
        } catch (RuntimeException e) {
            // Background activity launch restrictions. A worker woken by a tap
            // is inside the exemption window; one woken by a relay is not, and
            // has no business opening a window unasked anyway.
            Log.i(TAG, "Refused to open a window for " + siteId, e);
            fail(id, "Could not open the window");
            return;
        }

        result(id, JSONObject.NULL);
    }

    /**
     * {@code self.nostr}.
     *
     * <p>This is the call the port was worth having for. On the old road a
     * signature nobody had approved could not be waited for — the thread was
     * Chromium's — so it was parked and the worker asked again every second.
     * Here the reply simply arrives when the user has decided, and the worker's
     * promise settles then. See {@link NsiteWorkerSigner}.
     */
    private void nostr(int id, @NonNull JSONObject params) {
        NsiteWorkerSigner.answer(
            context,
            siteId,
            params.optString("method", ""),
            params.optJSONObject("params"),
            new NsiteWorkerSigner.Answer() {
                @Override
                public void result(@NonNull Object value) {
                    NappPort.this.result(id, value);
                }

                @Override
                public void failed(@NonNull String reason) {
                    fail(id, reason);
                }
            }
        );
    }

    /**
     * {@code napp.fetch}.
     *
     * <p>On the port's own thread, before any of the body can arrive. See the
     * note in {@link #onText}: everything here is parsing and bookkeeping, and
     * the request itself is made on a thread of {@link NappFetch}'s.
     */
    private void fetch(int id, @NonNull JSONObject params) {
        NappFetch.PortCall call;
        try {
            call = NappFetch.PortCall.begin(siteId, params, new NappFetch.PortCall.Sink() {
                @Override
                public void head(@NonNull JSONObject head) {
                    send(reply(id).put("head", head));
                }

                @Override
                public void body(@NonNull byte[] chunk, int length, int sequence) {
                    frame(id, sequence, chunk, length);
                }

                @Override
                public void wrote(int sequence) {
                    send(reply(id).put("ack", sequence));
                }

                @Override
                public void done(@Nullable String error) {
                    synchronized (fetches) {
                        fetches.remove(id);
                    }
                    Envelope end = reply(id).put("end", true);
                    if (error != null) end.put("err", error);
                    send(end);
                }
            });
        } catch (NappFetch.Refused e) {
            fail(id, e.getMessage());
            return;
        }

        boolean stale;
        synchronized (fetches) {
            stale = closed;
            if (!stale) fetches.put(id, call);
        }
        if (stale) {
            call.cancel();
            return;
        }

        call.run();
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /** A reply envelope, which {@code put} chains onto without ever throwing. */
    @NonNull
    private static Envelope reply(int id) {
        return new Envelope(id);
    }

    /**
     * A JSON reply built without the checked exceptions.
     *
     * <p>{@code JSONObject.put} declares {@code JSONException} for a NaN or an
     * infinity, and nothing written here is a number at all. Swallowing it
     * once, here, keeps every call site readable.
     */
    private static final class Envelope {
        final JSONObject json = new JSONObject();

        Envelope(int id) {
            put("id", id);
        }

        @NonNull
        Envelope put(@NonNull String name, @Nullable Object value) {
            try {
                json.put(name, value);
            } catch (JSONException e) {
                // Not reachable: every value written here is a string, a
                // boolean, an int, or JSON built by org.json itself.
            }
            return this;
        }
    }

    private void result(int id, @NonNull Object value) {
        send(reply(id).put("ok", value));
    }

    private void fail(int id, @Nullable String reason) {
        send(reply(id).put("err", reason == null ? "Tenna could not answer" : reason));
    }

    private void send(@NonNull Envelope envelope) {
        send(envelope.json.toString());
    }

    private void send(@NonNull String text) {
        if (closed) return;
        handler().post(() -> {
            if (closed) return;
            try {
                port.postMessage(new WebMessageCompat(text));
            } catch (RuntimeException e) {
                // A worker that has gone. There is no callback that says so, so
                // this is where it is found out; the request that was being
                // answered times out on its own.
                Log.i(TAG, "The port for " + siteId + " would not take a message", e);
                retire();
            }
        });
    }

    /**
     * Send one chunk of a response body.
     *
     * <p>Four bytes of header length, the header, then the bytes — so the frame
     * names the call it belongs to and needs no channel of its own. On a
     * WebView with no array buffers the same frame goes as base64 in an
     * ordinary message.
     */
    private void frame(int id, int sequence, @NonNull byte[] chunk, int length) {
        if (closed) return;

        if (!isBinary()) {
            byte[] exact = new byte[length];
            System.arraycopy(chunk, 0, exact, 0, length);
            send(reply(id)
                .put("i", sequence)
                .put("b", Base64.encodeToString(
                    exact, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP)));
            return;
        }

        byte[] frame = Frame.write(id, sequence, chunk, length);

        handler().post(() -> {
            if (closed) return;
            try {
                port.postMessage(new WebMessageCompat(frame));
            } catch (RuntimeException e) {
                Log.i(TAG, "The port for " + siteId + " would not take a frame", e);
                retire();
            }
        });
    }
}
