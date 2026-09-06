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

    private static final String EXTRA_SITE_ID = "pub.soapbox.tenna.napp.SITE_ID";
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
        boolean wanted = !NappSubscriptions.all(app).isEmpty();

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
        pool = new NappRelayPool(client, scheduler, this::onEvent);

        watchNetwork();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        List<NappSubscriptions.Record> records = NappSubscriptions.all(this);
        NappPlan plan = NappPlan.build(records, sinces);

        // Into the foreground first, whatever else happens: a service that
        // was started as foreground and hasn't called startForeground within
        // a few seconds is killed, and takes the app with it.
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            : 0;
        ServiceCompat.startForeground(
            this,
            NappNotifications.SERVICE_NOTIFICATION_ID,
            NappNotifications.serviceNotification(this, plan.siteIds.size()),
            type
        );

        subscribed = !plan.byRelay.isEmpty();

        if (intent != null && ACTION_DELIVER.equals(intent.getAction())) {
            String siteId = intent.getStringExtra(EXTRA_SITE_ID);
            String kind = intent.getStringExtra(EXTRA_KIND);
            String data = intent.getStringExtra(EXTRA_DATA);
            if (siteId != null && kind != null && data != null) {
                deliver(siteId, kind, data);
            }
        }

        if (!subscribed) {
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

        Log.i(TAG, "Listening on " + plan.byRelay.size() + " relays for " + plan.siteIds.size() + " sites");
        pool.apply(plan);
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
