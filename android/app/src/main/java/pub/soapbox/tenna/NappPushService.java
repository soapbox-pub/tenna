package pub.soapbox.tenna;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import okhttp3.OkHttpClient;

/**
 * Keeps relays open on behalf of every nsite that asked, and delivers what
 * arrives to the site's service worker.
 *
 * Runs as a foreground service because that is the only thing Android lets
 * hold a socket open indefinitely, and a notification for something that
 * happened an hour ago is not a notification. Started whenever any site has
 * a subscription, stopped when none does, and restarted after a reboot.
 *
 * What it does with an event is deliberately little: check it hasn't been
 * seen, note how far the subscription has got, and hand it to the site's
 * worker. What the notification says, or whether there is one, is the
 * site's decision, made in its own code.
 */
public class NappPushService extends Service {

    private static final String TAG = "NappPushService";

    static final String ACTION_SYNC = "pub.soapbox.tenna.napp.SYNC";

    /** Raise an event in a site's worker that did not come off a relay. */
    static final String ACTION_DELIVER = "pub.soapbox.tenna.napp.DELIVER";

    /** Answer a remote signing request the user has just decided about. */
    static final String ACTION_ANSWER = "pub.soapbox.tenna.napp.ANSWER";
    /** Tell a client that invited us that its connection is live. */
    static final String ACTION_ANNOUNCE = "pub.soapbox.tenna.napp.ANNOUNCE";

    private static final String EXTRA_SITE_ID = "pub.soapbox.tenna.napp.SITE_ID";
    private static final String EXTRA_REQUEST_ID = "pub.soapbox.tenna.napp.REQUEST_ID";
    private static final String EXTRA_LOCAL_PUBKEY = "pub.soapbox.tenna.napp.LOCAL_PUBKEY";
    private static final String EXTRA_ALLOWED = "pub.soapbox.tenna.napp.ALLOWED";
    private static final String EXTRA_REMEMBER = "pub.soapbox.tenna.napp.REMEMBER";

    /** How many times an answer is retried while a socket is still opening. */
    private static final int PUBLISH_ATTEMPTS = 12;
    private static final long PUBLISH_RETRY_MS = 500;
    private static final String EXTRA_KIND = "pub.soapbox.tenna.napp.KIND";
    private static final String EXTRA_DATA = "pub.soapbox.tenna.napp.DATA";

    /** Events remembered for dedupe, across every site. */
    private static final int SEEN_EVENTS = 4000;

    private static volatile boolean running;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "napp-scheduler");
        t.setDaemon(true);
        return t;
    });

    private OkHttpClient client;
    private NappRelayPool pool;

    /** How far each REQ has got, by REQ id, kept across plan rebuilds. */
    private final Map<String, AtomicLong> sinces = new HashMap<>();

    /** Site key + event id, in arrival order, capped. */
    private final Map<String, Boolean> seenEvents = new LinkedHashMap<String, Boolean>(256, 0.75f, false) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest) {
            return size() > SEEN_EVENTS;
        }
    };

    /** One wake page per site with something in flight. Main thread only. */
    private final Map<String, NappWakeWebView> wakers = new HashMap<>();

    /** Whether the last plan had anything to listen for. */
    private boolean subscribed;

    @Nullable private ConnectivityManager.NetworkCallback networkCallback;

    // -----------------------------------------------------------------------
    // Entry points
    // -----------------------------------------------------------------------

    /**
     * Make the service's state match the subscriptions on disk.
     *
     * Starts it if any site has subscriptions, and lets it stop itself if
     * none does. Safe to call from anywhere, any number of times.
     */
    static void sync(@NonNull Context context) {
        Context app = context.getApplicationContext();
        // A remote connection is a reason to be listening even when no site
        // has asked for anything, and the reverse. Either keeps it up.
        boolean wanted = !NappSubscriptions.all(app).isEmpty() || BunkerConnections.any(app);

        Intent intent = new Intent(app, NappPushService.class).setAction(ACTION_SYNC);
        if (wanted) {
            try {
                ContextCompat.startForegroundService(app, intent);
            } catch (RuntimeException e) {
                // Background start restrictions. The next foreground moment
                // or the next reboot will try again.
                Log.w(TAG, "Could not start the push service", e);
            }
        } else if (running) {
            app.stopService(intent);
        }
    }

    static boolean isRunning() {
        return running;
    }

    /**
     * Raise a notification event in a site's service worker.
     *
     * The worker is where the web puts these, and where a site's own routing
     * and reply-sending already live — so a tap on a notification, a press on
     * one of its buttons, and a swipe to dismiss all end up as the same events
     * the site would get in a browser. Nothing on a relay is involved; this
     * borrows the service only because the service is what owns the machinery
     * for reaching a worker with no window open.
     *
     * Safe to call cold. If the service was not running it is started, does
     * this, and stops itself again once the worker has answered.
     */
    static void dispatchNotificationEvent(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull String kind,
        @NonNull String key,
        @Nullable String action,
        @Nullable String reply
    ) {
        Context app = context.getApplicationContext();

        NappNotificationStore.Entry entry = NappNotificationStore.get(app, siteId, key);
        if (entry == null) return;

        // The user just asked for something, so for the next minute the site's
        // worker may open its window in answer. Dismissing is not asking for
        // anything, and grants nothing. See NappNotifications.
        if ("notificationclick".equals(kind)) NappNotifications.interacted(siteId);

        String data;
        try {
            JSONObject json = new JSONObject();
            json.put("key", entry.key);
            json.put("tag", entry.tag);
            json.put("title", entry.title);
            json.put("options", new JSONObject(entry.options));
            json.put("action", action == null ? "" : action);
            if (reply != null) json.put("reply", reply);
            data = json.toString();
        } catch (JSONException e) {
            return;
        }

        Intent intent = new Intent(app, NappPushService.class)
            .setAction(ACTION_DELIVER)
            .putExtra(EXTRA_SITE_ID, siteId)
            .putExtra(EXTRA_KIND, kind)
            .putExtra(EXTRA_DATA, data);

        try {
            ContextCompat.startForegroundService(app, intent);
        } catch (RuntimeException e) {
            // Background start restrictions. Acting on a notification is one
            // of the exemptions, so this should not happen — and if it does,
            // the site simply doesn't hear about the tap.
            Log.w(TAG, "Could not deliver a notification event", e);
        }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;

        client = new OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .build();
        pool = new NappRelayPool(client, scheduler, new NappRelay.Listener() {
            @Override
            public void onEvent(@NonNull String relayUrl, @NonNull NappPlan.Subscription subscription,
                                @NonNull JSONObject event) {
                NappPushService.this.onEvent(relayUrl, subscription, event);
            }

            @Override
            @Nullable
            public String onAuthChallenge(@NonNull String relayUrl, @NonNull String challenge,
                                          @NonNull List<NappPlan.Subscription> carrying) {
                return NappPushService.this.onAuthChallenge(relayUrl, challenge, carrying);
            }
        });

        watchNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        List<NappSubscriptions.Record> records = NappSubscriptions.all(this);
        List<BunkerConnections.Connection> connections = BunkerConnections.all(this);
        NappPlan plan = NappPlan.build(records, connections, sinces);

        // Into the foreground first, whatever else happens: a service that
        // was started as foreground and hasn't called startForeground within
        // a few seconds is killed, and takes the app with it.
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            : 0;
        ServiceCompat.startForeground(
            this,
            NappNotifications.SERVICE_NOTIFICATION_ID,
            NappNotifications.serviceNotification(this, plan.siteIds.size(), plan.connectionCount),
            type
        );

        subscribed = !plan.byRelay.isEmpty();

        // Anything that has to go out on a socket waits until the plan has
        // been applied at the bottom of this method, because the socket it
        // needs may be one this call is about to open.
        @Nullable Runnable afterConnecting = null;

        if (intent != null && ACTION_ANSWER.equals(intent.getAction())) {
            NappBunker.Staged staged = NappBunker.unstage(intent.getStringExtra(EXTRA_REQUEST_ID));
            if (staged != null) {
                afterConnecting = () -> NappBunker.resolve(
                    this, this::publish, staged.request, staged.allowed, staged.remember);
            }
        }

        if (intent != null && ACTION_ANNOUNCE.equals(intent.getAction())) {
            String localPubkey = intent.getStringExtra(EXTRA_LOCAL_PUBKEY);
            BunkerConnections.Connection connection = localPubkey == null
                ? null : BunkerConnections.byLocalPubkey(this, localPubkey);
            if (connection != null) {
                afterConnecting = () -> announce(connection);
            }
        }

        if (intent != null && ACTION_DELIVER.equals(intent.getAction())) {
            String siteId = intent.getStringExtra(EXTRA_SITE_ID);
            String kind = intent.getStringExtra(EXTRA_KIND);
            String data = intent.getStringExtra(EXTRA_DATA);
            if (siteId != null && kind != null && data != null) {
                deliver(siteId, kind, data);
            }
        }

        if (!subscribed) {
            // Nothing to connect to, so nothing the deferred work could be
            // waiting on. Run it anyway rather than drop it: it will fail to
            // find a socket and say so, which is the honest outcome.
            if (afterConnecting != null) scheduler.execute(afterConnecting);

            // A site with no subscriptions can still have a notification the
            // user just pressed, so the wake page it is being delivered to
            // has to outlive this. It stops itself when it goes idle.
            if (wakers.isEmpty()) {
                Log.i(TAG, "Nothing to listen for; stopping");
                stopSelf();
                return START_NOT_STICKY;
            }
            return START_NOT_STICKY;
        }

        Log.i(TAG, "Listening on " + plan.byRelay.size() + " relays for "
            + plan.siteIds.size() + " sites and " + plan.connectionCount + " connections");
        pool.apply(plan);
        if (afterConnecting != null) scheduler.execute(afterConnecting);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        unwatchNetwork();
        if (pool != null) pool.close();
        scheduler.shutdownNow();
        for (NappWakeWebView waker : wakers.values()) waker.destroy();
        wakers.clear();
        if (client != null) {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /** Called on an OkHttp thread for every EVENT a relay sends under one of our REQs. */
    private void onEvent(@NonNull String relayUrl, @NonNull NappPlan.Subscription subscription, @NonNull JSONObject event) {
        String eventId = event.optString("id", "");
        long createdAt = event.optLong("created_at", 0);
        if (eventId.isEmpty()) return;

        // A request from a remote client goes nowhere near a site's worker.
        // It is an instruction rather than a notification, and it is answered
        // on this thread — see NappBunker.
        if (subscription.isBunker()) {
            String key = subscription.bunkerPubkey + ":" + eventId;
            synchronized (seenEvents) {
                if (seenEvents.containsKey(key)) return;
                seenEvents.put(key, Boolean.TRUE);
            }
            NappBunker.receive(this, this::publish, subscription.bunkerPubkey, event);
            return;
        }

        String key = NsiteSites.key(subscription.siteId) + ":" + eventId;
        synchronized (seenEvents) {
            if (seenEvents.containsKey(key)) return;
            seenEvents.put(key, Boolean.TRUE);
        }

        // Advance the floor so a reconnection asks for what follows. The
        // relay may still send this one again, and the dedupe above is what
        // catches that.
        subscription.since.accumulateAndGet(createdAt, Math::max);
        NappSubscriptions.markSeen(this, subscription.siteId, subscription.index, createdAt);

        String payload;
        try {
            JSONObject message = new JSONObject();
            message.put("event", event);
            message.put("relay", relayUrl);
            message.put("subscription", subscription.index);
            payload = message.toString();
        } catch (JSONException e) {
            return;
        }

        main.post(() -> deliver(subscription.siteId, "push", payload));
    }

    // -----------------------------------------------------------------------
    // Remote signing
    // -----------------------------------------------------------------------

    /**
     * Send an answer back out on the connection's own relays.
     *
     * <p>Every one of them, not the first that works. A client listens on the
     * relays it named and there is no way to know which of them it is actually
     * reading; an answer delivered to one relay out of three is an answer the
     * client may never see, and the event is ephemeral so there is no second
     * chance at it.
     */
    private void publish(@NonNull String eventJson, @NonNull List<String> relays) {
        if (pool == null) return;

        // A socket that was opened a moment ago is not open yet. The plan is
        // applied and then this runs, and in between there is a TCP handshake
        // and a TLS one — so an answer sent at once goes nowhere, and kind
        // 24133 is ephemeral, so nowhere is permanent.
        for (int attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
            if (pool.publish(eventJson, relays) > 0) return;
            try {
                Thread.sleep(PUBLISH_RETRY_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }

        Log.w(TAG, "Nowhere open to send an answer; the client will time out");
    }

    /**
     * Tell a client that invited us that it has been accepted.
     *
     * <p>Only for {@code nostrconnect://}, where the client is listening for
     * an answer to a question it never asked. The ordering this relies on is
     * the whole reason it is here rather than in the activity that made the
     * connection: the REQ for this connection has to be live on the relay
     * before this goes out, or the client's first real request arrives with
     * nobody subscribed and is dropped for good.
     */
    private void announce(@NonNull BunkerConnections.Connection connection) {
        String event = NappBunker.connectResponse(connection);
        if (event == null) return;

        publish(event, connection.relays);
        Log.i(TAG, "Told a remote app it is connected");
    }

    /**
     * A relay wants NIP-42, and may be told only what a connection can say.
     *
     * <p>Signed with the connection's own key — never the user's. See the note
     * on {@link NappRelay}: a background service signing as the user with
     * nothing on screen is the thing that must not happen, and a connection
     * authenticating as itself is not that.
     */
    @Nullable
    private String onAuthChallenge(
        @NonNull String relayUrl,
        @NonNull String challenge,
        @NonNull List<NappPlan.Subscription> carrying
    ) {
        for (NappPlan.Subscription subscription : carrying) {
            if (!subscription.isBunker()) continue;

            BunkerConnections.Connection connection =
                BunkerConnections.byLocalPubkey(this, subscription.bunkerPubkey);
            if (connection == null) continue;

            byte[] key = connection.key();
            if (key == null) continue;

            try {
                JSONArray tags = new JSONArray()
                    .put(new JSONArray().put("relay").put(relayUrl))
                    .put(new JSONArray().put("challenge").put(challenge));
                return NostrCrypto.finalizeEvent(
                    22242, "", tags, System.currentTimeMillis() / 1000, key).toString();
            } catch (Exception e) {
                Log.i(TAG, "Could not answer a relay's challenge");
                return null;
            }
        }
        return null;
    }

    /** Answer a request somebody has just decided about, from the sheet. */
    static void resolveBunker(
        @NonNull Context context,
        @NonNull NappBunker.Pending request,
        boolean allowed,
        boolean remember
    ) {
        Context app = context.getApplicationContext();
        // The reply has to go out on a socket, and the socket belongs to the
        // service — which may not be running if the user came at this from a
        // notification after a reboot. Starting it is also what reconnects.
        Intent intent = new Intent(app, NappPushService.class)
            .setAction(ACTION_ANSWER)
            .putExtra(EXTRA_REQUEST_ID, request.requestId)
            .putExtra(EXTRA_ALLOWED, allowed)
            .putExtra(EXTRA_REMEMBER, remember);

        NappBunker.stage(request, allowed, remember);
        try {
            ContextCompat.startForegroundService(app, intent);
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not start the service to answer a remote request", e);
        }
    }

    /**
     * A connection has just been made; get it on the air.
     *
     * <p>Starting the service is what opens the socket and puts the REQ on it,
     * and for a client that invited us it is also what sends the acceptance —
     * in that order, which is why it is one call.
     */
    static void announceConnection(@NonNull Context context, @NonNull String localPubkey) {
        Context app = context.getApplicationContext();
        Intent intent = new Intent(app, NappPushService.class)
            .setAction(ACTION_ANNOUNCE)
            .putExtra(EXTRA_LOCAL_PUBKEY, localPubkey);

        try {
            ContextCompat.startForegroundService(app, intent);
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not start the service for a new connection", e);
        }
    }

    private void deliver(String siteId, String kind, String payload) {
        if (!running) return;

        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(() -> deliver(siteId, kind, payload));
            return;
        }

        NappWakeWebView waker = wakers.get(siteId);
        if (waker == null) {
            waker = new NappWakeWebView(this, siteId, this::onWakerIdle);
            wakers.put(siteId, waker);
        }
        waker.deliver(kind, payload, () -> {});
    }

    private void onWakerIdle(NappWakeWebView waker) {
        if (wakers.remove(waker.siteId()) == waker) waker.destroy();

        // Started only to hand a worker a tap, with no relay to keep open
        // afterwards. Nothing else will come to stop it.
        if (!subscribed && wakers.isEmpty()) stopSelf();
    }

    // -----------------------------------------------------------------------
    // Network
    // -----------------------------------------------------------------------

    /**
     * Reconnect the moment the network comes back, rather than at the end of
     * whatever backoff the last failure left the relays in.
     */
    private void watchNetwork() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager == null) return;

        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(@NonNull Network network) {
                if (pool != null) pool.reconnectAll();
            }
        };
        try {
            manager.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException e) {
            networkCallback = null;
        }
    }

    private void unwatchNetwork() {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        if (manager != null && networkCallback != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (RuntimeException ignored) {
                // Already gone.
            }
        }
        networkCallback = null;
    }
}
