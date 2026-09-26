package pub.soapbox.tenna;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * One scheduled run of a site's periodic sync.
 *
 * <p>Wakes the site's service worker once per tag that is due and raises a
 * {@code periodicsync} in it, by the same road a push takes: a
 * {@link NappWakeWebView} at the site's origin, which hands the worker the event
 * and a port to answer over. See {@link NappPeriodicSync} for the schedule.
 *
 * <p>The wake page is built here rather than borrowed from
 * {@link NappPushService}. Starting that service from a background job is a
 * foreground-service start from the background, which Android 12 refuses; and a
 * WebView needs nothing from a service beyond a main thread, which every process
 * has. So a run stands up its own page, waits for the worker, and tears it down.
 *
 * <p>WorkManager gives a job ten minutes, and Chromium gives an event five
 * before it stops the worker — so a site gets exactly the {@code waitUntil} it
 * would get in a browser, and one with several tags due gets its five minutes
 * per tag only as far as the ten go round. The last run is recorded before
 * anything is delivered, so a worker that hangs until the job is killed is not
 * woken again the moment the job is retried.
 */
public class NappPeriodicSyncWorker extends Worker {

    private static final String TAG = "NappPeriodicSync";

    /** Short of WorkManager's ten minutes, so the page is torn down by us and not by the job being killed. */
    private static final long BUDGET_MS = TimeUnit.MINUTES.toMillis(9);

    private final Handler main = new Handler(Looper.getMainLooper());

    /** Main thread only. */
    @Nullable private NappWakeWebView waker;

    public NappPeriodicSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String siteId = getInputData().getString(NappPeriodicSync.INPUT_SITE_ID);
        if (siteId == null) return Result.success();

        // A site nothing is left of has no worker to serve. Its job goes too.
        if (NsiteSites.load(context, siteId) == null) {
            NappPeriodicSync.forget(context, siteId);
            return Result.success();
        }

        long now = System.currentTimeMillis();
        List<String> due = NappPeriodicSync.due(NappPeriodicSync.get(context, siteId), now);
        if (due.isEmpty()) return Result.success();

        NappPeriodicSync.ran(context, siteId, due, now);
        Log.i(TAG, "Waking " + siteId + " for " + due.size() + " tag(s)");

        CountDownLatch done = new CountDownLatch(due.size());

        main.post(() -> {
            if (isStopped()) {
                while (done.getCount() > 0) done.countDown();
                return;
            }

            // Idle only arrives when the page never came up — every delivery
            // below is queued before it could — and destroying it answers
            // whatever it was holding.
            NappWakeWebView view = new NappWakeWebView(context, siteId, NappWakeWebView::destroy);
            waker = view;
            for (String tag : due) {
                view.deliver("periodicsync", tag, done::countDown);
            }
        });

        try {
            if (!done.await(BUDGET_MS, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "The worker for " + siteId + " was still going when the run ended");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        tearDown();
        return Result.success();
    }

    @Override
    public void onStopped() {
        tearDown();
    }

    private void tearDown() {
        main.post(() -> {
            NappWakeWebView view = waker;
            waker = null;
            if (view != null) view.destroy();
        });
    }
}
