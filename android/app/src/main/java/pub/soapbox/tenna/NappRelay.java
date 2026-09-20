package pub.soapbox.tenna;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * One relay connection, kept open and carrying whatever REQs it is given.
 *
 * Reconnects on its own with exponential backoff, and re-sends every REQ on
 * each new socket with {@code since} raised to wherever the subscription had
 * got to, so a dropped connection costs at most a repeat of the last event.
 *
 * NIP-42 is answered only as a connection, never as the user. The key
 * {@link TennaKeys} holds is reachable from this process but is only ever
 * asked for on behalf of somebody who is looking at a screen, and a background
 * service signing as the user with nothing on screen to have asked is the
 * thing that must not happen.
 *
 * A connection's own key is a different matter. It was minted for one remote
 * client, it signs nothing but that conversation, and authenticating with it
 * says no more than "this socket belongs to the connection it says it does" —
 * which is what the relay is asking. Several NIP-46 relays require it before
 * they will carry an ephemeral event at all, so a socket that has a connection
 * on it answers with that connection's key, and a socket that has only sites
 * on it still says nothing.
 */
final class NappRelay extends WebSocketListener {

    private static final String TAG = "NappRelay";

    /**
     * The longest relay frame worth parsing.
     *
     * A notification's whole payload is capped at 64 KiB on the way out, and
     * an event that produces one is smaller still. This is generous against
     * that and cheap against a relay that would rather the service ran out of
     * memory than delivered anything.
     */
    private static final int MAX_FRAME_CHARS = 512 * 1024;

    interface Listener {
        /** An EVENT under one of our REQs. Called on an OkHttp thread. */
        void onEvent(@NonNull String relayUrl, @NonNull NappPlan.Subscription subscription, @NonNull JSONObject event);

        /**
         * A signed kind 22242 for this challenge, or null to leave it alone.
         *
         * Given the connections whose REQs this socket is carrying, so that
         * the answer is signed by one of them and never by the user.
         */
        @Nullable
        String onAuthChallenge(@NonNull String relayUrl, @NonNull String challenge,
                               @NonNull List<NappPlan.Subscription> carrying);
    }

    private static final long MIN_BACKOFF_MS = 1_000;
    private static final long MAX_BACKOFF_MS = 5 * 60_000;

    private final OkHttpClient client;
    private final String url;
    private final Listener listener;
    private final ScheduledExecutorService scheduler;
    private final Random random = new Random();

    /** REQs this relay should be carrying, by id. */
    private final Map<String, NappPlan.Subscription> desired = new HashMap<>();
    /** REQs sent on the current socket, by id, with the filters as sent. */
    private final Map<String, String> sent = new HashMap<>();

    @Nullable private WebSocket socket;
    private boolean open;
    private boolean closed;
    private int attempt;
    private boolean authNoted;
    /** Events this relay sent that weren't signed by who they claimed. */
    private int forged;
    @Nullable private ScheduledFuture<?> reconnect;

    NappRelay(@NonNull OkHttpClient client, @NonNull String url, @NonNull Listener listener, @NonNull ScheduledExecutorService scheduler) {
        this.client = client;
        this.url = url;
        this.listener = listener;
        this.scheduler = scheduler;
    }

    // -----------------------------------------------------------------------
    // Control
    // -----------------------------------------------------------------------

    /** Make the REQs on the wire match this list, connecting first if need be. */
    synchronized void setSubscriptions(@NonNull List<NappPlan.Subscription> subscriptions) {
        desired.clear();
        for (NappPlan.Subscription subscription : subscriptions) desired.put(subscription.id, subscription);

        if (closed) return;
        if (socket == null) {
            connect();
            return;
        }
        if (open) reconcile();
    }

    /** Forget the backoff and try again now, for when the network came back. */
    synchronized void reconnectNow() {
        if (closed || open) return;
        cancelReconnect();
        attempt = 0;
        connect();
    }

    synchronized void close() {
        closed = true;
        cancelReconnect();
        WebSocket current = socket;
        socket = null;
        open = false;
        sent.clear();
        if (current != null) current.close(1000, null);
    }

    private void connect() {
        if (closed || socket != null) return;
        socket = client.newWebSocket(new Request.Builder().url(url).build(), this);
    }

    private void cancelReconnect() {
        ScheduledFuture<?> pending = reconnect;
        reconnect = null;
        if (pending != null) pending.cancel(false);
    }

    private void scheduleReconnect() {
        if (closed || reconnect != null) return;
        long base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS << Math.min(attempt, 12));
        long delay = base / 2 + (long) (random.nextDouble() * base / 2);
        attempt++;
        try {
            reconnect = scheduler.schedule(() -> {
                synchronized (NappRelay.this) {
                    reconnect = null;
                    connect();
                }
            }, delay, TimeUnit.MILLISECONDS);
        } catch (RuntimeException e) {
            // The scheduler is shut down; so is the service.
        }
    }

    // -----------------------------------------------------------------------
    // REQs
    // -----------------------------------------------------------------------

    /** Send what's missing, close what's no longer wanted. Caller holds the lock. */
    private void reconcile() {
        WebSocket current = socket;
        if (current == null || !open) return;

        for (Iterator<Map.Entry<String, String>> it = sent.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, String> entry = it.next();
            if (!desired.containsKey(entry.getKey())) {
                current.send(new JSONArray().put("CLOSE").put(entry.getKey()).toString());
                it.remove();
            }
        }

        for (NappPlan.Subscription subscription : desired.values()) {
            String req = request(subscription);
            if (req == null) continue;
            if (req.equals(sent.get(subscription.id))) continue;
            current.send(req);
            sent.put(subscription.id, req);
        }
    }

    /** The REQ for a subscription, with every filter's {@code since} raised to the floor. */
    @Nullable
    private static String request(NappPlan.Subscription subscription) {
        try {
            JSONArray message = new JSONArray().put("REQ").put(subscription.id);
            long floor = subscription.since.get();
            for (int i = 0; i < subscription.filters.length(); i++) {
                JSONObject filter = subscription.filters.optJSONObject(i);
                if (filter == null) continue;
                JSONObject copy = new JSONObject(filter.toString());
                copy.remove("limit");
                long since = Math.max(copy.optLong("since", 0), floor);
                if (since > 0) copy.put("since", since);
                message.put(copy);
            }
            return message.toString();
        } catch (JSONException e) {
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // WebSocketListener
    // -----------------------------------------------------------------------

    @Override
    public void onOpen(@NonNull WebSocket webSocket, @NonNull Response response) {
        int dropped;
        synchronized (this) {
            if (webSocket != socket) {
                webSocket.close(1000, null);
                return;
            }
            open = true;
            attempt = 0;
            dropped = forged;
            forged = 0;
            sent.clear();
            reconcile();
        }
        Log.i(TAG, dropped > 0
            ? "Connected to " + url + ", which last sent " + dropped + " unverifiable event(s)"
            : "Connected to " + url);
    }

    @Override
    public void onMessage(@NonNull WebSocket webSocket, @NonNull String text) {
        // A relay is somebody else's server and this runs in a foreground
        // service with no window to die quietly: a frame big enough to parse
        // is a frame big enough to take the process out, and org.json builds
        // the whole tree in memory. Nothing a notification is made of comes
        // near this, so anything past it is not an event.
        if (text.length() > MAX_FRAME_CHARS) {
            Log.w(TAG, url + " sent " + text.length() + " characters; dropping the frame");
            return;
        }

        JSONArray message;
        try {
            message = new JSONArray(text);
        } catch (JSONException e) {
            return;
        }
        if (message.length() < 2) return;

        String type = message.optString(0, "");
        switch (type) {
            case "EVENT": {
                if (message.length() < 3) return;
                JSONObject event = message.optJSONObject(2);
                if (event == null) return;

                NappPlan.Subscription subscription;
                synchronized (this) {
                    subscription = desired.get(message.optString(1, ""));
                }
                if (subscription == null) return;

                // The boundary. A relay can say anything, and everything past
                // this line is treated as something a user really wrote — it
                // becomes a notification in the shade, or a request to sign.
                // So an event that is not its own pubkey's is dropped here,
                // once, for every caller, rather than in each of them.
                //
                // After the subscription lookup, not before: an event nobody
                // asked for goes nowhere anyway, and a curve operation per
                // frame is not something a relay gets to ask for by inventing
                // REQ ids.
                if (!NostrCrypto.verifyEvent(event)) {
                    noteForgery();
                    return;
                }

                listener.onEvent(url, subscription, event);
                break;
            }
            case "CLOSED":
                Log.w(TAG, url + " closed " + message.optString(1, "") + ": " + message.optString(2, ""));
                synchronized (this) {
                    sent.remove(message.optString(1, ""));
                }
                break;
            case "OK":
                // The answer to something published. Only worth a line when
                // it is a refusal — an answer a relay would not take is a
                // remote client left waiting, and nothing else on this path
                // would ever say so.
                if (!message.optBoolean(2, false)) {
                    Log.w(TAG, url + " refused an event: " + message.optString(3, ""));
                }
                break;
            case "NOTICE":
                Log.i(TAG, url + " says: " + message.optString(1, ""));
                break;
            case "AUTH":
                authenticate(message.optString(1, ""));
                break;
            default:
                break;
        }
    }

    /**
     * Say once that this relay sent something that wasn't signed by who it
     * claimed, and count the rest.
     *
     * <p>Once per connection, because a relay that sends one forgery can send
     * a million and logcat is not the place to have that argument. The count
     * goes out with the next connection's line, so a run of them is still
     * visible.
     */
    private void noteForgery() {
        boolean first;
        synchronized (this) {
            first = forged++ == 0;
        }
        if (!first) return;

        if (!NostrCrypto.isAvailable()) {
            Log.w(TAG, "No libsecp256k1 on this device, so nothing from " + url
                + " can be checked; dropping it all");
        } else {
            Log.w(TAG, url + " sent an event that was not signed by who it claims; dropping it");
        }
    }

    /**
     * Answer a relay's challenge, if anything on this socket may.
     *
     * <p>Only ever with a connection's key. A socket carrying nothing but
     * sites has nothing to answer with and says so once, in the log.
     */
    private void authenticate(@NonNull String challenge) {
        if (challenge.isEmpty()) return;

        List<NappPlan.Subscription> carrying;
        WebSocket current;
        synchronized (this) {
            current = socket;
            carrying = new ArrayList<>(desired.values());
        }
        if (current == null) return;

        String event = listener.onAuthChallenge(url, challenge, carrying);
        if (event == null) {
            if (!authNoted) {
                authNoted = true;
                Log.i(TAG, url + " wants NIP-42 auth and nothing here may answer as the user");
            }
            return;
        }

        try {
            current.send("[\"AUTH\"," + event + "]");
        } catch (RuntimeException e) {
            Log.i(TAG, "Could not answer " + url + "'s challenge");
        }
    }

    /**
     * Publish an event, if this relay is up.
     *
     * @return false when there is no open socket, so the caller can try
     *         another relay rather than assume it was sent.
     */
    synchronized boolean publish(@NonNull String eventJson) {
        WebSocket current = socket;
        if (current == null || !open) return false;
        try {
            return current.send("[\"EVENT\"," + eventJson + "]");
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    public void onClosing(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
        webSocket.close(1000, null);
    }

    @Override
    public void onClosed(@NonNull WebSocket webSocket, int code, @NonNull String reason) {
        dropped(webSocket, "closed " + code);
    }

    @Override
    public void onFailure(@NonNull WebSocket webSocket, @NonNull Throwable t, @Nullable Response response) {
        dropped(webSocket, String.valueOf(t.getMessage()));
    }

    private void dropped(WebSocket webSocket, String why) {
        synchronized (this) {
            if (webSocket != socket) return;
            socket = null;
            open = false;
            sent.clear();
            if (closed) return;
            scheduleReconnect();
        }
        Log.i(TAG, "Lost " + url + " (" + why + "); retrying");
    }
}
