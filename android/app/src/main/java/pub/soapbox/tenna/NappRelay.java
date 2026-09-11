package pub.soapbox.tenna;

import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

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
 * NIP-42 is not spoken here. The service holds no keys, so an {@code AUTH}
 * challenge is noted and left unanswered; a relay that then withholds events
 * withholds them.
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
        synchronized (this) {
            if (webSocket != socket) {
                webSocket.close(1000, null);
                return;
            }
            open = true;
            attempt = 0;
            sent.clear();
            reconcile();
        }
        Log.i(TAG, "Connected to " + url);
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
                if (subscription != null) listener.onEvent(url, subscription, event);
                break;
            }
            case "CLOSED":
                Log.w(TAG, url + " closed " + message.optString(1, "") + ": " + message.optString(2, ""));
                synchronized (this) {
                    sent.remove(message.optString(1, ""));
                }
                break;
            case "NOTICE":
                Log.i(TAG, url + " says: " + message.optString(1, ""));
                break;
            case "AUTH":
                if (!authNoted) {
                    authNoted = true;
                    Log.i(TAG, url + " wants NIP-42 auth, which the push service cannot give");
                }
                break;
            default:
                break;
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
