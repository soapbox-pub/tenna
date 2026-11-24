package pub.soapbox.tenna;

import android.app.Notification;
import android.content.Context;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Work a site runs with its window closed, while a notification says so.
 *
 * <p>Android's answer to "keep doing this after the user leaves" is a
 * foreground service with a notification that cannot be missed. A site gets
 * the same thing in the web's own terms, as Din gives its apps (Din's
 * docs/din/background.md, "Running a task"): a notification shown with
 * {@code ongoing: true}.
 *
 * <pre>
 * registration.showNotification('Syncing notes', { tag: 'sync', ongoing: true, progress: 0.4 });
 * </pre>
 *
 * <p>While one shows, {@link NappTaskService} runs in the foreground with it
 * as its notification and keeps the site's service worker running, past
 * Chromium's idle timeout and with the process kept alive. The same tag
 * without {@code ongoing} ends it and pops up as news, in the site's
 * conversation; closing it ends it quietly. It has a Stop button, which closes
 * it, raises {@code notificationclose} in the worker and lets the worker go ten
 * seconds later.
 *
 * <h2>Who may</h2>
 *
 * <p>A site the user let notify, and only within a minute of the user acting
 * in one of its windows or on one of its notifications — a task is something
 * the user started — or to update one of its own that is running. Anything
 * else asking for {@code ongoing} is shown as an ordinary notification, and
 * its {@code ongoing} reads false, which is how a site tells.
 *
 * <p>Nothing is kept on disk. A task is a worker doing something, and the
 * worker does not survive the process; a notification saying it is still
 * running after a restart would be a lie. Its record in the store, which is
 * what {@code getNotifications} reads, is swept up the next time anything
 * looks — see {@link #sweep}.
 */
final class NappTasks {

    private static final String TAG = "NappTasks";

    /** How long after the user acts in a site that it may start a task. */
    private static final long START_WINDOW_MS = 60_000;

    /**
     * Where task notification ids start. Clear of the push service's, which
     * is {@link NappNotifications#SERVICE_NOTIFICATION_ID}, and of anything
     * the system hands out. Ids rather than tags because a foreground
     * service's notification is posted by id alone.
     */
    private static final int FIRST_ID = 0x4e41_0000;

    private static final AtomicInteger NEXT_ID = new AtomicInteger(FIRST_ID);

    private NappTasks() {}

    /** One running task. */
    static final class Task {
        @NonNull final String siteId;
        /** The notification's key in {@link NappNotificationStore}. */
        @NonNull final String key;
        final int id;
        /**
         * The worker that is running it, once known: the shim says who it is
         * on every port it adopts and every time it is kept alive. A
         * different one is a worker that stopped and started again, and took
         * the work with it.
         */
        @Nullable String instance;
        /** The notification as last drawn, for the service to run under. */
        @Nullable Notification notification;

        Task(@NonNull String siteId, @NonNull String key, int id, @Nullable String instance) {
            this.siteId = siteId;
            this.key = key;
            this.id = id;
            this.instance = instance;
        }
    }

    /** Every running task by key, oldest first. */
    private static final Map<String, Task> running = new LinkedHashMap<>();

    /** When the user last acted in each site's window. */
    private static final Map<String, Long> touched = new HashMap<>();

    // ── Who may ──────────────────────────────────────────────────────────────

    /** The user pressed something in one of the site's windows. */
    static synchronized void touched(@NonNull String siteId) {
        touched.put(siteId, System.currentTimeMillis());
    }

    /** Whether the site may start a task now. */
    static synchronized boolean mayStart(@NonNull String siteId) {
        Long at = touched.get(siteId);
        boolean recent = at != null && System.currentTimeMillis() - at < START_WINDOW_MS;
        return recent || NappNotifications.recentlyInteracted(siteId);
    }

    // ── What is running ──────────────────────────────────────────────────────

    static synchronized boolean isRunning(@NonNull String key) {
        return running.containsKey(key);
    }

    static synchronized boolean any() {
        return !running.isEmpty();
    }

    @NonNull
    static synchronized List<Task> all() {
        return new ArrayList<>(running.values());
    }

    @NonNull
    static synchronized Set<String> sites() {
        Set<String> sites = new LinkedHashSet<>();
        for (Task task : running.values()) sites.add(task.siteId);
        return sites;
    }

    /** Whether a stored notification was shown as a task. */
    static boolean isTaskEntry(@NonNull NappNotificationStore.Entry entry) {
        try {
            return new JSONObject(entry.options).optBoolean("ongoing", false);
        } catch (JSONException e) {
            return false;
        }
    }

    /**
     * Drop a site's records of tasks that are no longer running: the process
     * that ran them is gone, or so is the worker. Called before anything reads
     * the store, so a stale one is neither listed nor drawn as news.
     */
    static void sweep(@NonNull Context context, @NonNull String siteId) {
        for (NappNotificationStore.Entry entry : NappNotificationStore.list(context, siteId)) {
            if (isTaskEntry(entry) && !isRunning(entry.key)) {
                NappNotificationStore.remove(context, siteId, entry.key);
            }
        }
    }

    // ── Starting, updating, ending ───────────────────────────────────────────

    /**
     * Show a task's notification, starting the task if it is not running.
     *
     * <p>Returns false if it could not be run as one — the system would not
     * start the service from where the app is — so the caller shows it as an
     * ordinary notification instead.
     */
    static boolean show(
        @NonNull Context context,
        @NonNull String siteId,
        @NonNull NappNotificationStore.Entry entry,
        @Nullable String instance
    ) {
        Context app = context.getApplicationContext();
        Task task;
        boolean started = false;
        synchronized (NappTasks.class) {
            task = running.get(entry.key);
            if (task == null) {
                task = new Task(siteId, entry.key, NEXT_ID.getAndIncrement(), instance);
                running.put(entry.key, task);
                started = true;
            } else if (task.instance == null) {
                task.instance = instance;
            }
        }

        Notification notification = NappNotifications.taskNotification(app, siteId, entry);
        if (notification == null) {
            if (started) remove(entry.key);
            return false;
        }
        task.notification = notification;

        if (!NappTaskService.refresh(app, null)) {
            // Not allowed to run in the foreground from here. Nothing was
            // drawn yet, so the task simply never was.
            remove(entry.key);
            return false;
        }

        try {
            NotificationManagerCompat.from(app).notify(task.id, notification);
        } catch (SecurityException e) {
            Log.i(TAG, "Could not post a task for " + siteId);
        }
        if (started) Log.i(TAG, "Started a task for " + siteId);
        return true;
    }

    /**
     * End a task quietly: the site closed it, or showed its tag without
     * {@code ongoing}. Its record is the caller's to keep or drop.
     */
    static void end(@NonNull Context context, @NonNull String key) {
        Task task = remove(key);
        if (task == null) return;
        Log.i(TAG, "Ended a task for " + task.siteId);
        NappTaskService.refresh(context.getApplicationContext(), task.id);
    }

    /**
     * The user stopped it: its Stop, or a swipe where Android allows one.
     *
     * <p>The worker hears {@code notificationclose}, as it would for any
     * notification the user dismissed, and the service keeps it running ten
     * seconds more to hear it in.
     */
    static void stop(@NonNull Context context, @NonNull String siteId, @NonNull String key) {
        Context app = context.getApplicationContext();
        Task task = remove(key);
        if (task == null) return;
        Log.i(TAG, "Stopped a task for " + siteId);

        // Before the record goes: the event carries the notification, read
        // out of it.
        NappPushService.dispatchNotificationEvent(app, siteId, "notificationclose", key, null, null);
        NappNotificationStore.remove(app, siteId, key);
        NappTaskService.refresh(app, task.id);
    }

    /** End everything a site has running, saying nothing to it. */
    static void forget(@NonNull Context context, @NonNull String siteId) {
        Context app = context.getApplicationContext();
        for (Task task : all()) {
            if (!task.siteId.equals(siteId)) continue;
            remove(task.key);
            NappNotificationStore.remove(app, siteId, task.key);
            NappTaskService.refresh(app, task.id);
        }
    }

    /**
     * The worker running a site's tasks said who it is.
     *
     * <p>One other than the worker that started a task stopped and started
     * again in between — it crashed, or an update replaced it — and what the
     * old one was doing is gone with it, so its notifications go too, as they
     * do in Din.
     */
    static void workerSeen(@NonNull Context context, @NonNull String siteId, @Nullable String instance) {
        if (instance == null || instance.isEmpty()) return;
        Context app = context.getApplicationContext();
        List<Task> lost = new ArrayList<>();
        synchronized (NappTasks.class) {
            for (Task task : running.values()) {
                if (!task.siteId.equals(siteId)) continue;
                if (task.instance == null) task.instance = instance;
                else if (!task.instance.equals(instance)) lost.add(task);
            }
        }
        for (Task task : lost) {
            Log.i(TAG, "The worker running a task for " + siteId + " stopped; ending it");
            remove(task.key);
            NappNotificationStore.remove(app, siteId, task.key);
            NappTaskService.refresh(app, task.id);
        }
    }

    @Nullable
    private static synchronized Task remove(@NonNull String key) {
        return running.remove(key);
    }
}
