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

        if (plan.byRelay.isEmpty()) {
            Log.i(TAG, "Nothing to listen for; stopping");
            stopSelf();
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

        main.post(() -> deliver(subscription.siteId, payload));
    }

    private void deliver(String siteId, String payload) {
        if (!running) return;

        NappWakeWebView waker = wakers.get(siteId);
        if (waker == null) {
            waker = new NappWakeWebView(this, siteId, this::onWakerIdle);
            wakers.put(siteId, waker);
        }
        waker.deliver(payload, () -> {});
    }

    private void onWakerIdle(NappWakeWebView waker) {
        if (wakers.remove(waker.siteId()) == waker) waker.destroy();
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
