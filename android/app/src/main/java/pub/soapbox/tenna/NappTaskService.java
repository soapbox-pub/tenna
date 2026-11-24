package pub.soapbox.tenna;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.MainThread;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What keeps a site's running tasks running. See {@link NappTasks}.
 *
 * <p>Two things have to stay alive for a task to go on with its window
 * closed. The process, which Android takes away from an app with nothing on
 * screen: this service is in the foreground for as long as any task runs, with
 * the oldest task's own notification as its notification, so what the user
 * sees running is what is running. And the site's service worker, which
 * Chromium stops thirty seconds after its last event settles, however much the
 * site still has in flight.
 *
 * <p>Only an event holds a worker. A message on the port Tenna hands it is not
 * one, and nothing native can raise one. So for each site with a task running
 * this keeps a hidden page at the site's origin — the same wake page a push is
 * delivered through — and has it post the worker a message every
 * {@link #KEEP_ALIVE_MS}, which the shim holds open for a little longer than
 * that. The worker is never idle, and no one event comes near Chromium's
 * five-minute ceiling. When a site's last task ends, its page stays
 * {@link #GRACE_MS} more, so a worker told to stop has time to stop.
 *
 * <p>A special-use type, as the push service is, because what it does is
 * whatever the site's task is: a sync, an upload, an assistant answering. None
 * of the narrower types describe that, and data sync is capped at a few hours
 * a day on Android 15 and later.
 */
public class NappTaskService extends Service {

    private static final String TAG = "NappTaskService";

    /** How often the worker is sent something to keep it awake. */
    static final long KEEP_ALIVE_MS = 20_000;

    /** How long a worker is kept once its last task has gone. */
    private static final long GRACE_MS = 10_000;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Nullable private static NappTaskService instance;

    /** Set from the moment the service is asked to start until it has. */
    private static volatile boolean starting;

    /** One keep-alive page per site with something running. Main thread only. */
    private final Map<String, NappWakeWebView> keepers = new HashMap<>();

    /** Pages on their way out, and when they go. Main thread only. */
    private final Map<String, Runnable> releasing = new HashMap<>();

    /** The task whose notification the service is running under, or -1. */
    private int foregroundId = -1;

    private final Runnable stopIfIdle = this::stopIfIdle;

    /**
     * Make the service match what is running, and take down a notification
     * that has ended.
     *
     * <p>Starts it if anything is running and it is not. Returns false if it
     * could not be started from where the app is — Android refuses a
     * foreground service to an app in the background — which leaves the
     * caller to show its notification some other way.
     *
     * @param ended the id of a task that has just ended, whose notification
     *              is taken down once the service is no longer running under
     *              it — Android ignores a cancel for the notification a
     *              foreground service is using.
     */
    static boolean refresh(@NonNull Context context, @Nullable Integer ended) {
        Context app = context.getApplicationContext();

        if (instance == null && !starting && NappTasks.any()) {
            starting = true;
            try {
                ContextCompat.startForegroundService(app, new Intent(app, NappTaskService.class));
            } catch (RuntimeException e) {
                starting = false;
                Log.i(TAG, "Not allowed to run a task from here", e);
                if (ended != null) NotificationManagerCompat.from(app).cancel(ended);
                return false;
            }
        }

        MAIN.post(() -> {
            NappTaskService service = instance;
            if (service != null) service.apply();
            if (ended != null) NotificationManagerCompat.from(app).cancel(ended);
        });
        return true;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        starting = false;
        apply();
        // Not sticky: a restarted service would have nothing to run. The
        // tasks lived in the process the system just killed.
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        instance = null;
        starting = false;
        MAIN.removeCallbacks(stopIfIdle);
        for (Runnable pending : releasing.values()) MAIN.removeCallbacks(pending);
        releasing.clear();
        for (NappWakeWebView keeper : keepers.values()) keeper.destroy();
        keepers.clear();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // -----------------------------------------------------------------------

    @MainThread
    private void apply() {
        List<NappTasks.Task> tasks = NappTasks.all();

        // Into the foreground first, under a task that is still running: one
        // the system was told to start and that does not call startForeground
        // within a few seconds is killed, and takes the app with it.
        NappTasks.Task primary = null;
        for (NappTasks.Task task : tasks) {
            if (task.notification == null) continue;
            if (primary == null || task.id == foregroundId) primary = task;
            if (task.id == foregroundId) break;
        }

        if (primary != null) {
            goForeground(primary.id, primary.notification);
        } else if (foregroundId != -1) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            foregroundId = -1;
        } else if (tasks.isEmpty() && keepers.isEmpty()) {
            // Started for a task that ended before the service came up. It
            // still owes the system a foreground notification, briefly.
            goForeground(NappNotifications.SERVICE_NOTIFICATION_ID + 1,
                NappNotifications.taskPlaceholder(this));
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        }

        Set<String> sites = NappTasks.sites();

        for (String siteId : sites) {
            Runnable going = releasing.remove(siteId);
            if (going != null) MAIN.removeCallbacks(going);
            if (!keepers.containsKey(siteId)) keep(siteId);
        }

        for (String siteId : keepers.keySet()) {
            if (sites.contains(siteId) || releasing.containsKey(siteId)) continue;
            Runnable release = () -> release(siteId);
            releasing.put(siteId, release);
            MAIN.postDelayed(release, GRACE_MS);
        }

        MAIN.removeCallbacks(stopIfIdle);
        if (tasks.isEmpty()) MAIN.postDelayed(stopIfIdle, GRACE_MS + 1_000);
    }

    @MainThread
    private void goForeground(int id, @NonNull Notification notification) {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            : 0;
        try {
            ServiceCompat.startForeground(this, id, notification, type);
            foregroundId = id;
        } catch (RuntimeException e) {
            Log.w(TAG, "Could not run in the foreground", e);
        }
    }

    /** Start keeping a site's worker awake. */
    @MainThread
    private void keep(@NonNull String siteId) {
        NappWakeWebView keeper = new NappWakeWebView(this, siteId, view -> {
            // The page never came up. Nothing will keep this worker awake, so
            // the tasks it holds will end with it; say nothing until it does.
            if (keepers.get(siteId) == view) keepers.remove(siteId);
            view.destroy();
        });
        keepers.put(siteId, keeper);
        keeper.hold(KEEP_ALIVE_MS, instance -> NappTasks.workerSeen(this, siteId, instance));
    }

    /** Let a site's worker go. */
    @MainThread
    private void release(@NonNull String siteId) {
        releasing.remove(siteId);
        if (NappTasks.sites().contains(siteId)) return;
        NappWakeWebView keeper = keepers.remove(siteId);
        if (keeper != null) keeper.destroy();
        stopIfIdle();
    }

    @MainThread
    private void stopIfIdle() {
        if (NappTasks.any() || !releasing.isEmpty()) return;
        for (NappWakeWebView keeper : keepers.values()) keeper.destroy();
        keepers.clear();
        stopSelf();
    }
}
